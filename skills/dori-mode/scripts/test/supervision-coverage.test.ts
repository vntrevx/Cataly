import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { freshnessTick } from "../src/freshness.ts";
import type { Runner } from "../src/run.ts";
import { depsFor, newWorld, type TestState, withState } from "./fakes.ts";
import { coverageFixture, git, start } from "./supervision-coverage.fixture.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("1,000 files are covered in bounded windows, including a late change in the final window before any hung verdict", async () => {
  const f = coverageFixture(state);
  const counts: number[] = [];
  for (let window = 0; window < 4; window++) {
    const { result, inspected, stats } = await f.sweep();
    counts.push(stats);
    expect(inspected.size).toBe(window === 3 ? 232 : 256);
    expect(result.hung).toBe(false);
    if (window < 3) expect(result.coverageComplete).toBe(false);
    else expect(result.evidenceError).toBeUndefined();
  }
  expect(Object.keys(f.observation().files)).toHaveLength(1_000);
  expect(new Set(f.refs().map((ref) => ref.ref))).toEqual(new Set(f.paths));
  const last = f.paths[999];
  if (!last) throw new Error("fixture needs its final candidate");
  const before = f.refs().findLast((ref) => ref.ref === last)?.fingerprint;
  for (let window = 0; window < 4; window++) {
    if (window === 3) fs.writeFileSync(last, "changed in the final window");
    const { result, stats } = await f.sweep();
    counts.push(stats);
    expect(result.hung).toBe(false);
    if (window < 3) expect(result.coverageComplete).toBe(false);
    else {
      expect(result.evidenceError).toBeUndefined();
      expect(result.lastEvidenceAt).toBe(new Date(f.clock.at).toISOString());
      expect(f.refs().findLast((ref) => ref.ref === last)?.fingerprint).not.toBe(before);
    }
  }
  let confirmation = 0;
  for (let window = 0; window < 4; window++) {
    const { result, stats, confirmations } = await f.sweep();
    counts.push(stats);
    expect(result.hung).toBe(window === 3);
    // Only the new verdict re-stats every candidate, including the current window, apart from the hash-window cap.
    expect(confirmations).toBe(window === 3 ? 1_000 : 0);
    confirmation += confirmations;
    if (window < 3) expect(result.coverageComplete).toBe(false);
    else expect(result.state).toBe("stalled");
  }
  console.info(
    `bounded coverage: 1000 files, 12 sweeps, lstat+fstat per sweep=${counts.join(",")}, max=${Math.max(...counts)}`,
  );
  console.info(`new-hung confirmation: 1000 files, lstat=${confirmation}, counted apart from the 256-path windows`);
});

test("new candidates do not restart the current snapshot or starve its final window", async () => {
  const f = coverageFixture(state);
  const added: string[] = [];
  for (let window = 0; window < 4; window++) {
    if (window > 0) {
      const path = join(f.scaffold, `!new-${window}.txt`);
      fs.writeFileSync(path, "new candidate");
      added.push(path);
    }
    if (window === 2) {
      const first = added[0];
      if (!first) throw new Error("fixture needs its first new candidate");
      expect(Bun.spawnSync(["git", "-C", f.repo, "add", "--", first]).exitCode).toBe(0);
      expect(
        Bun.spawnSync([
          "git",
          "-C",
          f.repo,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.invalid",
          "commit",
          "--quiet",
          "-m",
          "commit a newly discovered candidate",
        ]).exitCode,
      ).toBe(0);
    }
    expect((await f.sweep()).result.hung).toBe(false);
  }
  expect(new Set(f.refs().map((ref) => ref.ref))).toEqual(new Set(f.paths));
  for (let window = 0; window < 4; window++) expect((await f.sweep()).result.hung).toBe(false);
  expect(new Set(f.refs().map((ref) => ref.ref))).toEqual(new Set([...f.paths, ...added]));
});

test("a real Git failure invalidates the whole cycle without resetting its pending window", async () => {
  const f = coverageFixture(state);
  for (let window = 0; window < 5; window++) await f.sweep();
  const before = f.observation();
  const index = join(f.repo, ".git", "index");
  fs.writeFileSync(index, "invalid index fixture");
  const failed = (await f.sweep()).result;
  expect(failed.evidenceError).toContain("Git evidence observation failed");
  expect(failed.hung).toBe(false);
  expect(f.observation().coverage.pending).toEqual(before.coverage.pending);
  expect(f.observation().files).toEqual(before.files);
  fs.unlinkSync(index);
  for (let window = 0; window < 3; window++) expect((await f.sweep()).result.hung).toBe(false);
  expect(f.observation().coverage.pending).toEqual([]);
  expect(f.observation().lastEvidenceAt).toBe(before.lastEvidenceAt);
  for (let window = 0; window < 4; window++) expect((await f.sweep()).result.hung).toBe(window === 3);
});

test("production freshness keeps a proven stall through partial windows until actual evidence changes", async () => {
  const f = coverageFixture(state);
  const world = newWorld();
  world.panes.push({ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "working" });
  const deps = depsFor(world, f.clock, state.dir, {
    supervision: { hungAfterMinutes: 0, staleAfterMinutes: 0 },
  });
  const lane = { ...f.lane, pane: "w:p7" };
  await deps.registry.write(lane);
  f.reports.report(lane.key, "milestone", "started", f.clock.at);
  const run: Runner = (argv, options) => (argv[0] === "git" ? git(argv, options) : deps.run(argv, options));
  const tick = async (turn: number) => {
    f.clock.at = start + turn * 60_000;
    world.screen = `Working ${21 + turn}m`;
    return f.settle(() => freshnessTick({ ...deps, run }, state.dir));
  };
  for (let turn = 0; turn < 7; turn++) {
    const acts = await tick(turn);
    expect(acts.some((act) => act.kind === "stalled")).toBe(false);
    expect(f.reports.read(lane.key)?.state).toBe("running");
  }
  expect((await tick(7)).some((act) => act.kind === "stalled")).toBe(true);
  expect(f.reports.read(lane.key)?.state).toBe("stalled");
  for (let turn = 8; turn < 12; turn++) {
    expect((await tick(turn)).some((act) => act.kind === "stalled")).toBe(false);
    expect(f.reports.read(lane.key)?.state).toBe("stalled");
  }
  const last = f.paths[999];
  if (!last) throw new Error("fixture needs its final candidate");
  fs.writeFileSync(last, "actual new work");
  for (let turn = 12; turn < 15; turn++) {
    await tick(turn);
    expect(f.reports.read(lane.key)?.state).toBe("stalled");
  }
  await tick(15);
  expect(f.reports.read(lane.key)?.state).toBe("running");
});

test("a failed proved-stall alert retries on the next partial sweep and is then delivered only once", async () => {
  let attempts = 0;
  const f = coverageFixture(state, () => {
    if (++attempts === 1) throw new Error("alert transport unavailable");
  });
  for (let window = 0; window < 7; window++) await f.sweep();
  await expect(f.sweep()).rejects.toThrow("alert delivery failed");
  expect(f.observation().hung).toBe(true);
  const retried = (await f.sweep()).result;
  expect(retried.hung).toBe(false);
  expect(retried.coverageComplete).toBe(false);
  expect(retried.evidenceError).toBeUndefined();
  expect(retried.heldHung).toBe(true);
  expect(retried.alerts).toHaveLength(1);
  expect(attempts).toBe(2);
  for (let window = 0; window < 3; window++) expect((await f.sweep()).result.alerts).toEqual([]);
  expect(attempts).toBe(2);
});

test("retiring 1,000 disappeared candidates uses the same window budget and records every deletion", async () => {
  const f = coverageFixture(state);
  for (let window = 0; window < 4; window++) await f.sweep();
  expect(Object.keys(f.observation().files)).toHaveLength(1_000);
  fs.rmSync(f.scaffold, { recursive: true });
  for (let window = 0; window < 4; window++) {
    const { result, inspected, stats } = await f.sweep();
    expect(inspected.size).toBe(window === 3 ? 232 : 256);
    expect(stats).toBe(inspected.size);
    expect(result.hung).toBe(false);
    if (window < 3) expect(result.coverageComplete).toBe(false);
  }
  expect(Object.keys(f.observation().files)).toHaveLength(0);
  expect(
    new Set(
      f
        .refs()
        .filter((ref) => ref.fingerprint === null)
        .map((ref) => ref.ref),
    ),
  ).toEqual(new Set(f.paths));
  expect((await f.sweep()).result.hung).toBe(true);
});
