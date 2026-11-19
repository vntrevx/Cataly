import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checkpoints } from "../src/checkpoints.ts";
import { fileEvidence, novelEvidence } from "../src/evidence.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Runner } from "../src/run.ts";
import { Supervision } from "../src/supervision.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState } from "./fakes.ts";

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
  key: "review-lane",
  title: "evidence review",
  thread: "none",
  brief: "brief.md",
  done: "file done.txt",
  cwd: state.dir,
  openedAt: new Date(start).toISOString(),
  reportProtocol: "jsonl-v1",
});
const git: Runner = async (argv) => {
  const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};

for (const selectedBy of ["report", "checkpoint"] as const) {
  test(`a file already observed through Git is not new evidence in its first ${selectedBy}`, async () => {
    const repo = join(state.dir, "repo");
    expect(Bun.spawnSync(["git", "init", "--quiet", repo]).exitCode).toBe(0);
    const source = join(repo, "source.txt");
    writeFileSync(source, "A");
    const clock = observedClock();
    const reports = new Reports(state.dir);
    const active = { ...lane(), cwd: repo };
    const supervision = new Supervision({ stateDir: state.dir, clock, run: git });
    await reports.report(active.key, "milestone", "started", clock.at);
    await supervision.sweep(active, "Working 21m");
    clock.at += 5 * 60_000;
    writeFileSync(source, "B");
    const observed = await supervision.sweep(active, "Working 26m");
    const fingerprint = fileEvidence(source, repo);
    expect(novelEvidence(reports.read(active.key)?.evidenced ?? [], [fingerprint])).toEqual([]);
    clock.at += 5 * 60_000;
    if (selectedBy === "report")
      await reports.report(active.key, "milestone", "B is ready", clock.at, undefined, [fingerprint]);
    else
      await new Checkpoints(state.dir).write(
        active.key,
        { step: "B", result: "ready", evidence: [source], remoteEffects: [], evidenceRefs: [fingerprint] },
        clock.at,
      );
    const repeated = await supervision.sweep(active, "Working 31m");
    expect(repeated.lastEvidenceAt).toBe(observed.lastEvidenceAt);
    clock.at += 15 * 60_000;
    expect((await supervision.sweep(active, "Working 46m")).state).toBe("stalled");
  });
}

test("deletion and recreation change the clock, but committing unchanged bytes does not", async () => {
  const repo = join(state.dir, "repo");
  expect(Bun.spawnSync(["git", "init", "--quiet", repo]).exitCode).toBe(0);
  const source = join(repo, "source.txt");
  writeFileSync(source, "A");
  const clock = observedClock();
  const supervisor = new Supervision({ stateDir: state.dir, clock, run: git });
  const active = { ...lane(), cwd: repo };
  await supervisor.sweep(active, "Working 21m");
  clock.at += 5 * 60_000;
  unlinkSync(source);
  const removed = await supervisor.sweep(active, "Working 26m");
  expect(removed.lastEvidenceAt).toBe(new Date(clock.at).toISOString());
  clock.at += 5 * 60_000;
  expect((await supervisor.sweep(active, "Working 31m")).lastEvidenceAt).toBe(removed.lastEvidenceAt);
  writeFileSync(source, "A");
  clock.at += 5 * 60_000;
  const restored = await supervisor.sweep(active, "Working 36m");
  expect(restored.lastEvidenceAt).toBe(new Date(clock.at).toISOString());
  expect(Bun.spawnSync(["git", "-C", repo, "add", "source.txt"]).exitCode).toBe(0);
  expect(
    Bun.spawnSync([
      "git",
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]).exitCode,
  ).toBe(0);
  clock.at += 5 * 60_000;
  expect((await supervisor.sweep(active, "Working 41m")).lastEvidenceAt).toBe(restored.lastEvidenceAt);
});

test("a real non-repository cwd still observes activity paths and reaches the hung threshold", async () => {
  const source = join(state.dir, "result.txt");
  writeFileSync(source, "actual result");
  const clock = observedClock();
  const supervisor = new Supervision({ stateDir: state.dir, clock, run: git }, { activityPaths: [source] });
  expect((await supervisor.sweep(lane(), "Working 21m")).state).toBe("running");
  clock.at += 20 * 60_000;
  expect((await supervisor.sweep(lane(), "Working 41m")).state).toBe("stalled");
});

for (const reached of [false, true]) {
  test(`the production freshness path exposes Git failure and ${reached ? "reached" : "unavailable"} ceilings`, async () => {
    mkdirSync(join(state.dir, ".git"));
    const world = newWorld();
    world.screen = "Working 21m";
    world.panes.push({ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "working" });
    const deps = depsFor(world, fakeClock(start), state.dir, {
      supervision: { defaults: { tokens: 1, ...(reached ? { wallMinutes: 0 } : {}) } },
    });
    const active = { ...lane(), pane: "w:p7" };
    await deps.registry.write(active);
    await new Reports(state.dir).report(active.key, "milestone", "started", start);
    const original = deps.run;
    const run: Runner = async (argv, options) =>
      argv[0] === "git" && argv.includes("status")
        ? { code: 128, out: "", err: "repository unavailable" }
        : original(argv, options);
    const acts = await freshnessTick({ ...deps, run }, state.dir);
    expect(acts.some((act) => act.kind === "supervision-error" && act.detail.includes("Git evidence"))).toBe(true);
    expect(acts.some((act) => act.detail.includes("tokens ceiling cannot be checked"))).toBe(true);
    if (reached)
      expect(acts.some((act) => act.kind === "blocked" && act.detail.includes("wallMinutes ceiling reached"))).toBe(
        true,
      );
    else expect(acts.some((act) => act.kind === "warning")).toBe(true);
  });
}

test("an oversized untracked directory advances a partial window without declaring complete coverage", async () => {
  const repo = join(state.dir, "repo");
  expect(Bun.spawnSync(["git", "init", "--quiet", repo]).exitCode).toBe(0);
  mkdirSync(join(repo, "out"));
  for (let index = 0; index < 257; index++) writeFileSync(join(repo, "out", `${index}.txt`), "result");
  const supervisor = new Supervision({ stateDir: state.dir, clock: fakeClock(start), run: git });
  const result = await supervisor.sweep({ ...lane(), cwd: repo }, "Working 21m");
  expect(result.coverageComplete).toBe(false);
  expect(result.evidenceError).toBeUndefined();
  expect(result.hung).toBe(false);
  const observation = JSON.parse(readFileSync(join(state.dir, "lanes/review-lane/supervision.json"), "utf8"));
  expect(Object.keys(observation.files)).toHaveLength(256);
  expect(
    new Reports(state.dir).read("review-lane")?.evidenced.flatMap((event) => event.evidenceRefs ?? []),
  ).toHaveLength(256);
});

test("a package cwd resolves Git paths from the root and ignores sibling packages", async () => {
  const repo = join(state.dir, "repo");
  expect(Bun.spawnSync(["git", "init", "--quiet", repo]).exitCode).toBe(0);
  const cwd = join(repo, "packages", "owned");
  const sibling = join(repo, "packages", "sibling");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(sibling);
  const source = join(cwd, "source.txt");
  const outside = join(sibling, "outside.txt");
  writeFileSync(source, "A");
  writeFileSync(outside, "other");
  const clock = observedClock();
  const supervisor = new Supervision({ stateDir: state.dir, clock, run: git });
  const active = { ...lane(), cwd };
  const first = await supervisor.sweep(active, "Working 21m");
  expect(first.evidenceError).toBeUndefined();
  expect(new Reports(state.dir).read(active.key)?.evidenced.flatMap((event) => event.evidenceRefs ?? [])).toEqual([
    fileEvidence(source, cwd),
  ]);
  clock.at += 20 * 60_000;
  writeFileSync(outside, "a sibling change");
  expect((await supervisor.sweep(active, "Working 41m")).state).toBe("stalled");
  clock.at += 60_000;
  writeFileSync(source, "B");
  const changed = await supervisor.sweep(active, "Working 42m");
  expect(changed.state).toBe("running");
  expect(changed.lastEvidenceAt).toBe(new Date(clock.at).toISOString());
});

test("a directory replaced by a file retires the old child as absent, not permanently unknown", async () => {
  const repo = join(state.dir, "repo");
  expect(Bun.spawnSync(["git", "init", "--quiet", repo]).exitCode).toBe(0);
  const directory = join(repo, "out");
  mkdirSync(directory);
  const child = join(directory, "result.txt");
  writeFileSync(child, "A");
  const clock = observedClock();
  const supervisor = new Supervision({ stateDir: state.dir, clock, run: git });
  const active = { ...lane(), cwd: repo };
  await supervisor.sweep(active, "Working 21m");
  rmSync(directory, { recursive: true });
  writeFileSync(directory, "a regular file now");
  clock.at += 60_000;
  const changed = await supervisor.sweep(active, "Working 22m");
  expect(changed.evidenceError).toBeUndefined();
  expect(changed.lastEvidenceAt).toBe(new Date(clock.at).toISOString());
  expect(
    new Reports(state.dir).read(active.key)?.evidenced.flatMap((event) => event.evidenceRefs ?? []),
  ).toContainEqual({
    kind: "file",
    ref: child,
    fingerprint: null,
  });
  clock.at += 60_000;
  const repeated = await supervisor.sweep(active, "Working 23m");
  expect(repeated.evidenceError).toBeUndefined();
  expect(repeated.lastEvidenceAt).toBe(changed.lastEvidenceAt);
});
