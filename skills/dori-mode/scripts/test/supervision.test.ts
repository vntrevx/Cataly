import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checkpoints } from "../src/checkpoints.ts";
import { fileEvidence } from "../src/evidence.ts";
import type { Lane } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import type { Runner } from "../src/run.ts";
import { Supervision } from "../src/supervision.ts";
import type { SupervisionOptions } from "../src/supervision-observe.ts";
import { fakeClock, withState } from "./fakes.ts";

const start = Date.parse("2026-10-29T00:00:00Z");

const lane: Lane = {
  key: "demo-lane",
  title: "Demo",
  thread: "",
  brief: "",
  done: "",
  openedAt: new Date(start).toISOString(),
  reportProtocol: "jsonl-v1",
};

const fixture = (options: SupervisionOptions = {}) => {
  const state = withState();
  const clock = fakeClock(start);
  const wall = Date.now();
  const filesystemNow = spyOn(Date, "now").mockImplementation(() => wall + clock.at - start);
  const calls: string[][] = [];
  const alerts: string[] = [];
  let usage = '{"tokens":null,"costUsd":null}';
  let dirty = "";
  const run: Runner = async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "git" && argv.includes("--show-toplevel")) return { code: 0, out: `${state.dir}\n`, err: "" };
    return { code: 0, out: argv[0] === "usage" ? usage : argv[0] === "git" ? dirty : "", err: "" };
  };
  const deps = {
    stateDir: state.dir,
    clock,
    run,
    alert: (_lane: Lane, message: string) => {
      alerts.push(message);
    },
  };
  return {
    ...state,
    done: () => {
      filesystemNow.mockRestore();
      state.done();
    },
    clock,
    calls,
    alerts,
    deps,
    supervisor: new Supervision(deps, options),
    setUsage: (value: string) => {
      usage = value;
    },
    setDirty: (value: string) => {
      dirty = value;
    },
  };
};

describe("supervision", () => {
  test("legacy lanes perform no commands or state writes", async () => {
    const f = fixture({ usageArgv: ["usage"] });
    try {
      expect((await f.supervisor.sweep({ ...lane, reportProtocol: undefined }, "Working 40m")).enabled).toBe(false);
      expect(await f.supervisor.close({ ...lane, reportProtocol: undefined })).toBeNull();
      expect(f.calls).toEqual([]);
      expect(existsSync(join(f.dir, "lanes"))).toBe(false);
    } finally {
      f.done();
    }
  });

  test("growing same timer requires persisted observations and fresh-activity grace", async () => {
    const f = fixture();
    try {
      expect((await f.supervisor.sweep(lane, "Working (21m 0s)")).alerts).toEqual([]);
      f.clock.at += 20 * 60_000;
      const restarted = new Supervision(f.deps);
      expect((await restarted.sweep(lane, "Working (41m 0s)")).state).toBe("stalled");
      expect(f.alerts).toHaveLength(1);
      f.clock.at += 60_000;
      expect((await restarted.sweep(lane, "Working (42m 0s)")).alerts).toEqual([]);
      expect(new Reports(f.dir).read(lane.key)?.state).toBe("stalled");
      expect(f.calls.some((args) => /kill|send-text/.test(args.join(" ")))).toBe(false);
    } finally {
      f.done();
    }
  });

  test("timer reset, frozen timer, and changed timer origin do not mark hung", async () => {
    const f = fixture({ staleAfterMinutes: 0 });
    try {
      await f.supervisor.sweep(lane, "Working 25m");
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 25m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 1m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Working 30m")).alerts).toEqual([]);
      f.clock.at += 60_000;
      expect((await f.supervisor.sweep(lane, "Running 31m")).alerts).toEqual([]);
    } finally {
      f.done();
    }
  });

  test("a minute-rounded timer is hung even when sweeps do not line up with its minute boundary", async () => {
    const f = fixture({ staleAfterMinutes: 0 });
    try {
      await f.supervisor.sweep(lane, "Working 25m");
      f.clock.at += 90_000; // the real timer went 25m10s -> 26m40s and shows 26m
      expect((await f.supervisor.sweep(lane, "Working 26m")).state).toBe("stalled");
    } finally {
      f.done();
    }
  });

  test("a new or reworded report and a checkpoint without evidence do not suppress hung detection", async () => {
    const f = fixture();
    try {
      const reports = new Reports(f.dir);
      await reports.report(lane.key, "milestone", "starting", f.clock.now());
      await f.supervisor.sweep(lane, "Working 21m");
      f.clock.at += 20 * 60_000;
      await reports.report(lane.key, "milestone", "progress, in other words", f.clock.now());
      await new Checkpoints(f.dir).write(
        lane.key,
        { step: "build", result: "ok", evidence: [], remoteEffects: [] },
        f.clock.now(),
      );
      const swept = await f.supervisor.sweep(lane, "Working 41m");
      expect(swept.state).toBe("stalled");
      expect(swept.lastReportAt).toBe(new Date(f.clock.now()).toISOString());
      expect(swept.lastEvidenceAt).toBeNull();
    } finally {
      f.done();
    }
  });

  test("selected evidence moves the evidence clock once per new fingerprint, apart from the report clock", async () => {
    const f = fixture();
    try {
      const reports = new Reports(f.dir);
      const result = join(f.dir, "result.txt");
      writeFileSync(result, "first");
      await reports.report(lane.key, "milestone", "starting", f.clock.now(), undefined, [fileEvidence(result, f.dir)]);
      await f.supervisor.sweep(lane, "Working 21m");
      f.clock.at += 20 * 60_000;
      // The same bytes reported again, after a touch and under new words, are the report clock only.
      utimesSync(result, new Date(f.clock.at), new Date(f.clock.at));
      await reports.report(lane.key, "milestone", "still starting", f.clock.now(), undefined, [
        fileEvidence(result, f.dir),
      ]);
      const repeated = await f.supervisor.sweep(lane, "Working 41m");
      expect(repeated.state).toBe("stalled");
      expect(repeated.lastReportAt).toBe(new Date(f.clock.now()).toISOString());
      expect(repeated.lastEvidenceAt).toBe(new Date(start).toISOString());
      f.clock.at += 60_000;
      writeFileSync(result, "second");
      await reports.report(lane.key, "milestone", "second result", f.clock.now(), undefined, [
        fileEvidence(result, f.dir),
      ]);
      const fresh = await f.supervisor.sweep(lane, "Working 42m");
      expect(fresh).toMatchObject({
        state: "running",
        hung: false,
        lastEvidenceAt: new Date(f.clock.now()).toISOString(),
      });
      // A checkpoint of bytes already reported is not new evidence either.
      f.clock.at += 20 * 60_000;
      const step = { step: "s", result: "r", evidence: ["result.txt"], remoteEffects: [] };
      await new Checkpoints(f.dir).write(
        lane.key,
        { ...step, evidenceRefs: [fileEvidence(result, f.dir)] },
        f.clock.now(),
      );
      expect((await f.supervisor.sweep(lane, "Working 62m")).state).toBe("stalled");
    } finally {
      f.done();
    }
  });

  test("a touch, a same-bytes rewrite or a status-only change is not activity; new bytes are, once", async () => {
    const f = fixture();
    try {
      const path = join(f.dir, "source.ts");
      writeFileSync(path, "first");
      const activeLane = { ...lane, cwd: f.dir, activityPaths: [path] };
      await f.supervisor.sweep(activeLane, "Running 21m");
      utimesSync(path, new Date(f.clock.at), new Date(f.clock.at));
      writeFileSync(path, "first");
      // Both clocks advance after the metadata-only write, so its mark is settled at the quiet verdict.
      f.clock.at += 20 * 60_000;
      f.setDirty(" M source.ts\0?? node_modules/\0");
      expect((await f.supervisor.sweep(activeLane, "Running 41m")).state).toBe("stalled");
      f.clock.at += 60_000;
      writeFileSync(path, "second");
      expect((await f.supervisor.sweep(activeLane, "Running 42m")).state).toBe("running");
      f.clock.at += 20 * 60_000;
      expect((await f.supervisor.sweep(activeLane, "Running 62m")).state).toBe("stalled");
      f.clock.at += 60_000;
      f.setDirty(" M source.ts\0?? added.ts\0");
      writeFileSync(join(f.dir, "added.ts"), "new");
      expect((await f.supervisor.sweep(activeLane, "Running 63m")).state).toBe("running");
      expect(f.calls.every((args) => args[0] === "git")).toBe(true);
    } finally {
      f.done();
    }
  });

  test("a supervision record from before evidence fingerprints is not itself evidence", async () => {
    const f = fixture();
    try {
      await new Reports(f.dir).report(lane.key, "milestone", "starting", start);
      const legacy = { at: start, timer: 21 * 60, timerKind: "working", activity: "{}", activeAt: start, alerts: [] };
      writeFileSync(join(f.dir, "lanes", lane.key, "supervision.json"), JSON.stringify(legacy));
      f.clock.at += 20 * 60_000;
      expect((await f.supervisor.sweep(lane, "Working (41m 0s)")).state).toBe("stalled");
    } finally {
      f.done();
    }
  });

  test("changes under node_modules or outside the lane's cwd are not activity", async () => {
    const f = fixture();
    try {
      const activeLane = { ...lane, cwd: f.dir };
      f.setDirty(" M node_modules/a/index.js\0");
      await f.supervisor.sweep(activeLane, "Running 21m");
      f.clock.at += 20 * 60_000;
      f.setDirty(" M node_modules/b/index.js\0 M ../elsewhere.ts\0");
      expect((await f.supervisor.sweep(activeLane, "Running 41m")).state).toBe("stalled");
    } finally {
      f.done();
    }
  });
});
