import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TgInbound } from "../src/messenger/telegram-inbound.ts";
import { inboundLagLog, readLagWindow } from "../src/messenger/telegram-lag.ts";
import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const base: TgInbound = { kind: "message", source: "dm", chat: 5250, updateId: 90, from: 5250, text: "hi" };

const state = withState();
afterEach(() => state.done());

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

test("inbound-lag reports the live file when the previous one alone fills the window", async () => {
  // After a rotation `.1` holds a full window, so filling it from the previous file first would report
  // pre-rotation readings and omit every message since — the newest records are what a meter is for.
  mkdirSync(state.dir, { recursive: true });
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
  writeFileSync(join(state.dir, "telegram-lag.jsonl.1"), '{"lagMs":9000}\n{"lagMs":9000}\n{"lagMs":9000}\n');
  writeFileSync(join(state.dir, "telegram-lag.jsonl"), '{"lagMs":10}\n{"lagMs":20}\n');
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
  expect(result.out).toBe("LAG n=3 p50=20ms p90=9000ms p99=9000ms max=9000ms");
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

test("a window that straddles a rotation reads both files", () => {
  const path = join(state.dir, "straddle.jsonl");
  // A bound a few records actually cross, so the rotation happens and the window spans it. Distinct
  // records, as real ones are: each carries its own update id.
  const record = inboundLagLog(path, () => {}, 400);
  for (let i = 0; i < 12; i++) record({ ...base, updateId: 90 + i, date: 1_700_000_000 }, 1_700_000_001_000);
  // Without a rotation this test would be about `readLagTail` alone, which is not what it claims.
  expect(statSync(`${path}.1`).size).toBeGreaterThan(0);
  const liveLines = readFileSync(path, "utf8").trim().split("\n");
  const prevLines = readFileSync(`${path}.1`, "utf8").trim().split("\n");
  const window = readLagWindow(path, liveLines.length + prevLines.length);
  expect(window).toHaveLength(liveLines.length + prevLines.length);
  // Both files contributed: the window is not just the live file.
  expect(window.slice(0, prevLines.length)).toEqual(prevLines);
  expect(window.slice(prevLines.length)).toEqual(liveLines);
  expect(new Set(window).size).toBe(window.length); // distinct records survive
});

test("a rotation that failed once is not retried for every later record", () => {
  // The size counter keeps its pre-rotation value, so `bytes + len > bound` stays true forever: without
  // this guard every message pays a rename that is known to fail, for the life of the process.
  const path = join(state.dir, "norotate-once.jsonl");
  mkdirSync(`${path}.1`, { recursive: true });
  // Count only this file's rotation attempts: the module object is shared with everything else running.
  // The original is snapshotted before the spy, because an ESM import binding would follow the spy.
  const realRename = fs.renameSync;
  let renames = 0;
  const spy = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
    if (String(to) === `${path}.1`) renames++;
    return realRename(from, to);
  }) as typeof fs.renameSync);
  try {
    const record = inboundLagLog(path, () => {}, 200);
    for (let i = 0; i < 6; i++) record({ ...base, date: 1_700_000_000 }, 1_700_000_001_000);
  } finally {
    spy.mockRestore();
  }
  expect(renames).toBe(1);
  expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(6);
});

test("a rotation landing between the reads still reports the newest records", () => {
  // The live file is read, then rotated, then a fresh live file appears. Accepting the first read as
  // the window would report pre-rotation percentiles and omit everything since the rotation.
  const old = [9001, 9002, 9003].map((lagMs) => `{"lagMs":${lagMs}}`);
  const fresh = ['{"lagMs":5}', '{"lagMs":6}'];
  let live = [...old];
  let prev: string[] = [];
  let ino = 1;
  const read = (p: string): string[] => {
    if (p.endsWith(".1")) return prev;
    const seen = live;
    // The rotation lands while the live file is being read.
    if (prev.length === 0) {
      prev = live;
      live = [...fresh];
      ino = 2;
    }
    return seen;
  };
  const window = readLagWindow(join(state.dir, "race.jsonl"), 3, read, () => ino);
  // The retry sees the settled pair: the newest three records, oldest first.
  expect(window).toEqual([...old.slice(-1), ...fresh]);
});

test("a rotation that leaves a full previous file does not freeze the window on old records", () => {
  // The previous file alone fills the window after a rotation; the live file still holds the newest.
  const prev = [9001, 9002, 9003].map((lagMs) => `{"lagMs":${lagMs}}`);
  const live = ['{"lagMs":10}', '{"lagMs":20}'];
  const read = (p: string): string[] => (p.endsWith(".1") ? prev : live);
  expect(readLagWindow(join(state.dir, "full.jsonl"), 3, read, () => 1)).toEqual([...prev.slice(-1), ...live]);
});

test("two bots on one log write rows that cannot be mistaken for each other", () => {
  // update ids are per bot, so without the bot in the record two receivers could write byte-identical
  // rows and a window spanning a rotation would drop one as a duplicate.
  const path = join(state.dir, "shared.jsonl");
  const a = inboundLagLog(path, () => {}, 1_000_000, "111");
  const b = inboundLagLog(path, () => {}, 1_000_000, "222");
  const dated: TgInbound = { ...base, date: 1_700_000_000, updateId: 90 };
  a(dated, 1_700_000_001_000);
  b(dated, 1_700_000_001_000);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(new Set(lines).size).toBe(2); // identical messages, distinct rows
  expect(lines.some((l) => l.includes('"bot":"111"'))).toBe(true);
  expect(lines.some((l) => l.includes('"bot":"222"'))).toBe(true);
});
