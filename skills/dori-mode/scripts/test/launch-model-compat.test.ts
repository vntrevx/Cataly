import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { launchLane } from "../src/launch.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, sent, withState, type TestState } from "./fakes.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());
const template = ["sh", "-c", 'exec omp "$@"', "agent", "--model", "{model}", "{prompt}"];
const setup = (requireModelReadback = false, agentCommand: readonly string[] = template) => {
  const world = newWorld();
  const clock = fakeClock(Date.parse("2026-01-01T12:00:00.000Z"));
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "Keep the original brief.\n");
  world.panes = [{ pane_id: "w:p9", workspace_id: "w", agent: "omp", agent_status: "working" }];
  agentIn(world, "w:p9");
  laneState(state.dir, "w:p9", { agentStatus: "working" });
  const base = depsFor(world, clock, state.dir, { agentCommand, requireModelReadback, goalMarker: "" });
  const deps = {
    ...base,
    run: async (argv: readonly string[]) =>
      argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
        ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }), err: "" }
        : base.run(argv),
  };
  return { deps, world, input: { key: "compat", title: "Compatibility", brief, done: "closed acme/app#3" } };
};

test("opaque launch keeps its original prompt and persists an unavailable preflight receipt with one warning", async () => {
  const { deps, world, input } = setup();
  const result = await launchLane(deps, input);
  expect(result.startup).toBe("STARTUP_OK compat w:p9");
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).toStartWith("MODEL_READBACK_WARNING ");
  expect(result.warnings[0]).not.toContain("\n");
  expect(result.lane.modelReadback).toEqual({
    requested: { provider: "anthropic", id: "claude-opus-5-5" },
    observed: null,
    status: "unavailable",
    billing: "unknown",
    checkedAt: "2026-01-01T12:00:00.000Z",
    source: "launch-preflight",
    reason: "Opaque agentCommand: the native argument boundary cannot be located before its initial prompt",
  });
  expect((await deps.registry.read("compat"))?.modelReadback).toEqual(result.lane.modelReadback);
  const command = world.calls.find((argv) => argv[2] === "run")?.at(-1);
  expect(command).toContain('exec omp "$@"');
  expect(command).toContain("Read and execute");
  expect(command).not.toContain("--dori-launch-model");
  expect(sent(world)).toEqual([]);
});

test("strict opaque launch refuses before creating a pane or registry entry and explains the repair", async () => {
  const { deps, world, input } = setup(true);
  await expect(launchLane(deps, input)).rejects.toThrow("\nFix: use an explicit OMP executable");
  expect(world.calls).toEqual([]);
  expect(await deps.registry.read("compat")).toBeNull();
});

const nonInteractive = [
  ["-p"],
  ["--print"],
  ["--print=false"],
  ["--mode", "json"],
  ["--mode=rpc"],
  ["--mode=rpc-ui"],
  ["--mode=acp"],
].map((flags) => [flags]);

test.each(nonInteractive)("non-interactive %j preserves the original prompt by default", async (flags) => {
  const { deps, world, input } = setup(false, ["omp", ...flags, "--model", "{model}", "{prompt}"]);
  const result = await launchLane(deps, input);
  expect(result.startup).toBe("STARTUP_OK compat w:p9");
  expect(result.lane.modelReadback).toMatchObject({
    source: "launch-preflight",
    status: "unavailable",
    observed: null,
  });
  expect(result.lane.modelReadback?.reason).toContain("Non-interactive");
  expect(result.warnings).toHaveLength(1);
  expect(result.warnings[0]).not.toContain("\n");
  const command = world.calls.find((argv) => argv[2] === "run")?.at(-1);
  expect(command).toContain("Read and execute");
  expect(command).not.toContain("--dori-launch-model");
  expect(sent(world)).toEqual([]);
});

test.each(nonInteractive)("strict non-interactive %j refuses before opening a pane", async (flags) => {
  const { deps, world, input } = setup(true, ["omp", ...flags, "--model", "{model}", "{prompt}"]);
  await expect(launchLane(deps, input)).rejects.toThrow("interactive text mode");
  expect(world.calls).toEqual([]);
  expect(await deps.registry.read("compat")).toBeNull();
});

test("strict readback is opt-in and malformed configuration cannot silently disable it", async () => {
  const path = join(state.dir, "config.json");
  writeFileSync(path, "{}");
  expect((await loadConfig(path, state.dir)).requireModelReadback).toBe(false);
  for (const value of [true, false]) {
    writeFileSync(path, JSON.stringify({ requireModelReadback: value }));
    expect((await loadConfig(path, state.dir)).requireModelReadback).toBe(value);
  }
  for (const value of ["false", 0, null, {}]) {
    writeFileSync(path, JSON.stringify({ requireModelReadback: value }));
    await expect(loadConfig(path, state.dir)).rejects.toThrow("invalid requireModelReadback");
  }
});
