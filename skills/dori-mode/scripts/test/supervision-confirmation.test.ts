import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { fileEvidence, markHolds, pathMark, racyMark } from "../src/evidence.ts";
import { confirmMarks } from "../src/evidence-window.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Runner } from "../src/run.ts";
import { Supervision } from "../src/supervision.ts";
import { depsFor, newWorld, type TestState, withState } from "./fakes.ts";
import { coverageFixture, git, start } from "./supervision-coverage.fixture.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

test("a first-window change after its read withholds the final-window verdict, then shows in the next window", async () => {
  const f = coverageFixture(state);
  for (let window = 0; window < 5; window++) expect((await f.sweep()).result.hung).toBe(false);
  const first = f.paths[0];
  if (!first) throw new Error("fixture needs its first candidate");
  const trusted = f.observation().files[first];
  fs.writeFileSync(first, "changed after its first-window read");
  for (let window = 1; window < 4; window++) {
    const { result, confirmations } = await f.sweep();
    expect(result.hung).toBe(false);
    expect(result.state).toBe("running");
    // The quiet cycle's verdict re-stats the earlier windows and finds the change: unknown, not hung.
    if (window === 3) expect(confirmations).toBeGreaterThan(0);
  }
  // The confirmation neither trusted the new stat nor read the new bytes, and left the next window's schedule alone.
  expect(f.observation().files[first]).toEqual(trusted);
  expect(f.observation().coverage.pending).toEqual([]);
  const resumed = await f.sweep();
  expect(resumed.inspected.size).toBe(256);
  expect(resumed.inspected.has(first)).toBe(true);
  expect(resumed.result.hung).toBe(false);
  expect(resumed.result.lastEvidenceAt).toBe(new Date(f.clock.at).toISOString());
  expect(f.refs()).toContainEqual(fileEvidence(first, f.repo));
  // The real change restarted the quiet clock; the next whole quiet cycle is confirmed and hung.
  for (let window = 1; window < 8; window++) expect((await f.sweep()).result.hung).toBe(window === 7);
});

test("production freshness never reports a stall for a first-window change made after its read", async () => {
  const f = coverageFixture(state);
  const first = f.paths[0];
  if (!first) throw new Error("fixture needs its first candidate");
  const world = newWorld();
  world.panes.push({ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "working" });
  const deps = depsFor(world, f.clock, state.dir, { supervision: { hungAfterMinutes: 0, staleAfterMinutes: 0 } });
  const lane = { ...f.lane, pane: "w:p7" };
  await deps.registry.write(lane);
  f.reports.report(lane.key, "milestone", "started", f.clock.at);
  const run: Runner = (argv, options) => (argv[0] === "git" ? git(argv, options) : deps.run(argv, options));
  const stalls: number[] = [];
  for (let turn = 0; turn < 16; turn++) {
    if (turn === 5) fs.writeFileSync(first, "changed after its first-window read");
    f.clock.at = start + turn * 60_000;
    world.screen = `Working ${21 + turn}m`;
    const acts = await f.settle(() => freshnessTick({ ...deps, run }, state.dir));
    if (acts.some((act) => act.kind === "stalled")) stalls.push(turn);
  }
  expect(stalls).toEqual([15]);
});

test("a new verdict rechecks its current window after the awaited usage command", async () => {
  const f = coverageFixture(state);
  const current = f.paths[768];
  if (!current) throw new Error("fixture needs its final-window candidate");
  let turn = 0;
  const run: Runner = async (argv, options) => {
    if (argv[0] !== "usage") return git(argv, options);
    if (turn === 7) fs.writeFileSync(current, "changed after the current window read");
    return { code: 0, out: '{"tokens":0,"costUsd":0}', err: "" };
  };
  const supervisor = new Supervision(
    { stateDir: state.dir, clock: f.clock, run },
    { hungAfterMinutes: 0, staleAfterMinutes: 0, usageArgv: ["usage"] },
  );
  for (; turn < 8; turn++) {
    f.clock.at = start + turn * 60_000;
    const result = await f.settle(() => supervisor.sweep(f.lane, `Working ${21 + turn}m`));
    expect(result.hung).toBe(false);
    expect(result.heldHung).toBe(false);
    expect(result.state).toBe("running");
  }
  // Confirmation withholds the verdict; only the next scheduled content read may credit the changed bytes.
  expect(f.refs().findLast((ref) => ref.ref === current)?.fingerprint).not.toBe(
    fileEvidence(current, f.repo).fingerprint,
  );
});

test("a touch in an earlier window withholds one verdict and never becomes evidence", async () => {
  const f = coverageFixture(state);
  for (let window = 0; window < 5; window++) await f.sweep();
  const first = f.paths[0];
  if (!first) throw new Error("fixture needs its first candidate");
  const before = f.observation().lastEvidenceAt;
  fs.utimesSync(first, new Date(start), new Date(start));
  for (let window = 1; window < 8; window++) {
    const { result } = await f.sweep();
    // A changed stat is unknown at the first verdict; the next cycle rereads the same bytes and confirms its own.
    expect(result.hung).toBe(window === 7);
    expect(result.lastEvidenceAt).toBe(before);
  }
});

test("a held stall is not re-confirmed by later quiet cycles, and its alert is sent once", async () => {
  const alerts: string[] = [];
  const f = coverageFixture(state, (_lane, message) => void alerts.push(message));
  for (let window = 0; window < 8; window++) {
    const { result, confirmations } = await f.sweep();
    expect(result.hung).toBe(window === 7);
    expect(confirmations).toBe(window === 7 ? 1_000 : 0);
  }
  for (let window = 0; window < 4; window++) {
    const { result, confirmations } = await f.sweep();
    expect(result.heldHung).toBe(true);
    expect(result.alerts).toEqual([]);
    expect(confirmations).toBe(0);
  }
  expect(alerts).toHaveLength(1);
});

test("only a settled mark with an unchanged lstat holds; racy, changed, created, relinked or unreadable is unknown", () => {
  const dir = join(state.dir, "marks");
  const locked = join(dir, "locked");
  fs.mkdirSync(locked, { recursive: true });
  const file = join(dir, "file.txt");
  const inner = join(locked, "inner.txt");
  const link = join(dir, "link");
  const pipe = join(dir, "pipe");
  const missing = join(dir, "missing.txt");
  const underFile = join(file, "child");
  for (const path of [file, inner]) fs.writeFileSync(path, "AAAA");
  fs.symlinkSync("a", link);
  expect(Bun.spawnSync(["mkfifo", pipe]).exitCode).toBe(0);
  // The fixture jumps its read clock; distinguish the later directory write even on a coarse kernel clock.
  fs.utimesSync(dir, new Date(start), new Date(start));
  const settledAt = Date.now() + 10_000;
  const paths = [dir, file, inner, link, pipe, missing, underFile];
  const marks = Object.fromEntries(paths.map((path) => [path, pathMark(path, undefined, settledAt)] as const));
  expect(Object.values(marks).filter(racyMark)).toEqual([]);
  expect(confirmMarks(marks, settledAt)).toEqual({ quiet: true, stats: paths.length });
  // The same stat cannot vouch for bytes read within the coarse second of a write, so no lstat is even needed.
  const racy = pathMark(file, undefined, fs.lstatSync(file).ctimeMs);
  expect(racyMark(racy)).toBe(true);
  expect(markHolds(file, racy, settledAt)).toBe(false);
  // No candidate, including the current window, is exempt from the stable-mark requirement.
  expect(confirmMarks({ ...marks, [file]: racy }, settledAt)).toEqual({ quiet: false, stats: 0 });
  const changes: [string, () => void][] = [
    [dir, () => fs.writeFileSync(join(dir, "added.txt"), "x")],
    [file, () => fs.writeFileSync(file, "BBBBB")],
    [missing, () => fs.writeFileSync(missing, "created")],
    [
      link,
      () => {
        fs.unlinkSync(link);
        fs.symlinkSync("longer-target", link);
      },
    ],
    [inner, () => fs.chmodSync(locked, 0)],
  ];
  const after = Date.now() + 20_000;
  try {
    for (const [path, change] of changes) {
      const mark = marks[path];
      if (!mark) throw new Error(`fixture needs a mark for ${path}`);
      expect(markHolds(path, mark, after)).toBe(true);
      change();
      expect(markHolds(path, mark, after)).toBe(false);
    }
  } finally {
    fs.chmodSync(locked, 0o700);
  }
  for (const path of [pipe, underFile]) {
    const mark = marks[path];
    if (!mark) throw new Error(`fixture needs a mark for ${path}`);
    expect(markHolds(path, mark, after)).toBe(true);
  }
});
