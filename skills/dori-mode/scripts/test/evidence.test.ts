import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CheckpointError, Checkpoints } from "../src/checkpoints.ts";
import {
  EvidenceError,
  type EvidenceRef,
  evidenceClock,
  fileEvidence,
  novelEvidence,
  pathMark,
} from "../src/evidence.ts";
import { parseEvent, ReportError, Reports } from "../src/reports.ts";
import { type TestState, withState } from "./fakes.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const fifo = (path: string): string => {
  expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
  return path;
};

describe("file evidence", () => {
  test("is the canonical path and the bytes, so a link and a touch name the same evidence", () => {
    const file = join(state.dir, "result.txt");
    writeFileSync(file, "first");
    symlinkSync(file, join(state.dir, "link.txt"));
    const first = fileEvidence("result.txt", state.dir);
    expect(first).toEqual({
      kind: "file",
      ref: realpathSync(file),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fileEvidence("link.txt", state.dir)).toEqual(first);
    utimesSync(file, new Date(5_000_000), new Date(5_000_000));
    writeFileSync(file, "first");
    expect(fileEvidence(file, "/")).toEqual(first);
    writeFileSync(file, "second");
    expect(fileEvidence(file, "/").fingerprint).not.toBe(first.fingerprint);
  });

  test("a FIFO, a link to one, a directory or a missing file is refused at once, without opening it", () => {
    fifo(join(state.dir, "pipe"));
    symlinkSync(join(state.dir, "pipe"), join(state.dir, "to-pipe"));
    mkdirSync(join(state.dir, "dir"));
    // A blocking open of a FIFO without a writer would hang here; the refusal must come first.
    expect(() => fileEvidence("pipe", state.dir)).toThrow("is not a regular file");
    expect(() => fileEvidence("to-pipe", state.dir)).toThrow("is not a regular file");
    expect(() => fileEvidence("dir", state.dir)).toThrow("is not a regular file");
    expect(() => fileEvidence("missing", state.dir)).toThrow("does not exist");
  });

  test("a symlink loop is refused with a resolution diagnostic", () => {
    symlinkSync("loop", join(state.dir, "loop"));
    expect(() => fileEvidence("loop", state.dir)).toThrow("symlink loop");
  });

  // procfs files stat as empty regular files but read as bytes: the read disagrees with the stat it started from.
  test.skipIf(process.platform !== "linux")("a file whose bytes disagree with its stat is refused as unstable", () => {
    expect(() => fileEvidence("/proc/self/status", "/")).toThrow(EvidenceError);
    expect(() => fileEvidence("/proc/self/status", "/")).toThrow("changed while it was read");
  });
});

describe("watched path marks", () => {
  test("a settled lstat reuses the mark without reading; a touch keeps its fingerprint", () => {
    const file = join(state.dir, "source.ts");
    writeFileSync(file, "first");
    const settledAt = Date.now() + 2_000;
    const first = pathMark(file, undefined, settledAt);
    const open = spyOn(fs, "openSync");
    try {
      expect(pathMark(file, first, settledAt)).toBe(first);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
    utimesSync(file, new Date(5_000_000), new Date(5_000_000));
    const touched = pathMark(file, first);
    expect(touched).not.toBe(first);
    expect(touched[1]).toBe(first[1]);
    writeFileSync(file, "second");
    expect(pathMark(file, touched)[1]).not.toBe(first[1]);
  });

  test("a recent timestamp is re-read before its lstat can become a trusted quiet cache", () => {
    const path = join(state.dir, "recent.txt");
    writeFileSync(path, "first");
    const first = pathMark(path);
    const recent = pathMark(path, first);
    expect(recent).not.toBe(first);
    expect(recent[1]).toBe(first[1]);
    writeFileSync(path, "other");
    const changed = pathMark(path, recent);
    expect(changed[1]).not.toBe(first[1]);
    const later = Date.now() + 2_000;
    const settled = pathMark(path, changed, later);
    expect(pathMark(path, settled, later)).toBe(settled);
  });

  test("a FIFO is marked without being opened, a link by its target and a missing path as missing", () => {
    const pipe = fifo(join(state.dir, "pipe"));
    expect(pathMark(pipe)[1]).toBe("special");
    symlinkSync("a", join(state.dir, "link"));
    const link = pathMark(join(state.dir, "link"));
    expect(link[1]).toMatch(/^[a-f0-9]{64}$/);
    expect(pathMark(join(state.dir, "missing"))).toEqual(["missing", null]);
  });

  for (const code of ["EACCES", "EIO"]) {
    test(`${code} is not a successful observation of the previous file bytes`, () => {
      const path = join(state.dir, "unreadable.txt");
      writeFileSync(path, "before");
      const previous = pathMark(path);
      writeFileSync(path, "after");
      const open = spyOn(fs, "openSync").mockImplementation(() => {
        throw Object.assign(new Error(code), { code });
      });
      try {
        expect(() => pathMark(path, previous)).toThrow(code);
      } finally {
        open.mockRestore();
      }
    });
  }

  test("a directory is its entry names, not its times", () => {
    const dir = join(state.dir, "out");
    mkdirSync(dir);
    const empty = pathMark(dir);
    utimesSync(dir, new Date(5_000_000), new Date(5_000_000));
    expect(pathMark(dir, empty)[1]).toBe(empty[1]);
    writeFileSync(join(dir, "new.txt"), "x");
    expect(pathMark(dir, empty)[1]).not.toBe(empty[1]);
  });
});

const file = (ref: string, fingerprint: string): EvidenceRef => ({ kind: "file", ref, fingerprint });
const tool = (ref: string, fingerprint: string): EvidenceRef => ({ kind: "tool", ref, fingerprint });
const A = "a".repeat(64);
const B = "b".repeat(64);
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

describe("evidence clock", () => {
  test("records without evidence, however many or reworded, never move it", () => {
    expect(evidenceClock([{ at: at(1) }, { at: at(2), evidenceRefs: [] }])).toEqual({
      lastEvidenceAt: null,
      lastEvidence: null,
    });
  });

  test("the same bytes again do not move it; new bytes move it once, and so does a return to old bytes", () => {
    const records = [
      { at: at(1), evidenceRefs: [file("/r", A)] },
      { at: at(2), evidenceRefs: [file("/r", A)] },
    ];
    expect(evidenceClock(records).lastEvidenceAt).toBe(at(1));
    records.push({ at: at(3), evidenceRefs: [file("/r", B)] }, { at: at(4), evidenceRefs: [file("/r", B)] });
    expect(evidenceClock(records)).toEqual({ lastEvidenceAt: at(3), lastEvidence: file("/r", B) });
    records.push({ at: at(5), evidenceRefs: [file("/r", A)] });
    expect(evidenceClock(records).lastEvidenceAt).toBe(at(5));
  });

  test("a tool result is its content: a rerun under a new call id is the same evidence", () => {
    const records = [
      { at: at(1), evidenceRefs: [tool("call-1", A)] },
      { at: at(2), evidenceRefs: [tool("call-2", A)] },
    ];
    expect(evidenceClock(records).lastEvidenceAt).toBe(at(1));
    expect(novelEvidence(records, [tool("call-3", A), tool("call-4", B), file("/r", A)])).toEqual([
      tool("call-4", B),
      file("/r", A),
    ]);
  });

  test("reports and checkpoints are one timeline: a checkpoint of bytes already reported is not new", () => {
    const report = { at: at(1), evidenceRefs: [file("/r", A)] };
    const checkpoint = { at: at(2), evidenceRefs: [file("/r", A)] };
    expect(evidenceClock([checkpoint, report]).lastEvidenceAt).toBe(at(1));
  });

  test("journals keep valid refs and refuse malformed ones", async () => {
    const reports = new Reports(state.dir);
    await reports.report("demo-lane", "milestone", "first", Date.parse(at(1)), [file("/r", A)]);
    await reports.report("demo-lane", "milestone", "no evidence", Date.parse(at(2)));
    const progress = reports.read("demo-lane");
    expect(progress?.evidenced.map((report) => report.text)).toEqual(["first"]);
    expect(progress?.lastReport?.evidenceRefs).toBeUndefined();
    const line = { type: "report", key: "demo-lane", at: at(1), kind: "done", text: "ok" };
    expect(() => parseEvent(JSON.stringify({ ...line, evidenceRefs: [file("/r", "short")] }), "demo-lane")).toThrow(
      ReportError,
    );
    await expect(
      new Checkpoints(state.dir).write(
        "demo-lane",
        { step: "s", result: "r", evidence: [], remoteEffects: [], evidenceRefs: [{ kind: "url" } as never] },
        1,
      ),
    ).rejects.toThrow(CheckpointError);
  });

  test("a retried checkpoint keeps the fingerprints of its first write", async () => {
    const journal = new Checkpoints(state.dir);
    const step = { step: "build", result: "ok", evidence: ["out.txt"], remoteEffects: [] };
    const first = await journal.write("demo-lane", { ...step, evidenceRefs: [file("/out", A)] }, 1);
    const retried = await journal.write("demo-lane", { ...step, evidenceRefs: [file("/out", B)] }, 2);
    expect(retried).toEqual({ checkpoint: first.checkpoint, unchanged: true });
    expect(journal.read("demo-lane")[0]?.evidenceRefs).toEqual([file("/out", A)]);
  });
});
