import { expect, spyOn } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Runner } from "../src/run.ts";
import type { SupervisionDeps } from "../src/supervision-observe.ts";
import { Supervision } from "../src/supervision.ts";
import { fakeClock, type TestState } from "./fakes.ts";

export const start = Date.parse("2026-01-01T00:00:00Z");
export const git: Runner = async (argv) => {
  const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};

export const coverageFixture = (state: TestState, alert?: SupervisionDeps["alert"]) => {
  const repo = join(state.dir, "repo");
  expect(Bun.spawnSync(["git", "init", "--quiet", repo]).exitCode).toBe(0);
  const scaffold = join(repo, "scaffold");
  fs.mkdirSync(scaffold);
  const paths = Array.from({ length: 1_000 }, (_, index) => join(scaffold, `${String(index).padStart(4, "0")}.txt`));
  for (const path of paths) fs.writeFileSync(path, "before");
  const clock = fakeClock(start);
  const wall = Date.now();
  // Sweeps are a supervision-clock minute apart; the filesystem clock that settles ctime marks moves with them.
  // Without this every mark would stay racy within the test's few real seconds, and no verdict could be confirmed.
  const settle = async <T>(observe: () => Promise<T>): Promise<T> => {
    const now = spyOn(Date, "now").mockImplementation(() => wall + clock.at - start);
    try {
      return await observe();
    } finally {
      now.mockRestore();
    }
  };
  const lane: Lane = {
    key: "coverage-lane",
    title: "bounded file coverage",
    thread: "none",
    brief: "brief.md",
    done: "file done.txt",
    cwd: repo,
    openedAt: new Date(start).toISOString(),
    reportProtocol: "jsonl-v1",
  };
  const reports = new Reports(state.dir);
  let turn = 0;
  const sweep = async () => {
    clock.at = start + turn * 60_000;
    const screen = `Working ${21 + turn++}m`;
    const stat = spyOn(fs, "lstatSync");
    const fstat = spyOn(fs, "fstatSync");
    try {
      // Recreate the supervisor every time: the cursor and quiet-cycle state must survive a restart.
      const result = await settle(() =>
        new Supervision(
          { stateDir: state.dir, clock, run: git, ...(alert === undefined ? {} : { alert }) },
          { hungAfterMinutes: 0, staleAfterMinutes: 0 },
        ).sweep(lane, screen),
      );
      const own = stat.mock.calls.filter(([path]) => String(path).startsWith(`${repo}/`));
      // A new-hung confirmation is the only lstat that tolerates absence; it is counted apart from the window's reads.
      const calls = own.filter(([, options]) => options?.throwIfNoEntry !== false);
      const confirmed = own.filter(([, options]) => options?.throwIfNoEntry === false).map(([path]) => String(path));
      const inspected = new Set(calls.map(([path]) => String(path)));
      const stats = calls.length + fstat.mock.calls.length;
      expect(inspected.size).toBeLessThanOrEqual(256);
      expect(calls.length).toBeLessThanOrEqual(4 * 256);
      expect(fstat.mock.calls.length).toBeLessThanOrEqual(2 * 256);
      expect(stats).toBeLessThanOrEqual(6 * 256);
      // The final check includes the current window, at most once per known candidate; hashing keeps its own cap.
      const known = new Set(Object.keys(observation().files));
      expect(new Set(confirmed).size).toBe(confirmed.length);
      expect(confirmed.every((path) => known.has(path))).toBe(true);
      if (result.hung && confirmed.length) expect(new Set(confirmed)).toEqual(known);
      return { result, inspected, stats, confirmations: confirmed.length };
    } finally {
      stat.mockRestore();
      fstat.mockRestore();
    }
  };
  const refs = () => reports.read(lane.key)?.evidenced.flatMap((event) => event.evidenceRefs ?? []) ?? [];
  const observation = () => JSON.parse(fs.readFileSync(join(state.dir, "lanes", lane.key, "supervision.json"), "utf8"));
  return { repo, paths, scaffold, clock, lane, reports, settle, sweep, refs, observation };
};
