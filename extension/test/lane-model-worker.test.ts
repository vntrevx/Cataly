import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type * as NativeConfig from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/config/settings.d.ts";
import type * as NativeInit from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/modes/runtime-init.d.ts";
import type * as NativeSdk from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/sdk.d.ts";
import type { AgentSession } from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/session/agent-session.d.ts";
import type * as NativeSessions from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/session/session-manager.d.ts";
import type * as NativeAgents from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/task/agents.d.ts";
import type * as NativeExecutor from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/task/executor.d.ts";
import type * as NativeWorkers from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/thread/subagent-worker.d.ts";
import {
  type ModelSnapshot,
  type PaneState,
  paneStatePath,
  readPaneState,
  writePaneState,
} from "../../skills/dori-mode/scripts/src/lane-state.ts";
import { createModelProfileFile } from "../../skills/dori-mode/scripts/src/model-profile.ts";
import { assertNativeHost } from "../../test/fixtures/omp-native-host/host.ts";
import {
  loopbackProvider,
  loopbackRegistry,
  NATIVE_FIXTURE_OVERRIDES,
} from "../../test/fixtures/omp-native-host/required-source.ts";
import { until, useConfig } from "./fake-pi.ts";
import { WORKER_PROBE_ENV } from "./lane-model-worker-probe.ts";

// The real native host, loaded from the exact fixture the other native regressions use.
const host = resolve(import.meta.dir, "../../test/fixtures/omp-native-host");
const nativeModule = (path: string): string => Bun.resolveSync(`@oh-my-pi/pi-coding-agent/${path}`, host);
const { Settings }: typeof NativeConfig = await import(nativeModule("config/settings"));
const { createAgentSession, MAIN_AGENT_ID }: typeof NativeSdk = await import(nativeModule("sdk"));
const { SessionManager }: typeof NativeSessions = await import(nativeModule("session/session-manager"));
const { initializeExtensions }: typeof NativeInit = await import(nativeModule("modes/runtime-init"));
const { runSubprocess }: typeof NativeExecutor = await import(nativeModule("task/executor"));
const { getBundledAgent }: typeof NativeAgents = await import(nativeModule("task/agents"));
const { SubagentWorkerPool, setSubagentWorkerPoolForTests }: typeof NativeWorkers = await import(
  nativeModule("thread/subagent-worker")
);

const DORI = join(import.meta.dir, "../index.ts");
const PROBE = join(import.meta.dir, "lane-model-worker-probe.ts");
const PANE = "native-worker:p1";
const ROOT_MODEL = "required-source-local";
const CHILD_MODEL = "required-source-child";
const KEYS = [
  "HOME",
  "DORI_CONFIG",
  "DORI_STATE_DIR",
  "DORI_OMP_ULW_PATH",
  "HERDR_PANE_ID",
  "HC_TERMINAL_ID",
  WORKER_PROBE_ENV,
];
const previous = KEYS.map((key) => process.env[key]);
let childRequested: (() => void) | undefined;
const loopback = loopbackProvider((model) => {
  if (model === CHILD_MODEL) childRequested?.();
});
let pool: NativeWorkers.SubagentWorkerPool | undefined;
let stateDir = "";
let probes = "";

beforeAll(async () => {
  await assertNativeHost();
  stateDir = useConfig("");
  probes = join(dirname(stateDir), "probes");
  mkdirSync(probes, { recursive: true });
  process.env.HOME = dirname(stateDir);
  process.env.HERDR_PANE_ID = PANE;
  process.env[WORKER_PROBE_ENV] = probes;
  delete process.env.DORI_OMP_ULW_PATH;
  delete process.env.HC_TERMINAL_ID;
  // Test hook only: every subagent run goes to a worker thread, which starts with this environment.
  pool = new SubagentWorkerPool({ maxWorkers: () => 1, hostsOnMain: false });
  setSubagentWorkerPoolForTests(pool);
});

afterAll(() => {
  setSubagentWorkerPoolForTests(undefined);
  pool?.dispose();
  loopback.server.stop(true);
  KEYS.forEach((key, index) => {
    if (previous[index] === undefined) delete process.env[key];
    else process.env[key] = previous[index];
  });
  if (stateDir) rmSync(dirname(stateDir), { recursive: true, force: true });
});

/** The live root lane a disturbance acts on, with the pane state it published at startup. */
interface WorkerRoot {
  readonly session: AgentSession;
  readonly settings: NativeConfig.Settings;
  readonly globalFile: string;
  readonly published: PaneState;
  readonly childModel: NonNullable<AgentSession["model"]>;
}

/**
 * A loopback reasoning model whose native provisional `auto` level is its lowest effort, so an `ultrathink` turn can
 * move auto's effective level while the selection stays `auto`.
 */
const reasoningModel = (id: string) => {
  const model = loopback.model(id, true);
  const low = model.thinking?.efforts[0];
  if (!model.thinking || !low) throw new Error("native reasoning fixture has no effort ladder");
  const thinking = { ...model.thinking, defaultLevel: low };
  return { ...model, thinking };
};

/** A reasoning root lane selected at `selected`, and a child override carrying its own explicit thinking suffix. */
interface WorkerThinking {
  readonly selected: "low" | "auto";
  readonly childEffort?: "medium";
}

/**
 * One root lane on the real native host (pinned on its own Dori overlay, or legacy without one), an optional
 * disturbance, then one subagent of it placed on a worker thread. Returns where and on which model the subagent ran,
 * how many requests it sent to the loopback provider before it was stopped, and the root's selection afterwards.
 */
const workerRun = async (
  pinned: boolean,
  disturb?: (root: WorkerRoot) => unknown,
  thinking?: WorkerThinking,
  beforeProvider = false,
) => {
  const cwd = join(dirname(stateDir), randomUUID());
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  const globalFile = join(agentDir, "config.yml");
  const selected = `openai/${ROOT_MODEL}`;
  const defaultThinkingLevel = thinking?.selected ?? "low";
  writeFileSync(globalFile, JSON.stringify({ modelRoles: { default: selected }, defaultThinkingLevel }));
  const settings = await Settings.loadIsolated({
    cwd,
    agentDir,
    configFiles: pinned ? [createModelProfileFile(stateDir)] : [],
    overrides: { ...NATIVE_FIXTURE_OVERRIDES },
  });
  const rootModel = thinking ? reasoningModel(ROOT_MODEL) : loopback.model(ROOT_MODEL);
  const childModel = thinking?.childEffort ? reasoningModel(CHILD_MODEL) : loopback.model(CHILD_MODEL);
  let session: AgentSession | undefined;
  let holdFile: string | undefined;
  let controller: AbortController | undefined;
  try {
    const { auth, registry } = await loopbackRegistry(cwd, settings, [rootModel, childModel]);
    const manager = SessionManager.create(cwd, join(cwd, "sessions"));
    manager.appendCustomEntry("omp-dori:role", "lane");
    if (pinned) {
      const snapshot: ModelSnapshot = {
        version: 1,
        id: randomUUID(),
        model: { provider: "openai", id: ROOT_MODEL },
        modelRoles: { default: selected },
        defaultThinkingLevel,
        // A non-reasoning root has no native selection; a reasoning one starts on its global selection, and both
        // `low` and auto's provisional level resolve to the ladder's lowest effort.
        configuredThinkingLevel: thinking ? thinking.selected : null,
        thinkingLevel: thinking ? "low" : null,
        capturedAt: new Date().toISOString(),
        provenance: {
          kind: "launch",
          requested: selected,
          modelRoles: { default: "global" },
          defaultThinkingLevel: "global",
        },
      };
      manager.appendCustomEntry("omp-dori:model-snapshot", snapshot);
    }
    ({ session } = await createAgentSession({
      cwd,
      agentDir,
      sessionManager: manager,
      authStorage: auth,
      modelRegistry: registry,
      model: rootModel,
      settings,
      bindProcessState: false,
      cacheWarming: false,
      disableModelFallback: true,
      toolNames: [],
      disableExtensionDiscovery: true,
      // By path, not inline: a worker thread imports these modules itself.
      additionalExtensionPaths: [PROBE, DORI],
      skills: [],
      promptTemplates: [],
      slashCommands: [],
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      skipPythonPreflight: true,
      getApiKey: async (selected) => {
        expect(selected.baseUrl).toBe(rootModel.baseUrl);
        return "local-fixture-only";
      },
      assertDispatchModel: (selected) => expect(selected.baseUrl).toBe(rootModel.baseUrl),
    }));
    const errors: string[] = [];
    await initializeExtensions(session, {
      mode: "json",
      reportRuntimeError: (error) => errors.push(`${error.event}: ${error.error}`),
      reportSendError: (_action, error) => {
        throw error;
      },
    });
    expect(errors).toEqual([]);
    const published = readPaneState(stateDir, PANE);
    if (!published) throw new Error("the native root lane published no pane state");
    expect(published).toMatchObject({
      role: "lane",
      pid: process.pid,
      sessionId: session.sessionManager.getSessionId(),
    });
    expect(published.modelSnapshotError).toBeUndefined();
    expect(published.modelProfileFile).toBe(pinned ? settings.getConfigFiles().at(-1) : undefined);
    if (thinking) {
      expect(session.configuredThinkingLevel()?.toString()).toBe(thinking.selected);
      expect(session.thinkingLevel?.toString()).toBe("low");
    }
    if (!beforeProvider) await disturb?.({ session, settings, globalFile, published, childModel });

    const agent = getBundledAgent("task");
    if (!agent) throw new Error("native bundled task agent missing");
    const id = `WorkerChild-${randomUUID()}`;
    const probeFile = join(probes, `${encodeURIComponent(id)}.json`);
    holdFile = join(probes, `${encodeURIComponent(id)}.hold`);
    if (beforeProvider) writeFileSync(holdFile, "");
    const before = loopback.requested.length;
    controller = new AbortController();
    const requested = Promise.withResolvers<void>();
    childRequested = requested.resolve;
    const run = runSubprocess({
      cwd,
      agent: { ...agent, tools: ["read"] },
      task: "Return OK.",
      assignment: "Return OK.",
      description: "worker-thread model guard",
      index: 0,
      id,
      taskDepth: 0,
      modelOverride: `openai/${CHILD_MODEL}${thinking?.childEffort ? `:${thinking.childEffort}` : ""}`,
      signal: controller.signal,
      authStorage: auth,
      modelRegistry: registry,
      settings,
      parentAgentId: MAIN_AGENT_ID,
      preloadedExtensionPaths: [PROBE, DORI],
      enableLsp: false,
      enableIrc: false,
      enableMCP: false,
      noContextFiles: true,
      skills: [],
      promptTemplates: [],
      rules: [],
    });
    let settled = false;
    void run.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const readyFile = beforeProvider ? `${holdFile}.waiting` : probeFile;
    await until(() => settled || existsSync(readyFile), 30_000);
    if (beforeProvider) {
      expect(existsSync(readyFile)).toBe(true);
      await disturb?.({ session, settings, globalFile, published, childModel });
      rmSync(holdFile);
    }
    // A subagent past its guard requests at once and a held one ends its run. The real-time cap only bounds a held
    // run native keeps open on another thread, where no fake clock reaches.
    await Promise.race([run, requested.promise, Bun.sleep(5_000)]);
    controller.abort();
    await run;
    childRequested = undefined;
    if (!existsSync(probeFile)) throw new Error("the subagent session never started");
    const probe: unknown = JSON.parse(readFileSync(probeFile, "utf8"));
    const requests = loopback.requested.slice(before);
    return {
      probe,
      childRequests: requests.filter((model) => model === CHILD_MODEL).length,
      totalRequests: requests.length,
      rootThinking: {
        configured: session.configuredThinkingLevel()?.toString(),
        effective: session.thinkingLevel?.toString(),
      },
    };
  } finally {
    controller?.abort();
    if (holdFile) rmSync(holdFile, { force: true });
    await session?.dispose();
    settings.stopWatching();
    await settings.flush();
  }
};

test("a pinned lane's worker-thread subagent passes against its verified root on its own model", async () => {
  const result = await workerRun(true);
  expect(result.probe).toEqual({ mainThread: false, mirror: true, model: CHILD_MODEL, thinkingLevel: null });
  expect(result.childRequests).toBeGreaterThan(0);
}, 60_000);

test("a legacy lane without a Dori overlay keeps its worker-thread subagents running", async () => {
  const result = await workerRun(false);
  expect(result.probe).toEqual({ mainThread: false, mirror: true, model: CHILD_MODEL, thinkingLevel: null });
  expect(result.childRequests).toBeGreaterThan(0);
}, 60_000);

for (const [name, disturb] of [
  [
    "a role added to the global defaults",
    async (root) => {
      writeFileSync(
        root.globalFile,
        JSON.stringify({
          modelRoles: { default: `openai/${ROOT_MODEL}`, scout: `openai/${CHILD_MODEL}` },
          defaultThinkingLevel: "low",
        }),
      );
      await root.settings.reloadFromDisk();
    },
  ],
  [
    "a HOLD the root published",
    (root) =>
      writePaneState(stateDir, { ...root.published, modelSnapshotError: "native model profile drift: published hold" }),
  ],
  [
    "a model change in progress",
    (root) => writePaneState(stateDir, { ...root.published, modelSwitch: { nonce: randomUUID(), status: "changing" } }),
  ],
  ["a live root model change", (root) => root.session.setModelTemporary(root.childModel)],
  [
    "another root's published state",
    (root) => writePaneState(stateDir, { ...root.published, sessionId: randomUUID() }),
  ],
  ["no published root state", () => rmSync(paneStatePath(stateDir, PANE), { force: true })],
] satisfies Array<[string, (root: WorkerRoot) => unknown]>) {
  test(`a pinned lane's worker-thread subagent holds before any request on ${name}`, async () => {
    const result = await workerRun(true, disturb);
    expect(result.probe).toMatchObject({ mainThread: false, mirror: true, model: CHILD_MODEL });
    expect(result.childRequests).toBe(0);
    expect(result.totalRequests).toBe(0);
  }, 60_000);
}

test("an already-started worker holds on transient root settings drift before its next provider request", async () => {
  let publishedError: string | undefined;
  const result = await workerRun(
    true,
    async (root) => {
      const before = { ...root.settings.getModelRoles() };
      const global = readFileSync(root.globalFile, "utf8");
      writeFileSync(
        root.globalFile,
        JSON.stringify({
          modelRoles: { default: `openai/${ROOT_MODEL}`, scout: `openai/${CHILD_MODEL}` },
          defaultThinkingLevel: "low",
        }),
      );
      await root.settings.reloadFromDisk();
      publishedError = readPaneState(stateDir, PANE)?.modelSnapshotError;
      writeFileSync(root.globalFile, global);
      await root.settings.reloadFromDisk();
      expect({ ...root.settings.getModelRoles() }).toEqual(before);
    },
    undefined,
    true,
  );
  expect(result.probe).toMatchObject({ mainThread: false, mirror: true, model: CHILD_MODEL });
  expect(result.totalRequests).toBe(0);
  expect(result.childRequests).toBe(0);
  expect(publishedError).toContain("unexpected role scout");
}, 60_000);

test("an already-started worker holds when thinking publication fails instead of trusting stale state", async () => {
  let afterPublication: PaneState | null | undefined;
  const result = await workerRun(
    true,
    (root) => {
      const high = root.session.getAvailableEffortSelectors().find((level) => level === "high");
      if (high === undefined) throw new Error("native reasoning fixture has no high effort");
      const tmp = `${paneStatePath(stateDir, PANE)}.${process.pid}.tmp`;
      mkdirSync(tmp);
      try {
        root.session.setThinkingLevel(high);
        expect(root.session.configuredThinkingLevel()?.toString()).toBe("high");
        afterPublication = readPaneState(stateDir, PANE);
      } finally {
        rmSync(tmp, { recursive: true });
      }
    },
    { selected: "low" },
    true,
  );
  expect(result.probe).toMatchObject({ mainThread: false, mirror: true, model: CHILD_MODEL });
  expect(result.totalRequests).toBe(0);
  expect(result.childRequests).toBe(0);
  expect(afterPublication).toBeNull();
}, 60_000);

test("a pinned auto lane's worker-thread subagent passes after auto's effective level moves, on its own thinking", async () => {
  const result = await workerRun(
    true,
    async (root) => {
      // A real auto turn: `ultrathink` resolves auto past its provisional level and native announces it while the
      // selection stays auto. Its own root request precedes the counted window.
      const before = loopback.requested.length;
      await root.session.prompt("ultrathink Return OK.");
      expect(loopback.requested.slice(before)).toEqual([ROOT_MODEL]);
      expect(root.session.configuredThinkingLevel()?.toString()).toBe("auto");
      expect(root.session.thinkingLevel?.toString()).toBe("high");
      expect(readPaneState(stateDir, PANE)?.modelSnapshotError).toBeUndefined();
    },
    { selected: "auto", childEffort: "medium" },
  );
  expect(result.probe).toEqual({ mainThread: false, mirror: true, model: CHILD_MODEL, thinkingLevel: "medium" });
  expect(result.childRequests).toBeGreaterThan(0);
  // The child's own explicit thinking neither held it nor moved its root's selection.
  expect(result.rootThinking).toEqual({ configured: "auto", effective: "high" });
}, 60_000);

for (const [name, selected, select] of [
  [
    "a root thinking selection raised from low to high",
    "low",
    (session) => session.getAvailableEffortSelectors().find((level) => level === "high"),
  ],
  [
    "a root auto selection pinned to its same effective level",
    "auto",
    (session) => {
      expect(session.thinkingLevel?.toString()).toBe("low");
      return session.thinkingLevel;
    },
  ],
] satisfies Array<
  [string, WorkerThinking["selected"], (session: AgentSession) => Parameters<AgentSession["setThinkingLevel"]>[0]]
>) {
  test(`a pinned lane's worker-thread subagent holds before any request on ${name}`, async () => {
    const result = await workerRun(
      true,
      (root) => {
        const level = select(root.session);
        if (level === undefined) throw new Error("native reasoning fixture has no such thinking selection");
        // The public native selector: it emits thinking_level_changed synchronously, and the root lane publishes the
        // drift its worker reads at the subagent's next provider boundary.
        root.session.setThinkingLevel(level);
        expect(root.session.configuredThinkingLevel()?.toString()).toBe(level);
        expect(readPaneState(stateDir, PANE)?.modelSnapshotError).toContain(
          `native thinking selection ${level} differs from snapshot ${selected}`,
        );
      },
      { selected },
      true,
    );
    expect(result.probe).toMatchObject({ mainThread: false, mirror: true, model: CHILD_MODEL });
    expect(result.childRequests).toBe(0);
    expect(result.totalRequests).toBe(0);
  }, 60_000);
}
