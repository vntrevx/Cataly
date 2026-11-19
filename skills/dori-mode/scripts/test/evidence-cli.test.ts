import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Checkpoints } from "../src/checkpoints.ts";
import { Reports } from "../src/reports.ts";
import { type TestState, withState } from "./fakes.ts";

const cli = resolve(import.meta.dir, "../src/cli.ts");
let state: TestState;
beforeEach(() => {
  state = withState();
  mkdirSync(join(state.dir, "state/lanes"), { recursive: true });
  writeFileSync(
    join(state.dir, "config.json"),
    JSON.stringify({ runtime: "herdr", stateDir: join(state.dir, "state"), ompUlwPath: "" }),
  );
  writeFileSync(
    join(state.dir, "state/lanes/fixture.json"),
    JSON.stringify({
      key: "fixture",
      title: "evidence",
      brief: "brief",
      done: "file proof",
      thread: "none",
      cwd: state.dir,
      openedAt: "2026-01-01T00:00:00Z",
      status: "working",
    }),
  );
});
afterEach(() => state.done());

const dori = (...args: string[]) => {
  const result = Bun.spawnSync([process.execPath, cli, ...args], {
    cwd: state.dir,
    env: {
      HOME: state.dir,
      PATH: process.env["PATH"],
      DORI_CONFIG: join(state.dir, "config.json"),
      DORI_RUNTIME: "herdr",
      DORI_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
    },
    timeout: 10_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
};

test("report and checkpoint --evidence-file record the file's fingerprint; the printed line is unchanged", () => {
  writeFileSync(join(state.dir, "result.txt"), "built");
  const report = dori("report", "fixture", "--kind", "milestone", "--text", "built", "--evidence-file", "result.txt");
  expect(report).toEqual({ code: 0, out: "[REPORT] fixture | milestone | built\n", err: "" });
  const stateDir = join(state.dir, "state");
  const refs = new Reports(stateDir).read("fixture")?.lastReport?.evidenceRefs;
  expect(refs).toEqual([{ kind: "file", ref: expect.stringMatching(/result\.txt$/), fingerprint: expect.any(String) }]);
  const step = ["checkpoint", "fixture", "--step", "build", "--result", "ok", "--evidence", "result.txt"];
  expect(dori(...step, "--evidence-file", "result.txt").code).toBe(0);
  expect(new Checkpoints(stateDir).read("fixture")[0]?.evidenceRefs).toEqual(refs);
});

test("a checkpoint retry returns its durable receipt after the evidence file was removed", () => {
  const file = join(state.dir, "temporary.txt");
  writeFileSync(file, "completed");
  const step = [
    "checkpoint",
    "fixture",
    "--step",
    "done",
    "--result",
    "completed",
    "--evidence",
    "temporary.txt",
    "--remote-effect",
    "receipt-1",
    "--evidence-file",
    "temporary.txt",
  ];
  const first = dori(...step);
  expect(first.code).toBe(0);
  const journal = new Checkpoints(join(state.dir, "state")).path("fixture");
  const before = readFileSync(journal, "utf8");
  unlinkSync(file);
  const retry = dori(...step);
  expect(retry.code).toBe(0);
  expect(JSON.parse(retry.out)).toEqual({ ...JSON.parse(first.out), unchanged: true });
  expect(readFileSync(journal, "utf8")).toBe(before);
  const conflict = dori(...step.map((arg) => (arg === "completed" ? "different" : arg)));
  expect(conflict.code).toBe(1);
  expect(conflict.err).toContain("conflicting checkpoint step: done");
});

test("a FIFO given as --evidence-file is refused at once and records nothing", () => {
  expect(Bun.spawnSync(["mkfifo", join(state.dir, "pipe")]).exitCode).toBe(0);
  const report = dori("report", "fixture", "--kind", "milestone", "--text", "x", "--evidence-file", "pipe");
  expect(report.code).toBe(1);
  expect(report.err).toContain("evidence file pipe is not a regular file");
  expect(report.out).toBe("");
  const journal = new Reports(join(state.dir, "state")).path("fixture");
  expect(existsSync(journal) ? readFileSync(journal, "utf8") : "").toBe("");
});
