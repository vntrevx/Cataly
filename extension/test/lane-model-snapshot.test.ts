import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type * as NativeConfig from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/config/settings.d.ts";
import {
  isModelSnapshot,
  readPaneState,
  type ModelSnapshot,
  type PaneState,
} from "../../skills/dori-mode/scripts/src/lane-state.ts";
import { createModelProfileFile } from "../../skills/dori-mode/scripts/src/model-profile.ts";
import type { ModelSwitchRequest } from "../../skills/dori-mode/scripts/src/model-switch-state.ts";
import { Registry } from "../../skills/dori-mode/scripts/src/registry.ts";
import { load, useConfig, type FakeOptions, type FakePi } from "./fake-pi.ts";

const host = resolve(import.meta.dir, "../../test/fixtures/omp-native-host");
const { Settings }: typeof NativeConfig = await import(
  Bun.resolveSync("@oh-my-pi/pi-coding-agent/config/settings", host)
);
const A = { provider: "fixture", id: "a" };
const B = { provider: "fixture", id: "b" };
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const world = async () => {
  const keys = ["DORI_CONFIG", "DORI_STATE_DIR", "HERDR_PANE_ID", "HC_TERMINAL_ID"];
  const before = keys.map((key) => process.env[key]);
  const stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
  const root = dirname(stateDir);
  const agentDir = join(root, "native-agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  const globalFile = join(agentDir, "config.yml");
  const global = (model: string, effort = "low") =>
    writeFileSync(
      globalFile,
      JSON.stringify({
        modelRoles: { default: model, task: "fixture/task" },
        defaultThinkingLevel: effort,
      }),
    );
  global("fixture/a");
  process.env.HERDR_PANE_ID = "profile:p1";
  delete process.env.HC_TERMINAL_ID;
  const instances: Array<{ pi: FakePi; settings: NativeConfig.Settings }> = [];
  const lane = async (patch: Partial<FakeOptions> = {}) => {
    const file = createModelProfileFile(stateDir);
    const settings = await Settings.loadIsolated({ cwd, agentDir, configFiles: [file] });
    const options: FakeOptions = {
      session: {
        id: randomUUID(),
        file: join(root, `${randomUUID()}.jsonl`),
        entries: [
          { type: "mode_change", mode: "goal_paused", data: { goal: { objective: "fixture", status: "paused" } } },
        ],
      },
      settings,
      model: A,
      catalog: [A, B],
      thinkingLevel: "low",
      flags: { "dori-role": "lane", "dori-launch-model": "fixture/a" },
      ...patch,
    };
    const pi = await load(options);
    instances.push({ pi, settings });
    await pi.emit("session_start");
    return { pi, options, settings, file };
  };
  const state = (): PaneState => {
    const value = readPaneState(stateDir, "profile:p1");
    if (!value) throw new Error("native fixture state missing");
    return value;
  };
  cleanups.push(async () => {
    for (const instance of instances) {
      await instance.pi.emit("session_shutdown");
      instance.settings.cancelPendingSaves();
    }
    keys.forEach((key, i) => {
      if (before[i] === undefined) delete process.env[key];
      else process.env[key] = before[i];
    });
    rmSync(root, { recursive: true, force: true });
  });
  const request = async (selector: string, target = state()): Promise<ModelSwitchRequest> => {
    if (!target.sessionFile) throw new Error("fixture needs a session file");
    const value: ModelSwitchRequest = {
      version: 1,
      nonce: randomUUID(),
      requested: selector,
      createdAt: new Date().toISOString(),
      head: {
        paneId: "head:p1",
        pid: process.pid,
        sessionId: "head",
        sessionFile: join(root, "head.jsonl"),
        startedAt: target.startedAt,
      },
      target: {
        paneId: target.paneId,
        pid: target.pid,
        sessionId: target.sessionId,
        sessionFile: target.sessionFile,
        startedAt: target.startedAt,
      },
      priorSnapshotId: target.modelSnapshot?.id ?? null,
    };
    await new Registry(stateDir).write({
      key: "lane",
      title: "fixture",
      brief: join(root, "brief.md"),
      done: "fixture",
      thread: "none",
      pane: target.paneId,
      openedAt: target.startedAt,
      session: target.sessionId,
      sessionFile: target.sessionFile,
      modelProfileFile: target.modelProfileFile,
      modelSnapshot: target.modelSnapshot,
      modelSwitchRequest: value,
    });
    return value;
  };
  return { stateDir, root, globalFile, global, lane, state, request };
};

const snapshot = (state: PaneState): ModelSnapshot => {
  if (!isModelSnapshot(state.modelSnapshot)) throw new Error(state.modelSnapshotError ?? "snapshot missing");
  return state.modelSnapshot;
};

test("native thinking drift publishes HOLD before the next provider turn", async () => {
  const w = await world();
  const lane = await w.lane();
  const saved = snapshot(w.state());
  expect(saved.configuredThinkingLevel).toBe("low");
  lane.options.thinkingLevel = "high";
  await lane.pi.emit("thinking_level_changed");
  expect(w.state().modelSnapshotError).toContain("native thinking selection high differs from snapshot low");
  expect(w.state().modelSnapshot).toEqual(saved);
  await expect(lane.pi.emit("before_provider_request")).rejects.toThrow("MODEL_SNAPSHOT_HOLD");
});

test("auto observations may change, but pinning the same effective level changes the selection", async () => {
  const w = await world();
  const lane = await w.lane({ autoThinking: true, thinkingLevel: "medium" });
  const saved = snapshot(w.state());
  expect(saved).toMatchObject({ configuredThinkingLevel: "auto", thinkingLevel: "medium" });
  lane.options.thinkingLevel = "high";
  await lane.pi.emit("thinking_level_changed");
  expect(w.state().modelSnapshotError).toBeUndefined();
  expect(w.state().modelSnapshot).toEqual(saved);
  await lane.pi.emit("before_provider_request");
  lane.options.autoThinking = false;
  await lane.pi.emit("thinking_level_changed");
  expect(w.state().modelSnapshotError).toContain("native thinking selection high differs from snapshot auto");
  expect(await lane.pi.emit("before_subagent_spawn")).toContainEqual({
    block: true,
    reason: expect.stringContaining("MODEL_SNAPSHOT_HOLD"),
  });
});

test.each(["changed", "missing"])("reopen holds a %s saved thinking selection without recapturing", async (fault) => {
  const w = await world();
  const first = await w.lane();
  const saved = snapshot(w.state());
  const entries = first.pi.session.entries.map((entry) =>
    entry.customType === "omp-dori:model-snapshot" && fault === "missing"
      ? { ...entry, data: { ...saved, configuredThinkingLevel: undefined } }
      : entry,
  );
  const resumed = await w.lane({
    flags: {},
    thinkingLevel: "high",
    session: { ...first.pi.session, entries },
  });
  expect(w.state().modelSnapshotError).toContain(fault === "missing" ? "malformed" : "thinking selection high");
  expect(resumed.options.thinkingLevel).toBe("high");
  expect(resumed.pi.session.entries.filter((entry) => entry.customType === "omp-dori:model-snapshot")).toHaveLength(1);
  await expect(resumed.pi.emit("before_provider_request")).rejects.toThrow("MODEL_SNAPSHOT_HOLD");
});

test("retired native thinking subscriptions cannot reactivate a shutdown pane", async () => {
  const w = await world();
  const lane = await w.lane();
  await lane.pi.emit("session_shutdown");
  const retired = readPaneState(w.stateDir, "profile:p1");
  expect(retired?.pid).toBe(0);
  lane.options.thinkingLevel = "high";
  await lane.pi.emit("thinking_level_changed");
  expect(readPaneState(w.stateDir, "profile:p1")).toEqual(retired);
});

test("first capture persists full native provenance; reopen keeps it while a new lane sees edited defaults", async () => {
  const w = await world();
  const first = await w.lane();
  const saved = snapshot(w.state());
  expect(w.state().modelSnapshotError).toBeUndefined();
  expect(saved).toMatchObject({
    model: A,
    modelRoles: { default: "fixture/a", task: "fixture/task" },
    defaultThinkingLevel: "low",
    provenance: { kind: "launch", modelRoles: { default: "global", task: "global" }, defaultThinkingLevel: "global" },
  });
  expect(first.pi.session.entries.filter((entry) => entry.customType === "omp-dori:model-snapshot")).toHaveLength(1);
  w.global("fixture/b", "high");
  await first.settings.reloadFromDisk();
  await first.pi.emit("before_provider_request");
  const resumed = await w.lane({ session: first.pi.session, flags: {}, model: A });
  expect(snapshot(w.state())).toEqual(saved);
  expect(resumed.file).not.toBe(first.file);
  await resumed.pi.emit("before_provider_request");
  const fresh = await w.lane({ model: B, flags: { "dori-role": "lane", "dori-launch-model": "fixture/b" } });
  const next = snapshot(w.state());
  expect(next.id).not.toBe(saved.id);
  expect(next.model).toEqual(B);
  expect(next.modelRoles.default).toBe("fixture/b");
  expect(next.defaultThinkingLevel).toBe("high");
  await fresh.pi.emit("before_provider_request");
});

test("new carries the saved snapshot; unrelated sessions release only this process overlay", async () => {
  const w = await world();
  const lane = await w.lane();
  const saved = snapshot(w.state());
  w.global("fixture/b", "high");
  lane.pi.session = { id: randomUUID(), file: join(w.root, "new.jsonl"), entries: [] };
  await lane.pi.emit("session_switch", { reason: "new" });
  expect(snapshot(w.state())).toEqual(saved);
  await lane.pi.emit("before_provider_request");
  lane.pi.session = { id: randomUUID(), file: join(w.root, "ordinary.jsonl"), entries: [] };
  lane.options.model = B;
  await lane.pi.emit("session_switch", { reason: "resume" });
  await lane.pi.emit("before_provider_request");
  expect(JSON.parse(readFileSync(lane.file, "utf8"))).toEqual({});
  expect(lane.settings.getModelRoles().default).toBe("fixture/b");
  expect(JSON.parse(readFileSync(w.globalFile, "utf8")).modelRoles.default).toBe("fixture/b");
});

test("unknown and malformed latest native snapshots never fall back or select a model", async () => {
  const w = await world();
  let sets = 0;
  const initial = await w.lane({
    setModel: async () => {
      sets++;
      return true;
    },
  });
  const saved = snapshot(w.state());
  for (const malformed of [undefined, { ...saved, model: null }, { ...saved, provenance: null }]) {
    const entries =
      malformed === undefined
        ? []
        : [
            { type: "custom", customType: "omp-dori:model-snapshot", data: saved },
            { type: "custom", customType: "omp-dori:model-snapshot", data: malformed },
          ];
    const lane = await w.lane({
      session: {
        id: randomUUID(),
        file: join(w.root, `${randomUUID()}.jsonl`),
        entries: [{ type: "custom", customType: "omp-dori:role", data: "lane" }, ...entries],
      },
      flags: {},
      setModel: async () => {
        sets++;
        return true;
      },
    });
    expect(w.state().modelSnapshotError).toMatch(/unknown|malformed/);
    await expect(lane.pi.emit("before_provider_request")).rejects.toThrow("MODEL_SNAPSHOT_HOLD");
  }
  expect(sets).toBe(0);
  expect(initial.options.model).toEqual(A);
});

test.each(["missing", "malformed"])(
  "an explicit head selection replaces a %s snapshot without automatic recovery",
  async (fault) => {
    const w = await world();
    const lane = await w.lane({
      flags: {},
      session: {
        id: randomUUID(),
        file: join(w.root, `${randomUUID()}.jsonl`),
        entries: [
          { type: "custom", customType: "omp-dori:role", data: "lane" },
          ...(fault === "malformed"
            ? [{ type: "custom", customType: "omp-dori:model-snapshot", data: { version: 1 } }]
            : []),
        ],
      },
    });
    expect(w.state().modelSnapshotError).toMatch(/unknown|malformed/);
    expect(w.state().modelSnapshot).toBeUndefined();
    await expect(lane.pi.emit("before_provider_request")).rejects.toThrow("MODEL_SNAPSHOT_HOLD");
    const before = readFileSync(w.globalFile, "utf8");
    const request = await w.request("fixture/b");
    expect(request.priorSnapshotId).toBeNull();
    await lane.pi.command("dori-model-apply", `lane ${request.nonce}`);
    expect(w.state().modelSwitch).toEqual({ nonce: request.nonce, status: "changed" });
    expect(w.state().modelSnapshotError).toBeUndefined();
    expect(snapshot(w.state())).toMatchObject({
      model: B,
      configuredThinkingLevel: "low",
      provenance: { kind: "idle-switch", requested: "fixture/b" },
    });
    expect(w.state().goal.status).toBe("none");
    expect(readFileSync(w.globalFile, "utf8")).toBe(before);
    await lane.pi.emit("before_provider_request");
  },
);

test("provider boundaries protect the root profile but keep independent native child models", async () => {
  const w = await world();
  const root = await w.lane();
  const child = await load({
    agent: { kind: "sub", id: "profile-child", parentId: "Main" },
    session: { id: "child", entries: [] },
    model: B,
    native: root.pi.api.pi,
  });
  await child.emit("session_start");
  await child.emit("before_provider_request");
  writeFileSync(
    w.globalFile,
    JSON.stringify({
      modelRoles: { default: "fixture/b", task: "fixture/task", scout: "fixture/new" },
      defaultThinkingLevel: "high",
    }),
  );
  await root.settings.reloadFromDisk();
  expect(await root.pi.emit("before_subagent_spawn")).toContainEqual({
    block: true,
    reason: expect.stringContaining("unexpected role scout"),
  });
  await expect(child.emit("before_provider_request")).rejects.toThrow("MODEL_SNAPSHOT_HOLD");
  expect(child.ctx().model).toEqual(B);
});

test("a subagent reaches only its own native root's binding, never one by a reused parent id", async () => {
  const w = await world();
  const root = await w.lane();
  writeFileSync(
    w.globalFile,
    JSON.stringify({
      modelRoles: { default: "fixture/a", task: "fixture/task", scout: "fixture/new" },
      defaultThinkingLevel: "low",
    }),
  );
  await root.settings.reloadFromDisk();
  expect(await root.pi.emit("before_subagent_spawn")).toContainEqual({
    block: true,
    reason: expect.stringContaining("unexpected role scout"),
  });
  // Another root session in this process registers the same parent id but is a different native session.
  const otherRoot = {
    settings: Settings.isolated(),
    sessionManager: { getSessionId: () => "other-root", getSessionFile: () => undefined, getBranch: () => [] },
    agent: { state: { model: B } },
    getAsyncJobTree: () => ({ running: [] }),
  };
  const foreign = await load({
    agent: { kind: "sub", id: "foreign-child", parentId: "Main" },
    session: { id: "foreign-child", entries: [] },
    model: B,
    native: { MAIN_AGENT_ID: "Main", AgentRegistry: { global: () => ({ get: () => ({ session: otherRoot }) }) } },
  });
  await foreign.emit("session_start");
  await foreign.emit("before_provider_request");
  const own = await load({
    agent: { kind: "sub", id: "own-child", parentId: "Main" },
    session: { id: "own-child", entries: [] },
    model: B,
    native: root.pi.api.pi,
  });
  await own.emit("session_start");
  await expect(own.emit("before_provider_request")).rejects.toThrow("MODEL_SNAPSHOT_HOLD");
});

test("only a process-owned overlay needs the native root; a host without one keeps the legacy lane contract", async () => {
  const w = await world();
  const detached: NonNullable<FakeOptions["native"]> = {
    MAIN_AGENT_ID: "Main",
    AgentRegistry: { global: () => ({ get: () => undefined }) },
  };
  // A prompt-composition host: no registered native root and no `--config` profile overlay.
  const legacy = await w.lane({ native: detached, settings: Settings.isolated() });
  expect(w.state().modelSnapshotError).toBeUndefined();
  expect(w.state().modelSnapshot).toBeUndefined();
  await legacy.pi.emit("before_provider_request");
  await legacy.pi.emit("before_subagent_spawn");
  expect(legacy.pi.session.entries.some((entry) => entry.customType === "omp-dori:model-snapshot")).toBe(false);

  // A guarded launch whose root cannot be verified is a HOLD, not a legacy lane.
  const guarded = await w.lane({ native: detached });
  expect(w.state().modelSnapshotError).toBe("native root session identity is unverified");
  expect(await guarded.pi.emit("before_subagent_spawn")).toContainEqual({
    block: true,
    reason: expect.stringContaining("MODEL_SNAPSHOT_HOLD"),
  });

  await w.lane();
  const saved = snapshot(w.state());
  const resumed = await w.lane({
    native: detached,
    settings: Settings.isolated(),
    flags: {},
    session: {
      id: randomUUID(),
      file: join(w.root, `${randomUUID()}.jsonl`),
      entries: [
        { type: "custom", customType: "omp-dori:role", data: "lane" },
        { type: "custom", customType: "omp-dori:model-snapshot", data: saved },
      ],
    },
  });
  expect(w.state().modelSnapshotError).toBe("saved lane snapshot has no process-owned model profile overlay");
  expect(await resumed.pi.emit("before_subagent_spawn")).toContainEqual({
    block: true,
    reason: expect.stringContaining("MODEL_SNAPSHOT_HOLD"),
  });
});

test("layer observers do not mistake an in-progress saved-snapshot bind for drift", async () => {
  const w = await world();
  const lane = await w.lane();
  const saved = snapshot(w.state());
  const changed = { ...saved, id: randomUUID(), modelRoles: { ...saved.modelRoles, task: "fixture/branch-task" } };
  lane.pi.session.entries.push({ type: "custom", customType: "omp-dori:model-snapshot", data: changed });
  const reload = lane.settings.reloadFromDisk.bind(lane.settings);
  const entered = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  lane.settings.reloadFromDisk = async () => {
    entered.resolve();
    await proceed.promise;
    await reload();
  };
  const binding = lane.pi.emit("session_tree");
  await entered.promise;
  try {
    lane.settings.overrideModelRoles({ default: `${A.provider}/${A.id}` });
  } finally {
    proceed.resolve();
  }
  await binding;
  lane.settings.reloadFromDisk = reload;
  expect(w.state().modelSnapshotError).toBeUndefined();
  expect(snapshot(w.state())).toEqual(changed);
  expect({ ...lane.settings.getModelRoles() }).toEqual(changed.modelRoles);
  await lane.pi.emit("before_provider_request");
});

test("an authorized idle switch creates one new snapshot and never mutates global defaults or resumes the goal", async () => {
  const w = await world();
  let sets = 0;
  const lane = await w.lane({
    setModel: async () => {
      sets++;
      return true;
    },
  });
  const previous = snapshot(w.state());
  const globalBefore = readFileSync(w.globalFile, "utf8");
  const request = await w.request("fixture/b");
  await lane.pi.command("dori-model-apply", `lane ${request.nonce}`);
  const current = w.state();
  expect(current.modelSwitch).toEqual({ nonce: request.nonce, status: "changed" });
  expect(snapshot(current)).toMatchObject({
    model: B,
    modelRoles: previous.modelRoles,
    defaultThinkingLevel: previous.defaultThinkingLevel,
    provenance: { ...previous.provenance, kind: "idle-switch", requested: "fixture/b" },
  });
  expect(current.modelSnapshot?.id).not.toBe(previous.id);
  expect(current.goal.status).toBe("paused");
  expect(readFileSync(w.globalFile, "utf8")).toBe(globalBefore);
  await lane.pi.emit("before_provider_request");
  await lane.pi.command("dori-model-apply", `lane ${request.nonce}`);
  expect(sets).toBe(1);
  expect(snapshot(w.state())).toEqual(snapshot(current));
});

test("model selection cancels native session moves while awaiting its asynchronous setter", async () => {
  const w = await world();
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<boolean>();
  const lane = await w.lane({
    setModel: async () => {
      entered.resolve();
      return finish.promise;
    },
  });
  const request = await w.request("fixture/b");
  const changing = lane.pi.command("dori-model-apply", `lane ${request.nonce}`);
  await entered.promise;
  expect(w.state().modelSwitch?.status).toBe("changing");
  for (const event of ["session_before_switch", "session_before_branch", "session_before_tree"])
    expect(await lane.pi.emit(event)).toContainEqual({ cancel: true });
  await expect(lane.pi.emit("before_provider_request")).rejects.toThrow("MODEL_SNAPSHOT_HOLD");
  finish.resolve(true);
  await changing;
  expect(w.state().modelSwitch?.status).toBe("changed");
  await lane.pi.emit("before_provider_request");
});

for (const [name, patch] of [
  ["working", { idle: false }],
  ["queued message", { pendingMessages: true }],
  [
    "running async job",
    { asyncJobs: { running: [{}], delivery: { queued: 0, delivering: false, pendingJobIds: [] } } },
  ],
  [
    "pending async delivery",
    { asyncJobs: { running: [], delivery: { queued: 1, delivering: false, pendingJobIds: ["job"] } } },
  ],
  ["descendant work", { descendantJobs: [{}] }],
  ["unknown async state", { asyncJobs: null }],
  ["unknown descendant tree", {}],
] satisfies Array<[string, Partial<FakeOptions>]>) {
  test(`idle model switch refuses ${name} without invoking a setter`, async () => {
    const w = await world();
    let sets = 0;
    const lane = await w.lane({
      ...patch,
      setModel: async () => {
        sets++;
        return true;
      },
    });
    if (name === "unknown descendant tree") {
      const owner = lane.pi.api.pi.AgentRegistry.global().get(lane.pi.ctx().agent.id)?.session;
      if (!owner) throw new Error("native owner fixture missing");
      Object.assign(owner, { getAsyncJobTree: () => null });
    }
    const saved = snapshot(w.state());
    const request = await w.request("fixture/b");
    await lane.pi.command("dori-model-apply", `lane ${request.nonce}`);
    expect(sets).toBe(0);
    expect(snapshot(w.state())).toEqual(saved);
    expect(lane.pi.notes.some((note) => note.includes("MODEL_SWITCH_REFUSED"))).toBe(true);
  });
}

test("unavailable selections and native setter rejection publish failure without fallback", async () => {
  const w = await world();
  let sets = 0;
  const lane = await w.lane({
    setModel: async () => {
      sets++;
      return false;
    },
  });
  const saved = snapshot(w.state());
  const unavailable = await w.request("fixture/missing");
  await lane.pi.command("dori-model-apply", `lane ${unavailable.nonce}`);
  expect(w.state().modelSwitch?.status).toBe("failed");
  expect(sets).toBe(0);
  // Native reads back the unchanged pinned snapshot, so the lane keeps running on it.
  expect(w.state().modelSnapshotError).toBeUndefined();
  await lane.pi.emit("before_provider_request");
  const rejected = await w.request("fixture/b");
  await lane.pi.command("dori-model-apply", `lane ${rejected.nonce}`);
  expect(w.state().modelSwitch?.status).toBe("failed");
  expect(sets).toBe(1);
  expect(snapshot(w.state())).toEqual(saved);
  expect(lane.options.model).toEqual(A);
  expect(w.state().modelSnapshotError).toBeUndefined();
  await lane.pi.emit("before_provider_request");
});

test("a refused switch after native already changed the model holds without rollback", async () => {
  const w = await world();
  let sets = 0;
  let native: FakeOptions | undefined;
  const lane = await w.lane({
    setModel: async (selected) => {
      sets++;
      if (native) native.model = selected;
      return false;
    },
  });
  native = lane.options;
  const saved = snapshot(w.state());
  const request = await w.request("fixture/b");
  await lane.pi.command("dori-model-apply", `lane ${request.nonce}`);
  expect(sets).toBe(1);
  expect(w.state().modelSwitch).toMatchObject({ nonce: request.nonce, status: "failed" });
  expect(w.state().modelSnapshotError).toBe("native model setter refused the requested model");
  expect(w.state().modelSnapshot).toEqual(saved);
  expect(await lane.pi.emit("before_subagent_spawn")).toContainEqual({
    block: true,
    reason: expect.stringContaining("MODEL_SNAPSHOT_HOLD"),
  });
  expect(lane.options.model).toEqual(B);
  expect(sets).toBe(1);
});

test("ordinary and lane sessions cannot invoke the native head workflow", async () => {
  const w = await world();
  const lane = await w.lane();
  await lane.pi.command("dori-lane-model", "lane fixture/b");
  expect(lane.pi.notes.at(-1)).toContain("only in the native main Dori head");
  expect(await new Registry(w.stateDir).read("lane")).toBeNull();
});
