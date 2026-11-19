import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PaneState } from "../src/lane-state.ts";
import { newWorld, withState, type TestState, type World } from "./fakes.ts";
import { startOmpLane, type OmpLaunchOptions } from "./omp-launch-fixture.ts";

let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const start = async (key: string, patch: Partial<PaneState> = {}, options: OmpLaunchOptions = {}) => {
  const launched = await startOmpLane(state, key, patch, options);
  world = launched.world;
  return launched.result;
};

test("OMP startup reads its own live goal and session launch prompt even when the footer is truncated", async () => {
  const active = await start("active-lane");
  expect(active.startup).toBe("STARTUP_OK active-lane w:p9");
  const command = world.calls.find((argv) => argv[2] === "run")?.at(-1) ?? "";
  expect(command).toBe(
    `omp --dori-launch-model=anthropic/claude-opus-5-5 --dori-role=lane --model=anthropic/claude-opus-5-5 --config=${active.lane.modelProfileFile}`,
  );
  expect(command).not.toContain("ulw set goal and work");
  expect(world.calls.filter((argv) => argv[2] === "send-text")).toHaveLength(1);
  expect(world.calls.find((argv) => argv[2] === "send-text")?.[4]).toContain("ulw set goal and work");
  expect((await start("package-lane", {}, { packageCommand: true })).startup).toBe("STARTUP_OK package-lane w:p9");
  const overridden = await start("override-lane", {}, { model: "provider/explicit-model" });
  expect(overridden.lane.model).toBe("provider/explicit-model");
  expect(world.calls.find((argv) => argv[2] === "run")?.at(-1)).toContain("--model=provider/explicit-model");
  expect((await start("slow-lane", { goal: { status: "none" } }, { slow: true })).startup).toBe(
    "STARTUP_OK slow-lane w:p9",
  );
  expect((await start("slow-cli", {}, { startDelay: 15_000 })).startup).toBe("STARTUP_OK slow-cli w:p9");
});

test("a quoted omo footer, another lane's prompt or an old session cannot satisfy OMP's startup goal", async () => {
  for (const status of ["none", "paused", "blocked", "complete", "dropped"] as const) {
    const key = `${status}-lane`;
    expect((await start(key, { goal: { status } }, { screen: "prompt\nPursuing goal (1m)" })).startup).toStartWith(
      `STARTUP_NO_GOAL ${key} w:p9`,
    );
  }
  expect((await start("foreign-lane", {}, { firstLane: "other-lane" })).startup).toStartWith(
    "STARTUP_NO_GOAL foreign-lane w:p9",
  );
  expect((await start("stale-lane", {}, { at: "2026-01-01T11:50:00.000Z" })).startup).toStartWith(
    "STARTUP_NO_GOAL stale-lane w:p9",
  );
  expect((await start("lead-role", { role: "dori" })).startup).toStartWith("STARTUP_MODEL_HOLD lead-role w:p9");
  expect(world.calls.filter((argv) => argv[2] === "send-text")).toHaveLength(0);
  expect((await start("dead-writer", { pid: 77 })).startup).toStartWith("STARTUP_UNCONFIRMED dead-writer w:p9");
  expect((await start("approval-lane", { approvalPending: true })).startup).toStartWith(
    "STARTUP_UNCONFIRMED approval-lane w:p9",
  );
  expect((await start("suspended-lane", {}, { suspended: true })).startup).toStartWith(
    "STARTUP_UNCONFIRMED suspended-lane w:p9",
  );
});

test("OMP extension, flag and model failures retain STARTUP_ERROR classifications", async () => {
  const failures = [
    ["flag-lane", "Error: unknown flag: --dori-role", "unknown flag: "],
    ["extension-lane", "Failed to load extension /local/omp-dori: boom", "Failed to load extension"],
    ["trusted-lane", "Trusted extension failed to load: boom", "Trusted extension failed to load"],
    ["model-lane", "Model provider/missing not found", "Model provider/missing not found"],
    ["empty-models", "No models available.", "No models available"],
  ];
  // A failed start sets no goal for this launch.
  for (const [key = "", screen = "", phrase = ""] of failures)
    expect((await start(key, { goal: { status: "none" } }, { screen })).startup).toBe(
      `STARTUP_ERROR ${key} w:p9: ${phrase}`,
    );
});

test("a working OMP lane with its own active goal is not failed by an old error its first screen quotes", async () => {
  const screen = "Working on logs\nFailed to load extension /example: old error copied for analysis\nWorking on logs";
  expect((await start("quoting-lane", { goal: { status: "none" } }, { screen, slow: true })).startup).toBe(
    "STARTUP_OK quoting-lane w:p9",
  );
  expect((await start("failing-lane", { goal: { status: "none" } }, { screen })).startup).toBe(
    "STARTUP_ERROR failing-lane w:p9: Failed to load extension",
  );
});

test("slow OMP readiness is waited for even with an active goal; neither goals nor opt-out bypass readiness", async () => {
  expect((await start("slow-status", {}, { unreportedUntil: 100_000 })).startup).toBe("STARTUP_OK slow-status w:p9");
  const reads = world.calls.filter((argv) => argv[2] === "read" && argv[5] === "40");
  expect(reads).toHaveLength(9);
  expect(reads.every((argv) => argv.at(-1) === "recent-unwrapped")).toBe(true);
  for (const goalMarker of ["Pursuing goal", ""]) {
    const key = `unready-${goalMarker ? "goal" : "optout"}`;
    const result = await start(key, {}, { unreportedUntil: 999_000, startupWaitSeconds: 60, goalMarker });
    expect(result.startup).toStartWith(`STARTUP_UNCONFIRMED ${key} w:p9: no ready agent status (unknown) after 60 s;`);
  }
  expect((await start("late-no-goal", { goal: { status: "none" } }, { unreportedUntil: 100_000 })).startup).toStartWith(
    "STARTUP_NO_GOAL late-no-goal w:p9: the agent is running but shows no goal after 181 s;",
  );
});

test("finished OMP lanes disappearing during either startup check are done, not failed or relaunched", async () => {
  for (const after of [20_000, 30_000])
    for (const kind of ["closed", "verified-done", "journal"] as const)
      for (const readFailure of ["", "pane_not_found"]) {
        const key = `finished-${after}-${kind}-${readFailure ? "read" : "probe"}`;
        expect((await start(key, { goal: { status: "none" } }, { finish: { after, kind, readFailure } })).startup).toBe(
          `STARTUP_DONE ${key}`,
        );
        expect(world.calls.filter((argv) => argv[2] === "run")).toHaveLength(1);
      }
});

test("a completed lane does not hide a real runtime read failure", async () => {
  await expect(
    start("broken-read", {}, { finish: { after: 20_000, kind: "closed", readFailure: "server unavailable" } }),
  ).rejects.toThrow("server unavailable");
});
