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
      const result = await new Supervision(
        { stateDir: state.dir, clock, run: git, ...(alert === undefined ? {} : { alert }) },
        { hungAfterMinutes: 0, staleAfterMinutes: 0 },
      ).sweep(lane, screen);
      const calls = stat.mock.calls.filter(([path]) => String(path).startsWith(`${repo}/`));
      const inspected = new Set(calls.map(([path]) => String(path)));
      const stats = calls.length + fstat.mock.calls.length;
      expect(inspected.size).toBeLessThanOrEqual(256);
      expect(calls.length).toBeLessThanOrEqual(4 * 256);
      expect(fstat.mock.calls.length).toBeLessThanOrEqual(2 * 256);
      expect(stats).toBeLessThanOrEqual(6 * 256);
      return { result, inspected, stats };
    } finally {
      stat.mockRestore();
      fstat.mockRestore();
    }
  };
  const refs = () => reports.read(lane.key)?.evidenced.flatMap((event) => event.evidenceRefs ?? []) ?? [];
  const observation = () => JSON.parse(fs.readFileSync(join(state.dir, "lanes", lane.key, "supervision.json"), "utf8"));
  return { repo, paths, scaffold, clock, lane, reports, sweep, refs, observation };
};
