import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checkpoints } from "../src/checkpoints.ts";
import { evidenceClock, fileEvidence, novelEvidence, type EvidenceRef } from "../src/evidence.ts";
import { Reports } from "../src/reports.ts";
import { Supervision } from "../src/supervision.ts";
import { lane as evidenceLane } from "./evidence-sequence-fixture.ts";
import { fakeClock, withState } from "./fakes.ts";

test.each(["checkpoint", "report"] as const)(
  "%s A followed by the other journal's B in the same millisecond keeps unchanged B quiet",
  async (first) => {
    const state = withState();
    try {
      const clock = fakeClock(Date.parse("2026-01-01T00:00:00Z"));
      const at = new Date(clock.at).toISOString();
      const key = "same-time";
      const source = join(state.dir, "result.txt");
      const reports = new Reports(state.dir);
      const checkpoints = new Checkpoints(state.dir);
      const accept = async (journal: "checkpoint" | "report", text: string, ref: EvidenceRef) => {
        if (journal === "report") await reports.report(key, "milestone", text, clock.at, undefined, [ref]);
        else
          await checkpoints.write(
            key,
            { step: text, result: text, evidence: [source], remoteEffects: [], evidenceRefs: [ref] },
            clock.at,
          );
      };
      writeFileSync(source, "A");
      await accept(first, "A", fileEvidence(source, state.dir));
      writeFileSync(source, "B");
      const b = fileEvidence(source, state.dir);
      await accept(first === "checkpoint" ? "report" : "checkpoint", "B", b);
      // This is the source-grouped merge used by the production verdict, not acceptance order.
      const records = [...(reports.read(key)?.evidenced ?? []), ...checkpoints.read(key)];
      expect(records.map((record) => record.at)).toEqual([at, at]);
      clock.at += 60_000;
      const supervisor = new Supervision(
        {
          stateDir: state.dir,
          clock,
          run: async (argv) => {
            const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe" });
            return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
          },
        },
        { activityPaths: [source] },
      );
      const result = await supervisor.sweep({ ...evidenceLane(state.dir), key, openedAt: at }, "Working 1m");
      expect(result.lastEvidenceAt).toBe(at);
      expect(novelEvidence(records, [b])).toEqual([]);
      expect(evidenceClock(records)).toEqual({ lastEvidenceAt: at, lastEvidence: b });
      expect(reports.read(key)?.evidenced).toHaveLength(1);
    } finally {
      state.done();
    }
  },
);

test.each([
  { first: "checkpoint", next: "A" },
  { first: "report", next: "A" },
  { first: "checkpoint", next: "C" },
  { first: "report", next: "C" },
] as const)(
  "$first A/B at the same millisecond still detects later actual change to $next",
  async ({ first, next }) => {
    const state = withState();
    try {
      const clock = fakeClock(Date.parse("2026-01-01T00:00:00Z"));
      const at = new Date(clock.at).toISOString();
      const key = "same-time";
      const source = join(state.dir, "result.txt");
      const reports = new Reports(state.dir);
      const checkpoints = new Checkpoints(state.dir);
      const accept = async (journal: "checkpoint" | "report", text: string) => {
        const ref = fileEvidence(source, state.dir);
        if (journal === "report") await reports.report(key, "milestone", text, clock.at, undefined, [ref]);
        else
          await checkpoints.write(
            key,
            { step: text, result: text, evidence: [source], remoteEffects: [], evidenceRefs: [ref] },
            clock.at,
          );
      };
      writeFileSync(source, "A");
      await accept(first, "A");
      writeFileSync(source, "B");
      await accept(first === "checkpoint" ? "report" : "checkpoint", "B");
      const supervisor = new Supervision(
        {
          stateDir: state.dir,
          clock,
          run: async (argv) => {
            const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe" });
            return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() };
          },
        },
        { activityPaths: [source] },
      );
      const lane = { ...evidenceLane(state.dir), key, openedAt: at };
      clock.at += 60_000;
      await supervisor.sweep(lane, "Working 1m");
      writeFileSync(source, next);
      clock.at += 60_000;
      const result = await supervisor.sweep(lane, "Working 2m");
      expect(result.lastEvidenceAt).toBe(new Date(clock.at).toISOString());
      expect(reports.read(key)?.evidenced.at(-1)?.evidenceRefs).toEqual([fileEvidence(source, state.dir)]);
    } finally {
      state.done();
    }
  },
);
