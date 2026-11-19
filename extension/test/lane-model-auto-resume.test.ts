import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type * as NativeConfig from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/config/settings.d.ts";
import type * as NativeInit from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/modes/runtime-init.d.ts";
import type * as NativeSdk from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/sdk.d.ts";
import type { AgentSession } from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/session/agent-session.d.ts";
import type * as NativeSessions from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/session/session-manager.d.ts";
import type * as NativeSessionSettings from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/session/settings.d.ts";
import { isModelSnapshot, type ModelSnapshot } from "../../skills/dori-mode/scripts/src/lane-state.ts";
import { createModelProfileFile } from "../../skills/dori-mode/scripts/src/model-profile.ts";
import { nativeExtensionFactory } from "../../test/fixtures/omp-native-host/compose.ts";
import {
  loopbackProvider,
  loopbackRegistry,
  NATIVE_FIXTURE_OVERRIDES,
} from "../../test/fixtures/omp-native-host/required-source.ts";
import { useConfig } from "./fake-pi.ts";

// The real native host, loaded from the exact fixture the other native regressions use. Runtime-resolved: the pinned
// host lives in the fixture's own node_modules, outside this package's resolution, typed by its public d.ts paths.
const host = resolve(import.meta.dir, "../../test/fixtures/omp-native-host");
const nativeModule = (path: string): string => Bun.resolveSync(`@oh-my-pi/pi-coding-agent/${path}`, host);
const { Settings }: typeof NativeConfig = await import(nativeModule("config/settings"));
const { createAgentSession }: typeof NativeSdk = await import(nativeModule("sdk"));
const { SessionManager }: typeof NativeSessions = await import(nativeModule("session/session-manager"));
const { initializeExtensions }: typeof NativeInit = await import(nativeModule("modes/runtime-init"));
const { cfgDefaultThinkingLevel }: typeof NativeSessionSettings = await import(nativeModule("session/settings"));

const DORI = join(import.meta.dir, "../index.ts");
const MODEL_ID = "required-source-local";
const OTHER_ID = "required-source-next";
const SELECTED = `openai/${MODEL_ID}`;
const SNAPSHOT_ENTRY = "omp-dori:model-snapshot";
// `ultrathink` resolves auto to the ladder's top (`high` on the loopback ladder), which equals auto's provisional
// level: native records no resolution, so native alone leaves the transcript without any `thinking_level_change`.
const AUTO_TURN = "ultrathink Return OK.";
const KEYS = ["HOME", "DORI_CONFIG", "DORI_STATE_DIR", "DORI_OMP_ULW_PATH", "HERDR_PANE_ID", "HC_TERMINAL_ID"];

/** Global settings saved after the lane stopped: another default model with its own concrete effort, another default. */
const EDITED_GLOBAL = { modelRoles: { default: `openai/${OTHER_ID}:medium` }, defaultThinkingLevel: "medium" };

const CASES = [
  {
    name: "global defaultThinkingLevel auto",
    launchGlobal: { modelRoles: { default: SELECTED }, defaultThinkingLevel: "auto" },
    explicitAuto: false,
    freshSession: false,
  },
  {
    name: "explicit --thinking auto over a concrete role and default",
    launchGlobal: { modelRoles: { default: `${SELECTED}:low` }, defaultThinkingLevel: "low" },
    explicitAuto: true,
    freshSession: false,
  },
  {
    name: "native /new before any assistant response",
    launchGlobal: { modelRoles: { default: `openai/${OTHER_ID}:low` }, defaultThinkingLevel: "low" },
    explicitAuto: true,
    freshSession: true,
  },
];

const latestSnapshot = (session: Pick<AgentSession, "sessionManager">): ModelSnapshot | undefined => {
  const saved = session.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === "custom" && entry.customType === SNAPSHOT_ENTRY);
  return saved?.type === "custom" && isModelSnapshot(saved.data) ? saved.data : undefined;
};

for (const { name, launchGlobal, explicitAuto, freshSession } of CASES) {
  test(`real native saved selection survives reopen (${name})`, async () => {
    const previous = KEYS.map((key) => process.env[key]);
    const stateDir = useConfig("");
    const home = dirname(stateDir);
    process.env.HOME = home;
    delete process.env.DORI_OMP_ULW_PATH;
    delete process.env.HERDR_PANE_ID;
    delete process.env.HC_TERMINAL_ID;
    const cwd = join(home, "project");
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });
    const globalFile = join(agentDir, "config.yml");
    writeFileSync(globalFile, JSON.stringify(launchGlobal));
    const factory = await nativeExtensionFactory(DORI);
    const loopback = loopbackProvider();
    const models = [loopback.model(MODEL_ID, true), loopback.model(OTHER_ID, true)];
    const [launchModel] = models;
    if (!launchModel) throw new Error("loopback model missing");
    const shared: NativeSdk.CreateAgentSessionOptions = {
      cwd,
      agentDir,
      bindProcessState: false,
      cacheWarming: false,
      disableModelFallback: true,
      toolNames: [],
      disableExtensionDiscovery: true,
      skills: [],
      promptTemplates: [],
      slashCommands: [],
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      skipPythonPreflight: true,
      getApiKey: async (selected) => {
        expect(selected.baseUrl).toBe(launchModel.baseUrl);
        return "local-fixture-only";
      },
      assertDispatchModel: (selected) => expect(selected.baseUrl).toBe(launchModel.baseUrl),
    };
    const initialize = async (session: AgentSession, errors: Array<{ event: string; error: string }>) => {
      if (!session.extensionRunner) throw new Error("native extension runner missing");
      await initializeExtensions(session, {
        mode: "json",
        reportRuntimeError: (error) => errors.push({ event: error.event, error: error.error }),
        reportSendError: (_action, error) => {
          throw error;
        },
      });
    };
    let launched: AgentSession | undefined;
    let resumed: AgentSession | undefined;
    const launchSettings = await Settings.loadIsolated({
      cwd,
      agentDir,
      configFiles: [createModelProfileFile(stateDir)],
      overrides: { ...NATIVE_FIXTURE_OVERRIDES },
    });
    let resumeSettings: NativeConfig.Settings | undefined;
    try {
      // 1. A fresh guarded lane launch on auto. Native writes no thinking entry (sdk.ts skips auto's initial record;
      //    model-controls records only a changed resolution, and the ultrathink turn keeps the provisional effort).
      //    Dori may record the selection itself; resume below must keep the snapshot either way.
      const { auth, registry } = await loopbackRegistry(cwd, launchSettings, models);
      const launchManager = SessionManager.create(cwd, join(cwd, "sessions"));
      ({ session: launched } = await createAgentSession({
        ...shared,
        sessionManager: launchManager,
        authStorage: auth,
        modelRegistry: registry,
        model: launchModel,
        ...(explicitAuto ? ({ thinkingLevel: "auto" } satisfies NativeSdk.CreateAgentSessionOptions) : {}),
        settings: launchSettings,
        extensions: [
          async (api) =>
            factory(
              new Proxy(api, {
                get(target, key) {
                  return key === "getFlag"
                    ? (flag: string) =>
                        flag === "dori-launch-model" ? SELECTED : flag === "dori-role" ? "lane" : target.getFlag(flag)
                    : Reflect.get(target, key);
                },
              }),
            ),
        ],
      }));
      // Native itself recorded no auto selection; whatever Dori records from here on is its own.
      expect(launchManager.getBranch().filter((entry) => entry.type === "thinking_level_change")).toEqual([]);
      const launchErrors: Array<{ event: string; error: string }> = [];
      await initialize(launched, launchErrors);
      if (freshSession) {
        const previousId = launchManager.getSessionId();
        expect(await launched.newSession()).toBe(true);
        expect(launchManager.getSessionId()).not.toBe(previousId);
        expect(launchManager.getBranch().filter((entry) => entry.type === "message")).toEqual([]);
        // Persist the response-free session through the same public API used by native handoff/ACP.
        await launchManager.ensureOnDisk();
      } else await launched.prompt(AUTO_TURN);
      expect(launchErrors).toEqual([]);
      expect(loopback.requested).toEqual(freshSession ? [] : [MODEL_ID]);
      expect(launched.configuredThinkingLevel()).toBe("auto");
      expect(launched.thinkingLevel?.toString()).toBe("high");
      const snapshot = latestSnapshot(launched);
      if (!snapshot) throw new Error("real native launch snapshot missing");
      expect(snapshot).toMatchObject({
        model: { provider: "openai", id: MODEL_ID },
        modelRoles: launchGlobal.modelRoles,
        defaultThinkingLevel: launchGlobal.defaultThinkingLevel,
        configuredThinkingLevel: "auto",
        thinkingLevel: "high",
        provenance: { kind: "launch", requested: SELECTED },
      });
      await launchManager.flush();
      const sessionFile = launchManager.getSessionFile();
      if (!sessionFile) throw new Error("real native session file missing");
      await launched.dispose();
      launched = undefined;
      launchSettings.stopWatching();
      await launchSettings.flush();

      // 2. The operator edits the saved global profile while the lane is stopped.
      writeFileSync(globalFile, JSON.stringify(EDITED_GLOBAL));
      const editedGlobal = readFileSync(globalFile, "utf8");

      // 3. `--resume=<file> --config=<new empty overlay>` with no --model/--thinking, as Dori reopen starts it: a new
      //    process-owned overlay, fresh native settings, registry and session manager over the same session file.
      const resumeOverlay = createModelProfileFile(stateDir);
      expect(readFileSync(resumeOverlay, "utf8")).toBe("{}\n");
      resumeSettings = await Settings.loadIsolated({
        cwd,
        agentDir,
        configFiles: [resumeOverlay],
        overrides: { ...NATIVE_FIXTURE_OVERRIDES },
      });
      const resumeStore = join(home, "resume-process");
      mkdirSync(resumeStore, { recursive: true });
      const fresh = await loopbackRegistry(resumeStore, resumeSettings, models);
      const resumeManager = await SessionManager.open(sessionFile, undefined, undefined, { throwIfMissing: true });
      ({ session: resumed } = await createAgentSession({
        ...shared,
        sessionManager: resumeManager,
        authStorage: fresh.auth,
        modelRegistry: fresh.registry,
        settings: resumeSettings,
        extensions: [factory],
      }));
      const resumeErrors: Array<{ event: string; error: string }> = [];
      await initialize(resumed, resumeErrors);

      expect(resumeErrors).toEqual([]);
      expect(resumed.agent.state.model?.id).toBe(MODEL_ID);
      expect(resumed.configuredThinkingLevel()).toBe("auto");
      expect(latestSnapshot(resumed)).toEqual(snapshot);
      expect(resumeSettings.getModelRoles()).toEqual(snapshot.modelRoles);
      expect(cfgDefaultThinkingLevel.get(resumeSettings).toString()).toBe(snapshot.defaultThinkingLevel);

      await resumed.prompt(AUTO_TURN);
      expect(resumeErrors).toEqual([]);
      expect(loopback.requested).toEqual(freshSession ? [MODEL_ID] : [MODEL_ID, MODEL_ID]);
      expect(resumed.configuredThinkingLevel()).toBe("auto");
      await resumeSettings.flush();
      expect(readFileSync(globalFile, "utf8")).toBe(editedGlobal);
    } finally {
      await launched?.dispose();
      await resumed?.dispose();
      launchSettings.stopWatching();
      await launchSettings.flush();
      resumeSettings?.stopWatching();
      await resumeSettings?.flush();
      loopback.server.stop(true);
      KEYS.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      rmSync(home, { recursive: true, force: true });
    }
  });
}
