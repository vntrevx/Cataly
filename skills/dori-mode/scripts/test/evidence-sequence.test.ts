import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type EvidenceRef, evidenceClock } from "../src/evidence.ts";
import { Registry } from "../src/registry.ts";
import { type LaneEvent, ReportError } from "../src/reports.ts";
import { grouped, holdRegistry, iso, journal, KEY, sequenceState, step, T0 } from "./evidence-sequence-fixture.ts";

test("a held journal lock refuses at once ahead of a held registry lock, without capture or append; a replay keeps its record", async () => {
  const f = sequenceState();
  try {
    const now = Date.now();
    const first = await f.checkpoints.write(KEY, step("A", f.source, [f.ref("A")]), now);
    expect(first.checkpoint.evidenceSequence).toBe(1);
    const before = readFileSync(f.checkpoints.path(KEY), "utf8");
    let captures = 0;
    const capture = (): EvidenceRef[] => {
      captures++;
      return [f.ref("B")];
    };
    const release = holdRegistry(f.dir);
    try {
      const unlock = f.checkpoints.lock(KEY, now); // another live writer of this journal
      try {
        const refused = f.checkpoints.write(KEY, step("B", f.source), now, capture);
        // Settled before its first await: no registry wait, not even one 10 ms retry, ever began.
        expect(Bun.peek.status(refused)).toBe("rejected");
        await expect(refused).rejects.toThrow(`checkpoint writer locked: ${KEY} (pid ${process.pid}`);
      } finally {
        unlock();
      }
      // A replay under the held registry lock is answered from the stored record: no wait, capture or new number.
      const replay = f.checkpoints.write(KEY, step("A", f.source), now + 1, capture);
      expect(Bun.peek.status(replay)).toBe("fulfilled");
      expect(await replay).toStrictEqual({ checkpoint: first.checkpoint, unchanged: true });
      expect(captures).toBe(0);
      expect(readFileSync(f.checkpoints.path(KEY), "utf8")).toBe(before);
      expect(existsSync(`${f.checkpoints.path(KEY)}.lock`)).toBe(false);
    } finally {
      release();
    }
    const next = await f.reports.report(KEY, "milestone", "B", now, [f.ref("B")]);
    expect(next.evidenceSequence).toBe(2);
    expect(journal(f.reports.path(KEY))).toEqual([next]);
  } finally {
    f.done();
  }
});

test("evidence writers still wait out a held registry lock for 5 s in 10 ms retries; plain writers never touch it", async () => {
  const f = sequenceState();
  try {
    const lock = `${new Registry(f.dir).path(KEY)}.lock`;
    const release = holdRegistry(f.dir);
    let attempts = 0;
    const openSync = fs.openSync;
    const open = spyOn(fs, "openSync").mockImplementation(
      new Proxy(openSync, {
        apply(target, receiver, args) {
          if (args[0] === lock) attempts++;
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    try {
      const ref = f.ref("B");
      const plain = await f.reports.report(KEY, "milestone", "plain", T0);
      const bare = await f.checkpoints.write(KEY, step("plain", f.source), Date.now());
      expect(attempts).toBe(0);
      const started = Date.now();
      const waits = await Promise.allSettled([
        f.reports.report(KEY, "milestone", "evidence", T0, [ref]),
        f.checkpoints.write(KEY, step("evidence", f.source, [ref]), Date.now()),
      ]);
      const elapsed = Date.now() - started;
      const timedOut = expect.stringContaining(`lane registry locked: ${KEY} (pid ${process.pid}`);
      expect(waits.map((wait) => wait.status === "rejected" && String(wait.reason))).toEqual([timedOut, timedOut]);
      expect(elapsed).toBeGreaterThanOrEqual(5_000);
      expect(elapsed).toBeLessThan(7_000);
      // About 500 attempts per writer at a 10 ms retry: bounds that reject a busy loop or a coarse poll.
      expect(attempts).toBeGreaterThan(100);
      expect(attempts).toBeLessThanOrEqual(1_200);
      // Only the plain records were stored, without a sequence; the checkpoint writer released its own lock, and the
      // live holder still owns the registry lock (a waiter never takes it over).
      expect(journal(f.reports.path(KEY))).toEqual([plain]);
      expect(journal(f.checkpoints.path(KEY))).toEqual([bare.checkpoint]);
      for (const path of [f.reports.path(KEY), f.checkpoints.path(KEY)])
        expect(readFileSync(path, "utf8")).not.toContain("evidenceSequence");
      expect(existsSync(`${f.checkpoints.path(KEY)}.lock`)).toBe(false);
      expect(JSON.parse(readFileSync(lock, "utf8")).pid).toBe(process.pid);
    } finally {
      open.mockRestore();
      release();
    }
    // The timed-out writers consumed no number.
    expect((await f.reports.report(KEY, "milestone", "evidence", T0, [f.ref("B")])).evidenceSequence).toBe(1);
    expect(existsSync(lock)).toBe(false);
  } finally {
    f.done();
  }
}, 15_000);

test("sequence-less journals stay readable, fold by time, and new evidence or retries never rewrite them", async () => {
  const f = sequenceState();
  try {
    const a = f.ref("A");
    const b = f.ref("B");
    const c = f.ref("C");
    const d = f.ref("D");
    const e = f.ref("E");
    const at = (seconds: number): string => iso(T0 + seconds * 1000);
    const oldA = { key: KEY, at: at(30), ...step("old-a", f.source, [a]) };
    const oldB = { type: "report", key: KEY, at: at(60), kind: "milestone", text: "old-b", evidenceRefs: [b] } as const;
    const idle = { type: "activity", key: KEY, at: at(70), state: "running", text: "Working activity resumed" };
    const legacy = {
      reports: `${JSON.stringify(oldB)}\n${JSON.stringify(idle)}\n`,
      checkpoints: `${JSON.stringify(oldA)}\n`,
    };
    mkdirSync(dirname(f.reports.path(KEY)), { recursive: true });
    writeFileSync(f.reports.path(KEY), legacy.reports);
    writeFileSync(f.checkpoints.path(KEY), legacy.checkpoints);
    // Read exactly as written: no sequence is invented for an old record.
    expect(f.reports.read(KEY)?.evidenced).toStrictEqual([oldB]);
    expect(f.checkpoints.read(KEY)).toStrictEqual([oldA]);
    // Their different times order the fold, though the source-grouped merge lists the later report first.
    expect(evidenceClock(grouped(f.dir))).toEqual({ lastEvidenceAt: at(60), lastEvidence: b });
    // New evidence in the old report's millisecond: the unsequenced record first, then acceptance order (C, then D),
    // though the merge lists D before C.
    const newC = await f.checkpoints.write(KEY, step("new-c", f.source, [c]), T0 + 60_000);
    const newD = await f.reports.report(KEY, "milestone", "new-d", T0 + 60_000, [d]);
    expect([newC.checkpoint.evidenceSequence, newD.evidenceSequence]).toEqual([1, 2]);
    expect(evidenceClock(grouped(f.dir))).toEqual({ lastEvidenceAt: at(60), lastEvidence: d });
    // Retries of an old and a new step return their stored records, without capture or a number.
    let captures = 0;
    const capture = (): EvidenceRef[] => {
      captures++;
      return [e];
    };
    expect(await f.checkpoints.write(KEY, step("old-a", f.source), T0 + 90_000, capture)).toStrictEqual({
      checkpoint: oldA,
      unchanged: true,
    });
    expect(await f.checkpoints.write(KEY, step("new-c", f.source), T0 + 90_000, capture)).toStrictEqual({
      checkpoint: newC.checkpoint,
      unchanged: true,
    });
    expect(captures).toBe(0);
    const newE = await f.checkpoints.write(KEY, step("new-e", f.source), T0 + 90_000, capture);
    expect([captures, newE.checkpoint.evidenceSequence, newE.checkpoint.evidenceRefs]).toEqual([1, 3, [e]]);
    // Old lines are never rewritten: each journal still begins with its exact legacy bytes.
    expect(readFileSync(f.reports.path(KEY), "utf8").startsWith(legacy.reports)).toBe(true);
    expect(readFileSync(f.checkpoints.path(KEY), "utf8").startsWith(legacy.checkpoints)).toBe(true);
  } finally {
    f.done();
  }
});

test.each([0, -1, 1.5, "1", null, Number.MAX_SAFE_INTEGER + 1])(
  "evidenceSequence %p is refused where a journal is read or appended",
  async (sequence) => {
    const f = sequenceState();
    try {
      const plain = { type: "report", key: KEY, at: iso(T0), kind: "milestone", text: "bad" };
      const evidenced = { ...plain, evidenceRefs: [f.ref("A")], evidenceSequence: sequence };
      const checkpoint = { key: KEY, at: iso(T0), ...step("bad", f.source, evidenced.evidenceRefs) };
      mkdirSync(dirname(f.reports.path(KEY)), { recursive: true });
      writeFileSync(f.reports.path(KEY), `${JSON.stringify(evidenced)}\n`);
      writeFileSync(f.checkpoints.path(KEY), `${JSON.stringify({ ...checkpoint, evidenceSequence: sequence })}\n`);
      expect(() => f.reports.read(KEY)).toThrow(`${f.reports.path(KEY)}:1: invalid report evidenceSequence for ${KEY}`);
      expect(() => f.checkpoints.read(KEY)).toThrow(
        `${f.checkpoints.path(KEY)}:1: invalid key, timestamp, or duplicate step`,
      );
      // Appending it is refused before any write, with or without evidence.
      const before = readFileSync(f.reports.path(KEY), "utf8");
      for (const event of [evidenced, { ...plain, evidenceSequence: sequence }])
        await expect(f.reports.append(event as unknown as LaneEvent)).rejects.toThrow(ReportError);
      expect(readFileSync(f.reports.path(KEY), "utf8")).toBe(before);
    } finally {
      f.done();
    }
  },
);

test("the writer assigns every sequence: a supplied one is replaced, and none past the last safe integer is issued", async () => {
  const f = sequenceState();
  try {
    const a = f.ref("A");
    const supplied: LaneEvent = {
      type: "report",
      key: KEY,
      at: iso(T0),
      kind: "milestone",
      text: "A",
      evidenceRefs: [a],
      evidenceSequence: 99,
    };
    const stored = await f.reports.append(supplied);
    expect(stored.evidenceSequence).toBe(1);
    expect(journal(f.reports.path(KEY))).toEqual([stored]);
    const last = { key: KEY, at: iso(T0), ...step("last", f.source, [a]), evidenceSequence: Number.MAX_SAFE_INTEGER };
    writeFileSync(f.checkpoints.path(KEY), `${JSON.stringify(last)}\n`);
    const before = readFileSync(f.reports.path(KEY), "utf8");
    await expect(f.reports.report(KEY, "milestone", "B", T0, [a])).rejects.toThrow("evidence sequence exhausted");
    expect(readFileSync(f.reports.path(KEY), "utf8")).toBe(before);
    expect(existsSync(`${new Registry(f.dir).path(KEY)}.lock`)).toBe(false);
  } finally {
    f.done();
  }
});
