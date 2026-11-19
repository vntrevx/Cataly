import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, type DoriConfig } from "../src/config.ts";
import { launchLane, prepareLaunch } from "../src/launch.ts";
import { currentLanePolicy, prepareLanePolicy, readLanePolicy, writeLanePolicy } from "../src/lane-policy-store.ts";
import { Reports } from "../src/reports.ts";
import { runtimesOf } from "../src/run.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState } from "./fakes.ts";

let state: TestState;
let originalBinding: string | undefined;
const NOW = Date.parse("2026-01-01T00:00:00Z");
beforeEach(() => {
  state = withState();
  originalBinding = process.env["DORI_LANE_POLICY"];
});
afterEach(() => {
  state.done();
  if (originalBinding === undefined) delete process.env["DORI_LANE_POLICY"];
  else process.env["DORI_LANE_POLICY"] = originalBinding;
});
const setup = (patch: Partial<DoriConfig> = {}, configured = true) => {
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# policy launch\n");
  const world = newWorld();
  world.screen = "Working";
  const deps = depsFor(world, fakeClock(NOW), state.dir, {
    defaultCwd: state.dir,
    agentCommand: defaultConfig(state.dir).agentCommand,
    goalMarker: "",
    startupWaitSeconds: 0,
    ...(configured ? { lanePolicy: { denyBash: ["sudo"] } } : {}),
    ...patch,
  });
  const runtime = runtimesOf(deps).default;
  const observed = { created: 0, started: 0, env: {} as Readonly<Record<string, string>> };
  runtime.create = async (spec) => {
    observed.created++;
    observed.env = spec.env ?? {};
    return { runtime: "herdr", id: "w:p9" };
  };
  runtime.start = async () => {
    observed.started++;
    if (deps.config.lanePolicy)
      expect(readLanePolicy(observed.env["DORI_LANE_POLICY"] ?? "").snapshot.key).toBe("demo");
    new Reports(state.dir).report("demo", "done", "fixture finished", NOW);
  };
  const input = { key: "demo", title: "fixture", brief, done: "file /test/done" };
  return { deps, runtime, observed, input, file: join(state.dir, "lanes/demo/policy.json") };
};

test("dry run is read-only; real launch hands the same persisted snapshot to its native lane", async () => {
  const f = setup();
  await prepareLaunch(f.deps, f.input);
  expect(f.observed).toMatchObject({ created: 0, started: 0 });
  expect(existsSync(f.file)).toBe(false);
  expect(await f.deps.registry.read("demo")).toBeNull();
  expect((await launchLane(f.deps, f.input)).startup).toBe("STARTUP_DONE demo");
  expect(f.observed).toMatchObject({ created: 1, started: 1 });
  expect(currentLanePolicy(state.dir, "demo").snapshot.denyBash).toEqual(["sudo"]);
});

test("ordinary launches clear an inherited binding instead of protecting an unrelated lane", async () => {
  process.env["DORI_LANE_POLICY"] = "inherited foreign policy";
  const f = setup({}, false);
  expect((await launchLane(f.deps, f.input)).startup).toBe("STARTUP_DONE demo");
  expect(f.observed.env["DORI_LANE_POLICY"]).toBe("");
  expect(existsSync(f.file)).toBe(false);
});

test("configured policy refuses custom agents or missing, conflicting native lane roles before effects", async () => {
  for (const agentCommand of [
    ["custom-agent"],
    ["omp"],
    ["omp", "--dori-role", "dori"],
    ["omp", "--dori-role", "lane", "--dori-role", "dori"],
    ["sh", "-c", "exec omp", "--dori-role", "lane"],
    ["env", "-S", "omp", "--dori-role", "lane"],
    ["npx", "-c", "omp", "--dori-role", "lane"],
    ["omp", "--", "--dori-role", "lane"],
    ["omp", "--model", "--dori-role", "lane"],
    ["omp", "-e", "--dori-role=lane"],
    ["omp", "--dori-role", "lane", "--plan", "--dori-role=dori"],
    ["omp", "--profile", "work", "--dori-role", "lane"],
    ["node", "--eval", "0", "omp", "--dori-role", "lane"],
    ["bun", "--define", "--dori-role=lane", "/opt/omp"],
    ["omp", "--dori-role", "lane", "--resume", "existing-session"],
  ]) {
    const f = setup({ agentCommand });
    await expect(launchLane(f.deps, f.input)).rejects.toThrow("lanePolicy requires");
    expect(f.observed.created).toBe(0);
    expect(existsSync(f.file)).toBe(false);
  }
});

test("configured policy accepts exact direct, environment, package, and source lane entries", async () => {
  for (const agentCommand of [
    defaultConfig(state.dir).agentCommand,
    ["omp", "--dori-role=lane", "{prompt}"],
    ["omp", "Review the brief", "--dori-role", "lane", "{prompt}"],
    ["omp", "--dori-role", "lane", "--", "--resume is literal prompt text"],
    [
      "/release/scripts/consumer/omp",
      "--no-extensions",
      "-e",
      "/release/extension",
      ...defaultConfig(state.dir).agentCommand.slice(1),
    ],
    [
      "/side/releases/current/scripts/consumer/omp",
      "--no-extensions",
      "-e",
      "/side/extension",
      "--config",
      "/side/omp.yml",
      "--config",
      "/side/discovery/omp.yml",
      ...defaultConfig(state.dir).agentCommand.slice(1),
    ],
    ["env", "TERM=xterm", "omp", "--dori-role", "lane"],
    ["npx", "@oh-my-pi/pi-coding-agent@18.20.0", "--dori-role", "lane"],
    ["npm", "exec", "--", "omp", "--dori-role", "lane"],
    ["node", "/opt/@oh-my-pi/pi-coding-agent/dist/cli.js", "--dori-role", "lane"],
    [
      "bun",
      "--preload",
      "/opt/omp/packages/coding-agent/scripts/omp.ts",
      "/opt/omp/packages/coding-agent/src/cli.ts",
      "--dori-role",
      "lane",
    ],
  ]) {
    const f = setup({ agentCommand });
    await expect(prepareLaunch(f.deps, f.input)).resolves.toMatchObject({ lane: { key: "demo" } });
    expect(f.observed.created).toBe(0);
    expect(existsSync(f.file)).toBe(false);
  }
});

test("a losing launch cannot replace the registered winner's policy snapshot", async () => {
  const f = setup();
  const winner = prepareLanePolicy(state.dir, "demo", { denyBash: ["winner"] });
  if (!winner) throw new Error("expected winner policy");
  const create = f.runtime.create;
  f.runtime.create = async (spec) => {
    const ref = await create(spec);
    await f.deps.registry.create({
      ...f.input,
      thread: "none",
      openedAt: new Date(NOW).toISOString(),
      pane: "w:winner",
    });
    writeLanePolicy(winner);
    return ref;
  };
  await expect(launchLane(f.deps, f.input)).rejects.toThrow("already registered");
  expect(f.observed.started).toBe(0);
  expect(currentLanePolicy(state.dir, "demo").snapshot).toEqual(winner.snapshot);
  expect((await f.deps.registry.read("demo"))?.pane).toBe("w:winner");
});

test("snapshot persistence failure leaves an inspectable registered lane but never starts an agent", async () => {
  const f = setup();
  mkdirSync(f.file, { recursive: true });
  await expect(launchLane(f.deps, f.input)).rejects.toThrow();
  expect(f.observed).toMatchObject({ created: 1, started: 0 });
  expect((await f.deps.registry.read("demo"))?.pane).toBe("w:p9");
});
