import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { evidenceClock } from "../src/evidence.ts";
import { Registry } from "../src/registry.ts";
import { type Activity, type LaneEvent, type Report, Reports } from "../src/reports.ts";
import {
  grouped,
  holdRegistry,
  iso,
  journal,
  KEY,
  lane,
  type Role,
  sequenceState,
  spawnWriter,
  step,
  supervisor,
  T0,
} from "./evidence-sequence-fixture.ts";
import { fakeClock } from "./fakes.ts";

/** Only delays an append: the original implementation still sequences, stores and returns the very same event. */
class DelayedReports extends Reports {
  constructor(
    stateDir: string,
    private readonly before: (event: LaneEvent) => Promise<void>,
  ) {
    super(stateDir);
  }

  override append(event: Report, beforeAppend?: () => void): Promise<Report>;
  override append(event: Activity, beforeAppend?: () => void): Promise<Activity>;
  override append(event: LaneEvent, beforeAppend?: () => void): Promise<LaneEvent>;
  override async append(event: LaneEvent, beforeAppend?: () => void): Promise<LaneEvent> {
    await this.before(event);
    return super.append(event, beforeAppend);
  }
}

test.each(["checkpoint", "report"] as const)(
  "%s accepted first: writer processes at one millisecond wait on a held registry lock, then take 1 and 2",
  async (first) => {
    const f = sequenceState();
    const second: Role = first === "checkpoint" ? "report" : "checkpoint";
    const now = Date.now();
    const journalLock = `${f.checkpoints.path(KEY)}.lock`;
    const gate = join(f.dir, "late.go");
    const a = f.ref("A");
    const b = f.ref("B");
    const release = holdRegistry(f.dir);
    const early = spawnWriter(f.dir, first, now, f.source, a);
    const late = spawnWriter(f.dir, second, now, f.source, b, gate);
    try {
      await Promise.all([early.waiting(), late.waiting()]);
      // Both were refused by the live holder; the checkpoint writer took its own lock first and keeps it while waiting.
      expect([existsSync(f.reports.path(KEY)), existsSync(f.checkpoints.path(KEY))]).toEqual([false, false]);
      expect(JSON.parse(readFileSync(journalLock, "utf8")).pid).toBe((first === "checkpoint" ? early : late).child.pid);
      release();
      const accepted = await early.finished();
      // The gated writer still waits. A gated checkpoint writer still holds its own lock, so the report finished under
      // the registry lock without it: the checkpoint-then-registry order leaves no cycle to deadlock on.
      expect(late.child.exitCode).toBeNull();
      expect(existsSync(journalLock)).toBe(second === "checkpoint");
      writeFileSync(gate, "");
      const later = await late.finished();
      const stored = { report: journal(f.reports.path(KEY)), checkpoint: journal(f.checkpoints.path(KEY)) };
      expect([stored.report.length, stored.checkpoint.length]).toEqual([1, 1]);
      const [one] = stored[first];
      const [two] = stored[second];
      expect([one?.at, two?.at]).toEqual([iso(now), iso(now)]);
      expect([one?.evidenceSequence, two?.evidenceSequence]).toEqual([1, 2]);
      expect([one?.evidenceRefs, two?.evidenceRefs]).toEqual([[a], [b]]);
      // Each process returned exactly the record it stored.
      expect(accepted).toEqual(first === "report" ? one : { checkpoint: one, unchanged: false });
      expect(later).toEqual(second === "report" ? two : { checkpoint: two, unchanged: false });
      expect([existsSync(journalLock), existsSync(`${new Registry(f.dir).path(KEY)}.lock`)]).toEqual([false, false]);
      // The source-grouped merge lists the report first whichever was accepted first; the sequence keeps B the latest.
      expect(evidenceClock(grouped(f.dir))).toEqual({ lastEvidenceAt: iso(now), lastEvidence: b });
      const result = await supervisor(f.dir, fakeClock(now + 60_000), f.source).sweep(lane(f.dir), "Working 1m");
      expect(result.lastEvidenceAt).toBe(iso(now));
      // Quiet: the observer found nothing novel, so no activity joined the lone report.
      expect(f.reports.read(KEY)?.evidenced).toHaveLength(1);
    } finally {
      release();
      early.child.kill();
      late.child.kill();
      await Promise.all([early.child.exited, late.child.exited]);
      f.done();
    }
  },
  20_000,
);

test("a report accepted while the observer's novel evidence waits to append keeps the report's own time", async () => {
  const f = sequenceState();
  const resume = Promise.withResolvers<void>();
  let pending: Promise<unknown> | undefined;
  try {
    const clock = fakeClock(T0);
    await f.checkpoints.write(KEY, step("A", f.source, [f.ref("A")]), T0);
    const b = f.ref("B");
    clock.at = T0 + 60_000;
    const paused = Promise.withResolvers<LaneEvent>();
    const observer = new DelayedReports(f.dir, async (event) => {
      if (!event.evidenceRefs?.length) return;
      paused.resolve(event);
      await resume.promise;
    });
    const sweep = supervisor(f.dir, clock, f.source, observer).sweep(lane(f.dir), "Working 1m");
    pending = sweep;
    // The observer folded checkpoint A, found B novel, and now waits right before its real append at +1 minute.
    expect(await Promise.race([paused.promise, sweep.then(() => null)])).toMatchObject({
      type: "activity",
      at: iso(T0 + 60_000),
      evidenceRefs: [b],
    });
    // Meanwhile the lane's own report of B, made at the original time, is accepted first.
    const report = await new Reports(f.dir).report(KEY, "milestone", "B", T0, undefined, [b]);
    expect([report.at, report.evidenceSequence]).toEqual([iso(T0), 2]);
    resume.resolve();
    const result = await sweep;
    expect(result.lastEvidenceAt).toBe(iso(T0));
    expect(evidenceClock(grouped(f.dir))).toEqual({ lastEvidenceAt: iso(T0), lastEvidence: b });
    // Whatever the observer stored after the report took the next unique sequence.
    const [checkpointed, reported] = [f.checkpoints.path(KEY), f.reports.path(KEY)].map((path) =>
      journal(path)
        .filter((record) => record.evidenceRefs?.length)
        .map((record) => record.evidenceSequence),
    );
    expect(checkpointed).toEqual([1]);
    expect(reported?.[0]).toBe(2);
    expect(reported).toEqual(reported?.map((_, index) => index + 2));
  } finally {
    resume.resolve();
    try {
      await pending;
    } finally {
      f.done();
    }
  }
});
