import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { EvidenceError, fileEvidence } from "../src/evidence.ts";
import { freshnessTick } from "../src/freshness.ts";
import type { Runner } from "../src/run.ts";
import type { SupervisionOptions } from "../src/supervision-observe.ts";
import { depsFor, newWorld, type TestState, withState } from "./fakes.ts";
import { coverageFixture, git, start } from "./supervision-coverage.fixture.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

/** The production freshness path over the real 1,000-file Git fixture, with hung out of reach. */
const production = async (supervision: SupervisionOptions = {}) => {
  const f = coverageFixture(state);
  const world = newWorld();
  world.panes.push({ pane_id: "w:p7", workspace_id: "w", agent: "omp", agent_status: "working" });
  const deps = depsFor(world, f.clock, state.dir, { supervision: { hungAfterMinutes: 1_000, ...supervision } });
  const lane = { ...f.lane, pane: "w:p7" };
  await deps.registry.write(lane);
  f.reports.report(lane.key, "milestone", "started", start);
  const run: Runner = (argv, options) => (argv[0] === "git" ? git(argv, options) : deps.run(argv, options));
  const tick = async (turn: number) => {
    f.clock.at = start + turn * 60_000;
    world.screen = `Working ${21 + turn}m`;
    return freshnessTick({ ...deps, run }, state.dir);
  };
  const lastError = async () => (await deps.registry.read(lane.key))?.lastSupervisionError;
  return { f, tick, lastError };
};

test("a permanently unreadable first-window file is reported once across cycles until a read of it succeeds", async () => {
  const { f, tick, lastError } = await production({ defaults: { tokens: 1 } });
  const first = f.paths[0];
  if (!first) throw new Error("fixture needs its first candidate");
  const errors: string[] = [];
  const warnings: string[] = [];
  fs.chmodSync(first, 0);
  try {
    // Two whole cycles: the path fails in each first window, and the three later windows never read it.
    for (let turn = 0; turn < 8; turn++) {
      const acts = await tick(turn);
      errors.push(...acts.filter((act) => act.kind === "supervision-error").map((act) => act.detail));
      warnings.push(...acts.filter((act) => act.kind === "warning").map((act) => act.detail));
      expect(await lastError()).toContain("EACCES");
      expect(Object.keys(f.observation().coverage.failed)).toEqual([first]);
    }
    expect(new Set(f.refs().map((ref) => ref.ref)).size).toBe(999);
  } finally {
    fs.chmodSync(first, 0o600);
  }
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain(first);
  expect(errors[0]).toContain("EACCES");
  // The error never hides a budget warning, and the warning is not repeated either.
  expect(warnings).toEqual(["tokens ceiling cannot be checked: usage unavailable"]);
  const recovered = await tick(8);
  expect(recovered.some((act) => act.kind === "supervision-error")).toBe(false);
  expect(await lastError()).toBeUndefined();
  expect(f.observation().coverage.failed).toBeUndefined();
  expect(f.refs()).toContainEqual(fileEvidence(first, f.repo));
});

test("a read denied mid-way, whose recheck is denied too, stays a real failure and is not taken for a race", async () => {
  const { f, tick, lastError } = await production();
  // The last path of the first window, so no other read of this sweep meets the denied directory.
  const target = f.paths[255];
  if (!target) throw new Error("fixture needs a full first window");
  const canonical = fs.realpathSync(target);
  const open = fs.openSync;
  let denied = false;
  // lstat and realpath already succeeded; traverse permission goes before the open, and the recheck lstat fails too.
  const denial = spyOn(fs, "openSync").mockImplementation((path, flags, mode) => {
    if (!denied && String(path) === canonical) {
      denied = true;
      fs.chmodSync(f.scaffold, 0);
    }
    return open(path, flags, mode);
  });
  const acts = await tick(0).finally(() => {
    denial.mockRestore();
    fs.chmodSync(f.scaffold, 0o755);
  });
  expect(denied).toBe(true);
  const reported = acts.filter((act) => act.kind === "supervision-error").map((act) => act.detail);
  expect(reported).toHaveLength(1);
  expect(reported[0]).toContain(target);
  expect(reported[0]).toContain("EACCES");
  expect(Object.keys(f.observation().coverage.failed)).toEqual([target]);
  expect(f.observation().coverage.deferred).toContain(target);
  for (let turn = 1; turn < 4; turn++) {
    expect((await tick(turn)).some((act) => act.kind === "supervision-error")).toBe(false);
    expect(await lastError()).toContain("EACCES");
  }
  await tick(4);
  expect(await lastError()).toBeUndefined();
  expect(f.refs()).toContainEqual(fileEvidence(target, f.repo));
});

test("reads that race a rewrite or a removal are retried as unknown, never reported; explicit evidence refuses them", async () => {
  const { f, tick, lastError } = await production();
  const rewritten = f.paths[1];
  const removed = f.paths[2];
  if (!rewritten || !removed) throw new Error("fixture needs first-window candidates");
  for (let turn = 0; turn < 4; turn++)
    expect((await tick(turn)).some((act) => act.kind === "supervision-error")).toBe(false);
  const trusted = f.observation().files;
  // New sizes make both reads certain in the next first window, whatever the wall clock says.
  fs.writeFileSync(rewritten, "edited before its read");
  fs.writeFileSync(removed, "edited before its removal");
  let raced = 0;
  let changing = false;
  const targets = new Map([
    [fs.realpathSync(rewritten), () => fs.writeFileSync(rewritten, "rewritten while it was read".repeat(++raced))],
    [fs.realpathSync(removed), () => fs.unlinkSync(removed)],
  ]);
  const open = fs.openSync;
  // The change lands right after the reader opens the file, so its bytes no longer match the stat it began from.
  const raceOpen = (path: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode | null): number => {
    const fd = open(path, flags, mode);
    const change = changing ? undefined : targets.get(String(path));
    if (change) {
      changing = true;
      try {
        change();
      } finally {
        changing = false;
      }
    }
    return fd;
  };
  const during = spyOn(fs, "openSync").mockImplementation(raceOpen);
  try {
    const acts = await tick(4);
    expect(acts.some((act) => act.kind === "supervision-error")).toBe(false);
  } finally {
    during.mockRestore();
  }
  expect(raced).toBe(1);
  expect(fs.existsSync(removed)).toBe(false);
  expect(await lastError()).toBeUndefined();
  const unknown = f.observation();
  expect(unknown.evidenceError).toBeUndefined();
  expect(unknown.coverage.failed).toBeUndefined();
  expect(unknown.coverage.changed).toBe(true);
  expect(unknown.coverage.deferred).toEqual(expect.arrayContaining([rewritten, removed]));
  expect(unknown.files[rewritten]).toEqual(trusted[rewritten]);
  expect(unknown.files[removed]).toEqual(trusted[removed]);
  const explicit = spyOn(fs, "openSync").mockImplementation(raceOpen);
  try {
    expect(() => fileEvidence(rewritten, f.repo)).toThrow(EvidenceError);
    expect(() => fileEvidence(rewritten, f.repo)).toThrow("changed while it was read");
  } finally {
    explicit.mockRestore();
  }
  for (let turn = 5; turn < 9; turn++) {
    expect((await tick(turn)).some((act) => act.kind === "supervision-error")).toBe(false);
    expect(await lastError()).toBeUndefined();
  }
  expect(f.refs()).toContainEqual(fileEvidence(rewritten, f.repo));
  expect(f.refs()).toContainEqual({ kind: "file", ref: removed, fingerprint: null });
});
