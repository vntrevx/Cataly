import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type * as NativeConfig from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/config/settings.d.ts";
import type * as NativeSession from "../../test/fixtures/omp-native-host/node_modules/@oh-my-pi/pi-coding-agent/dist/types/session/settings.d.ts";
import type { ModelSnapshot } from "../../skills/dori-mode/scripts/src/lane-state.ts";
import { createModelProfileFile, ownedModelProfileFile } from "../../skills/dori-mode/scripts/src/model-profile.ts";
import {
  bindModelProfile,
  captureModelSnapshot,
  checkModelProfile,
  type NativeProfileModules,
  releaseModelProfile,
  thinkingSelectionDrift,
} from "../lane-model-profile.ts";

// CI has no extension peer: exercise the frozen host's real Settings instead of a mock.
const host = resolve(import.meta.dir, "../../test/fixtures/omp-native-host");
const { Settings, findScopedSettings }: typeof NativeConfig = await import(
  Bun.resolveSync("@oh-my-pi/pi-coding-agent/config/settings", host)
);
const { cfgDefaultThinkingLevel }: typeof NativeSession = await import(
  Bun.resolveSync("@oh-my-pi/pi-coding-agent/session/settings", host)
);
const modules: NativeProfileModules = { Settings, cfgDefaultThinkingLevel, findScopedSettings };
/** The host's own setting value, so a thinking-level readback uses its public parser and type. */
const effort = (level: string): ReturnType<typeof cfgDefaultThinkingLevel.get> => {
  const value = cfgDefaultThinkingLevel.get(Settings.isolated({ defaultThinkingLevel: level }));
  if (value !== level) throw new Error(`native OMP has no ${level} effort`);
  return value;
};
const model = { provider: "p", id: "a" };
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const world = () => {
  const root = mkdtempSync(join(tmpdir(), "dori-profile-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const stateDir = join(root, "state");
  const projectDir = join(cwd, process.env["PI_CONFIG_DIR"] || ".omp");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const globalFile = join(agentDir, "config.yml");
  const projectFile = join(projectDir, "config.yml");
  const instances: NativeConfig.Settings[] = [];
  cleanups.push(() => {
    for (const settings of instances) settings.cancelPendingSaves();
    rmSync(root, { recursive: true, force: true });
  });
  /** One native process: its own fresh profile overlay last, like a Dori launch or reopen. */
  const lane = async (overrides?: Record<string, unknown>, after: string[] = []) => {
    const file = createModelProfileFile(stateDir);
    const settings = await Settings.loadIsolated({ cwd, agentDir, configFiles: [file, ...after], overrides });
    instances.push(settings);
    return { file, settings };
  };
  return {
    stateDir,
    globalFile,
    projectFile,
    lane,
    global: (value: object) => writeFileSync(globalFile, JSON.stringify(value)),
    project: (value: object) => writeFileSync(projectFile, JSON.stringify(value)),
  };
};

const capture = (settings: NativeConfig.Settings, actual: ModelSnapshot["model"] | null = model): ModelSnapshot => {
  const snapshot = captureModelSnapshot(modules, settings, {
    kind: "launch",
    requested: "p/a",
    model: actual,
    configuredThinkingLevel: "low",
    thinkingLevel: "low",
  });
  if (typeof snapshot === "string") throw new Error(snapshot);
  return snapshot;
};

test("a pinned lane keeps its roles and thinking across global/project edits; a new lane captures the new profile", async () => {
  const w = world();
  w.global({ modelRoles: { default: "p/a:low", smol: "p/s" }, defaultThinkingLevel: "low" });
  const first = await w.lane();
  const snapshot = capture(first.settings);
  expect(snapshot).toMatchObject({
    model,
    modelRoles: { default: "p/a:low", smol: "p/s" },
    defaultThinkingLevel: "low",
    configuredThinkingLevel: "low",
    thinkingLevel: "low",
    provenance: {
      kind: "launch",
      requested: "p/a",
      modelRoles: { default: "global", smol: "global" },
      defaultThinkingLevel: "global",
    },
  });
  expect(await bindModelProfile(modules, first.settings, first.file, snapshot)).toBeNull();

  w.global({ modelRoles: { default: "p/b", smol: "p/t" }, defaultThinkingLevel: "high" });
  w.project({ modelRoles: { default: "p/c" }, defaultThinkingLevel: "medium" });
  await first.settings.reloadFromDisk();
  expect(checkModelProfile(modules, first.settings, first.file, snapshot, model)).toBeNull();
  expect({ ...first.settings.getModelRoles() }).toEqual({ default: "p/a:low", smol: "p/s" });
  expect(cfgDefaultThinkingLevel.get(first.settings)).toBe(effort("low"));

  const next = await w.lane();
  const fresh = capture(next.settings);
  expect(fresh.modelRoles).toEqual({ default: "p/c", smol: "p/t" });
  expect(fresh.defaultThinkingLevel).toBe("medium");
  expect(fresh.provenance.modelRoles).toEqual({ default: "project", smol: "global" });
  expect(fresh.provenance.defaultThinkingLevel).toBe("project");
});

test("a role added after binding is a HOLD, never adopted; an explicit rebind of the same snapshot unsets it", async () => {
  const w = world();
  w.global({ modelRoles: { default: "p/a", smol: "p/s" }, defaultThinkingLevel: "low" });
  const lane = await w.lane();
  const snapshot = capture(lane.settings);
  expect(await bindModelProfile(modules, lane.settings, lane.file, snapshot)).toBeNull();

  w.global({ modelRoles: { default: "p/a", smol: "p/s", scout: "p/x" }, defaultThinkingLevel: "low" });
  await lane.settings.reloadFromDisk();
  expect(checkModelProfile(modules, lane.settings, lane.file, snapshot, model)).toBe(
    "native model profile drift: unexpected role scout=p/x (global)",
  );
  expect(await bindModelProfile(modules, lane.settings, lane.file, snapshot)).toBeNull();
  expect({ ...lane.settings.getModelRoles() }).toEqual(snapshot.modelRoles);
  // The overlay's null tombstone leaves no role at all in a later capture, not an undefined one.
  expect(Object.keys(capture(lane.settings).modelRoles).sort()).toEqual(["default", "smol"]);
});

test("foreign overrides, a later overlay and another module graph are HOLDs", async () => {
  const w = world();
  w.global({ modelRoles: { default: "p/a", smol: "p/s" }, defaultThinkingLevel: "low" });
  const snapshot = capture((await w.lane()).settings);

  // A reopened process whose CLI/env role override outranks every config overlay.
  const reopened = await w.lane({ modelRoles: { smol: "p/runtime" } });
  expect(await bindModelProfile(modules, reopened.settings, reopened.file, snapshot)).toBe(
    "native model profile drift: role smol=p/runtime (runtime), expected p/s",
  );

  const later = join(w.stateDir, "later.json");
  writeFileSync(later, "{}");
  const shadowed = await w.lane(undefined, [later]);
  expect(await bindModelProfile(modules, shadowed.settings, shadowed.file, snapshot)).toContain(
    "last --config overlay",
  );
  expect(readFileSync(shadowed.file, "utf8")).toBe("{}\n");

  const otherGraph: typeof NativeConfig = await import(
    `${Bun.resolveSync("@oh-my-pi/pi-coding-agent/config/settings", host)}?model-profile-foreign-graph`
  );
  expect(otherGraph.Settings).not.toBe(Settings);
  const foreign = { ...modules, Settings: otherGraph.Settings };
  expect(
    captureModelSnapshot(foreign, reopened.settings, {
      kind: "launch",
      requested: "p/a",
      model,
      configuredThinkingLevel: undefined,
      thinkingLevel: undefined,
    }),
  ).toBe("native settings belong to another OMP module graph");
});

test("a child settings overlay is refused before any root profile file write", async () => {
  const w = world();
  w.global({ modelRoles: { default: "p/a" }, defaultThinkingLevel: "low" });
  const lane = await w.lane();
  const snapshot = capture(lane.settings);
  const child = lane.settings.overlay();
  expect(
    captureModelSnapshot(modules, child, {
      kind: "launch",
      requested: "p/a",
      model,
      configuredThinkingLevel: "low",
      thinkingLevel: "low",
    }),
  ).toContain("child overlay");
  const before = readFileSync(lane.file, "utf8");
  expect(await bindModelProfile(modules, child, lane.file, snapshot)).not.toBeNull();
  expect(readFileSync(lane.file, "utf8")).toBe(before);
});

test("an unknown or different actual model is a HOLD and changes nothing", async () => {
  const w = world();
  w.global({ modelRoles: { default: "p/a" }, defaultThinkingLevel: "low" });
  const lane = await w.lane();
  expect(
    captureModelSnapshot(modules, lane.settings, {
      kind: "launch",
      requested: "p/a",
      model: null,
      configuredThinkingLevel: "low",
      thinkingLevel: "low",
    }),
  ).toContain("actual model is unknown");
  const snapshot = capture(lane.settings);
  expect(await bindModelProfile(modules, lane.settings, lane.file, snapshot)).toBeNull();
  expect(checkModelProfile(modules, lane.settings, lane.file, snapshot, { provider: "p", id: "b" })).toBe(
    "native actual model p/b differs from snapshot p/a",
  );
  expect(checkModelProfile(modules, lane.settings, lane.file, snapshot, undefined)).toBe(
    "native actual model is unknown",
  );
  expect({ ...lane.settings.getModelRoles() }).toEqual({ default: "p/a" });
});

test("switching and releasing remove only this process's pin", async () => {
  const w = world();
  w.global({ modelRoles: { default: "p/g", smol: "p/s" }, defaultThinkingLevel: "low" });
  w.project({ defaultThinkingLevel: "medium" });
  // The runtime default stands for the native `--model` launch override.
  const lane = await w.lane({ modelRoles: { default: "p/a" } });
  const other = await w.lane();
  const snapshot = capture(lane.settings);
  expect(snapshot.provenance.modelRoles).toEqual({ default: "runtime", smol: "global" });
  expect(await bindModelProfile(modules, lane.settings, lane.file, snapshot)).toBeNull();

  // `/new` or a session switch rebinds another snapshot in the same overlay.
  const switched: ModelSnapshot = {
    ...snapshot,
    id: "switched",
    modelRoles: { default: "p/a" },
    defaultThinkingLevel: "high",
  };
  expect(await bindModelProfile(modules, lane.settings, lane.file, switched)).toBeNull();
  expect({ ...lane.settings.getModelRoles() }).toEqual({ default: "p/a" });
  expect(cfgDefaultThinkingLevel.get(lane.settings)).toBe(effort("high"));

  // Native writes the global layer meanwhile; release must keep it.
  w.global({ modelRoles: { default: "p/g2", smol: "p/t" }, defaultThinkingLevel: "low" });
  await lane.settings.reloadFromDisk();
  lane.settings.setModelRole("plan", "p/plan");
  await lane.settings.flush();
  const globalBefore = readFileSync(w.globalFile, "utf8");
  const projectBefore = readFileSync(w.projectFile, "utf8");

  expect(await releaseModelProfile(lane.settings, lane.file)).toBeNull();
  expect(readFileSync(lane.file, "utf8")).toBe("{}\n");
  expect(readFileSync(w.globalFile, "utf8")).toBe(globalBefore);
  expect(readFileSync(w.projectFile, "utf8")).toBe(projectBefore);
  expect({ ...lane.settings.getModelRoles() }).toEqual({ default: "p/a", smol: "p/t", plan: "p/plan" });
  expect(lane.settings.getModelRoleProvenance("default")).toBe("runtime");
  expect(cfgDefaultThinkingLevel.get(lane.settings)).toBe(effort("medium"));
  expect(readFileSync(other.file, "utf8")).toBe("{}\n");
  expect(await releaseModelProfile(other.settings, lane.file)).toContain("last --config overlay");
});

test("native no-thinking resume preserves the pin without accepting auto or concrete selection changes", () => {
  const saved = capture(Settings.isolated({ modelRoles: { default: "p/a" }, defaultThinkingLevel: "low" }));
  for (const selected of [null, "off"]) {
    const snapshot = { ...saved, configuredThinkingLevel: selected };
    for (const actual of [undefined, "off"]) expect(thinkingSelectionDrift(snapshot, actual)).toBeNull();
    for (const actual of ["auto", "low", "high"]) expect(thinkingSelectionDrift(snapshot, actual)).not.toBeNull();
  }
  expect(thinkingSelectionDrift({ ...saved, configuredThinkingLevel: "auto" }, "off")).not.toBeNull();
  expect(thinkingSelectionDrift({ ...saved, configuredThinkingLevel: "high" }, undefined)).not.toBeNull();
});

test("each native start owns a distinct profile overlay, recognized only as its last config file", () => {
  const w = world();
  const first = createModelProfileFile(w.stateDir);
  const second = createModelProfileFile(w.stateDir);
  expect(first).not.toBe(second);
  expect(ownedModelProfileFile(["/elsewhere.yml", first], w.stateDir)).toBe(first);
  expect(ownedModelProfileFile([first, "/elsewhere.yml"], w.stateDir)).toBeNull();
  expect(ownedModelProfileFile([join(w.stateDir, "first.json")], w.stateDir)).toBeNull();
});
