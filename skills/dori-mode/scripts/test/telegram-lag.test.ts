import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TgInbound } from "../src/messenger/telegram-inbound.ts";
import {
  inboundLagLog,
  inboundLagRecord,
  type InboundLagRecord,
  lagOfLine,
  readLagTail,
  summarizeLag,
} from "../src/messenger/telegram-lag.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const base: TgInbound = { kind: "message", source: "dm", chat: 5250, updateId: 90, from: 5250, text: "hi" };

const state = withState();
afterEach(() => state.done());

/** Parse one jsonl line the way the reader must: bad or partial lines come back as undefined, never a throw. */
const parseRecord = (line: string): Partial<InboundLagRecord> | undefined => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed === null || typeof parsed !== "object") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
};

test("lag is the gap between Telegram's date and the moment it was handled", () => {
  const record = inboundLagRecord({ ...base, date: 1_700_000_000 }, 1_700_000_002_250);
  expect(record.lagMs).toBe(2250);
  expect(record.tgDateMs).toBe(1_700_000_000_000);
  expect(record.at).toBe(new Date(1_700_000_002_250).toISOString());
});

test("a message with no date records no lag instead of a fake zero", () => {
  // Absence must stay absent: a 0 here would read as "arrived instantly" and drag every percentile down.
  const record = inboundLagRecord(base, 1_700_000_002_250);
  expect(record.lagMs).toBeUndefined();
  expect(record.tgDateMs).toBeUndefined();
  expect("lagMs" in record).toBe(false);
});

test("clock skew between host and Telegram clamps to zero, never a negative lag", () => {
  expect(inboundLagRecord({ ...base, date: 1_700_000_100 }, 1_700_000_000_000).lagMs).toBe(0);
});

test("each handled message appends one line carrying its identity", () => {
  const path = join(state.dir, "nested", "telegram-lag.jsonl");
  const record = inboundLagLog(path);
  record({ ...base, messageId: 7, date: 1_700_000_000 }, 1_700_000_001_000);
  record({ ...base, updateId: 91, date: 1_700_000_000 }, 1_700_000_004_000);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  expect(lines.length).toBe(2);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const [first, second] = lines.map(parseRecord);
  expect(first?.messageId).toBe(7);
  expect(first?.updateId).toBe(90);
  expect(first?.lagMs).toBe(1000);
  expect(second?.lagMs).toBe(4000);
});

test("an unwritable meter warns once and never throws into the receiver", () => {
  const warnings: string[] = [];
  const record = inboundLagLog(join(state.dir, "not-a-dir", "sub"), (m) => warnings.push(m));
  // Make the log path itself a directory so every append fails.
  mkdirSync(join(state.dir, "not-a-dir", "sub", "telegram-lag.jsonl"), { recursive: true });
  record(base, 1_000);
  record(base, 2_000);
  expect(warnings.length).toBe(1);
  expect(warnings[0]).toContain("unwritable");
});

test("percentiles are nearest-rank readings that actually occurred", () => {
  const summary = summarizeLag([5, 1, 4, 2, 3, 6, 7, 8, 9, 10]);
  expect(summary).toEqual({ n: 10, p50: 5, p90: 9, p99: 10, max: 10 });
  expect(summarizeLag([])).toBeUndefined();
});

test("lagOfLine skips blank, partial and non-record lines, keeping complete ones", () => {
  expect(lagOfLine('{"lagMs": 42}')).toBe(42);
  expect(lagOfLine('{"lagMs":')).toBeUndefined();
  expect(lagOfLine("")).toBeUndefined();
  expect(lagOfLine("null")).toBeUndefined();
  expect(lagOfLine('{"lagMs": "42"}')).toBeUndefined();
});

test("the summary counts only complete records when the tail is a partial line", () => {
  // Guards the readback path: a partial last line must be skipped, not crash the reader.
  const path = join(state.dir, "telegram-lag.jsonl");
  mkdirSync(state.dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ lagMs: 100 })}\n${JSON.stringify({ lagMs: 300 })}\n{"lagMs":`);
  const lags = readLagTail(path, 3).flatMap((line) => lagOfLine(line) ?? []);
  expect(summarizeLag(lags)?.n).toBe(2);
});

test("the lag reader keeps nonblank record windows and UTF-8 intact across reverse-read blocks", () => {
  const path = join(state.dir, "telegram-lag.jsonl");
  mkdirSync(state.dir, { recursive: true });
  const long = JSON.stringify({ lagMs: 100, note: "\u{1f600}".repeat(6000) });
  for (const text of ["", "\n \t\n", long, `${long}\n\n{"lagMs":300}\n \n{"lagMs":`]) {
    writeFileSync(path, text);
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    for (const limit of [1, 2, 3]) expect(readLagTail(path, limit)).toEqual(lines.slice(-limit));
  }
});

test("a small lag window reads only the end of a large journal", () => {
  const path = join(state.dir, "telegram-lag.jsonl");
  mkdirSync(state.dir, { recursive: true });
  const prefix = '{"lagMs":999999}\n'.repeat(100_000);
  const tail = ['{"lagMs":100}', '{"lagMs":300}', '{"lagMs":'];
  writeFileSync(path, `${prefix}${tail.join("\n")}`);
  const reads: { position: number; length: number }[] = [];
  const original = fs.readSync;
  const spy = spyOn(fs, "readSync").mockImplementation(((
    fd: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => {
    reads.push({ position, length });
    return original(fd, buffer, offset, length, position);
  }) as typeof fs.readSync);
  try {
    expect(readLagTail(path, 3)).toEqual(tail);
    expect(reads.length).toBeGreaterThan(0);
    expect(reads.reduce((sum, read) => sum + read.length, 0)).toBeLessThan(prefix.length / 4);
    expect(reads.every((read) => read.position > prefix.length / 2)).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("inbound-lag CLI limits nonblank records before skipping missing dates and torn JSON", async () => {
  mkdirSync(state.dir, { recursive: true });
  const config = join(state.dir, "config.json");
  const path = join(state.dir, "telegram-lag.jsonl");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
  writeFileSync(path, '{"lagMs":999999}\n{"lagMs":100}\n{}\n \n{"lagMs":300}\n{"lagMs":');
  const invoke = (limit: string) =>
    run([
      "env",
      `DORI_CONFIG=${config}`,
      `DORI_STATE_DIR=${state.dir}`,
      process.execPath,
      join(import.meta.dir, "../src/cli.ts"),
      "inbound-lag",
      "--limit",
      limit,
    ]);
  const result = await invoke("4");
  expect(result.code).toBe(0);
  expect(result.err).toBe("");
  expect(result.out).toBe("LAG n=2 p50=100ms p90=300ms p99=300ms max=300ms skipped=2");
  expect((await invoke("1")).code).toBe(1);
  expect((await invoke("0")).code).toBe(1);
});

test("inbound-lag reads the previous file when a rotation left no live meter", async () => {
  // The receiver renames the live file to `.1` and appends to a fresh one. Stopped in between, or
  // rotated while this command runs, only `.1` holds readings; that is a readable window, not an
  // empty meter, and the command must not abort on the absent live path.
  mkdirSync(state.dir, { recursive: true });
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
  writeFileSync(join(state.dir, "telegram-lag.jsonl.1"), '{"lagMs":120}\n{"lagMs":340}\n');
  const result = await run([
    "env",
    `DORI_CONFIG=${config}`,
    `DORI_STATE_DIR=${state.dir}`,
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    "inbound-lag",
    "--limit",
    "10",
  ]);
  expect({ code: result.code, err: result.err.trim(), out: result.out }).toEqual({
    code: 0,
    err: "",
    out: "LAG n=2 p50=120ms p90=340ms p99=340ms max=340ms",
  });
});

test("inbound-lag fills a window that straddles a rotation from both files", async () => {
  mkdirSync(state.dir, { recursive: true });
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
  writeFileSync(join(state.dir, "telegram-lag.jsonl.1"), '{"lagMs":100}\n{"lagMs":200}\n');
  writeFileSync(join(state.dir, "telegram-lag.jsonl"), '{"lagMs":300}\n');
  const result = await run([
    "env",
    `DORI_CONFIG=${config}`,
    `DORI_STATE_DIR=${state.dir}`,
    process.execPath,
    join(import.meta.dir, "../src/cli.ts"),
    "inbound-lag",
    "--limit",
    "3",
  ]);
  // The older file supplies what the live one cannot; a rotation must not shrink the sample.
  expect(result.out).toBe("LAG n=3 p50=200ms p90=300ms p99=300ms max=300ms");
});

test("the lag file rotates at the size bound, keeping one previous file", () => {
  const path = join(state.dir, "rotate.jsonl");
  // A bound small enough that a few records cross it, so the rotation itself is what is tested.
  const record = inboundLagLog(path, () => {}, 400);
  const dated: TgInbound = { ...base, date: 1_700_000_000 };
  for (let i = 0; i < 12; i++) record(dated, 1_700_000_001_000);
  expect(statSync(path).size).toBeLessThanOrEqual(400);
  const previous = readFileSync(`${path}.1`, "utf8");
  const current = readFileSync(path, "utf8");
  // One previous file is kept, so older rotations are gone by design; what must hold is that the
  // newest records are in the live file and the file that was replaced still holds some.
  expect(previous.trim().split("\n").length).toBeGreaterThan(0);
  expect(current.trim().split("\n").length).toBeGreaterThan(0);
  const last = current.trim().split("\n").at(-1) ?? "";
  expect(last).toContain('"updateId":90');
});

test("a rotation that cannot land is warned once and the file keeps growing", () => {
  const path = join(state.dir, "norotate.jsonl");
  // A directory where the previous file should go: the rename fails, as it would on a full disk.
  mkdirSync(`${path}.1`, { recursive: true });
  const warns: string[] = [];
  const record = inboundLagLog(path, (m) => warns.push(m), 200);
  for (let i = 0; i < 6; i++) record({ ...base, date: 1_700_000_000 }, 1_700_000_001_000);
  expect(warns.filter((w) => w.includes("could not rotate"))).toHaveLength(1);
  expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(6);
});

test("a window that straddles a rotation still reads the requested number of records", async () => {
  const path = join(state.dir, "straddle.jsonl");
  // Each file holds about ten records at this bound, so the window spans the rotation.
  const record = inboundLagLog(path, () => {}, 2000);
  const dated: TgInbound = { ...base, date: 1_700_000_000 };
  for (let i = 0; i < 12; i++) record(dated, 1_700_000_001_000);
  // What `dori inbound-lag` does: the live file first, then the previous one for the remainder.
  const live = readLagTail(path, 10);
  const older = live.length < 10 ? readLagTail(`${path}.1`, 10 - live.length) : [];
  expect(live.length + older.length).toBe(10);
  expect([...older, ...live].every((line) => lagOfLine(line) === 1000)).toBe(true);
});
