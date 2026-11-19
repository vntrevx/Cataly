import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Runner } from "../src/run.ts";
import { Supervision } from "../src/supervision.ts";
import { fakeClock, type TestState, withState } from "./fakes.ts";

let state: TestState;
const start = Date.parse("2026-01-01T00:00:00Z");
let restoreClock: (() => void) | undefined;
const observedClock = () => {
  const clock = fakeClock(start);
  const wall = Date.now();
  // A simulated supervision minute is also a filesystem-observation minute; no real-time sleep is needed.
  const now = spyOn(Date, "now").mockImplementation(() => wall + clock.at - start);
  restoreClock = () => now.mockRestore();
  return clock;
};
beforeEach(() => {
  state = withState();
});
afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
  state.done();
});

const lane = (): Lane => ({
  key: "evidence-lane",
  title: "evidence",
  thread: "none",
  brief: "brief.md",
  done: "file done.txt",
  cwd: state.dir,
  openedAt: new Date(start).toISOString(),
  reportProtocol: "jsonl-v1",
});

test("a failed Git observation does not turn missing output into evidence or change the clock", async () => {
  mkdirSync(join(state.dir, ".git"));
  const clock = observedClock();
  let failed = false;
  const run: Runner = async (argv) =>
    failed
      ? { code: 128, out: "", err: "repository unavailable" }
      : { code: 0, out: argv.includes("--show-toplevel") ? `${state.dir}\n` : " M source.ts\0", err: "" };
  writeFileSync(join(state.dir, "source.ts"), "unchanged");
  const supervisor = new Supervision({ stateDir: state.dir, clock, run });
  expect((await supervisor.sweep(lane(), "Working 21m")).evidenceError).toBeUndefined();
  const observation = join(state.dir, "lanes/evidence-lane/supervision.json");
  const before = JSON.parse(readFileSync(observation, "utf8"));
  failed = true;
  clock.at += 20 * 60_000;
  const result = await supervisor.sweep(lane(), "Working 41m");
  expect(result.evidenceError).toContain("Git evidence observation failed");
  expect(result.hung).toBe(false);
  const after = JSON.parse(readFileSync(observation, "utf8"));
  for (const field of ["files", "activity", "activeAt", "lastEvidenceAt"]) expect(after[field]).toEqual(before[field]);
  expect(after.evidenceError).toBe(result.evidenceError);
  expect(new Reports(state.dir).read("evidence-lane")?.lastReport).toBeNull();
});

test("a failed evidence read cannot suppress a reached budget or its alert", async () => {
  mkdirSync(join(state.dir, ".git"));
  const clock = observedClock();
  const run: Runner = async () => ({ code: 128, out: "", err: "repository unavailable" });
  const alerts: string[] = [];
  const supervisor = new Supervision(
    { stateDir: state.dir, clock, run, alert: (_lane, message) => void alerts.push(message) },
    { defaults: { wallMinutes: 0 } },
  );
  const result = await supervisor.sweep(lane(), "Working 21m");
  expect(result.evidenceError).toContain("Git evidence observation failed");
  expect(result.alerts).toEqual(["wallMinutes ceiling reached (0)"]);
  expect(new Reports(state.dir).read("evidence-lane")?.state).toBe("blocked");
  expect(alerts).toEqual(["wallMinutes ceiling reached (0)"]);
});

test("new bytes inside an untracked directory are observed through the actual Git command", async () => {
  const repo = join(state.dir, "repo");
  expect(Bun.spawnSync(["git", "init", "--quiet", repo]).exitCode).toBe(0);
  mkdirSync(join(repo, "out"));
  writeFileSync(join(repo, "out/result.txt"), "first");
  const clock = observedClock();
  const run: Runner = async (argv) => {
    const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
  };
  const supervisor = new Supervision({ stateDir: state.dir, clock, run });
  const active = { ...lane(), cwd: repo };
  await supervisor.sweep(active, "Working 21m");
  clock.at += 20 * 60_000;
  writeFileSync(join(repo, "out/result.txt"), "other");
  expect((await supervisor.sweep(active, "Working 41m")).state).toBe("running");
  clock.at += 20 * 60_000;
  expect((await supervisor.sweep(active, "Working 61m")).state).toBe("stalled");
});
