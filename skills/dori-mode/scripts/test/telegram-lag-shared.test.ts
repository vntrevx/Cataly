import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TgInbound } from "../src/messenger/telegram-inbound.ts";
import { inboundLagLog } from "../src/messenger/telegram-lag-log.ts";
import { withState } from "./fakes.ts";

const base: TgInbound = { kind: "message", source: "dm", chat: 5250, updateId: 90, from: 5250, text: "hi" };

let state: ReturnType<typeof withState>;
beforeEach(() => {
  state = withState();
  mkdirSync(state.dir, { recursive: true });
});
afterEach(() => state.done());

test("a stale size counter does not rotate a log another receiver just replaced", () => {
  // Two receivers share the file, each tracking only its own appends. One rotates the full log away and
  // starts a tiny live file; the other's counter still says "over the bound", and rotating on that would
  // move the fresh file to `.1` and discard the whole window.
  const path = join(state.dir, "shared-rotate.jsonl");
  const a = inboundLagLog(path, () => {}, 500);
  const b = inboundLagLog(path, () => {}, 500);
  const dated: TgInbound = { ...base, date: 1_700_000_000 };
  for (let i = 0; i < 3; i++) b(dated, 1_700_000_001_000); // b's counter reaches the bound's edge
  a(dated, 1_700_000_001_000); // a sees the real size and rotates, leaving a fresh live file
  const freshLive = readFileSync(path, "utf8");
  const previous = readFileSync(`${path}.1`, "utf8");
  expect(freshLive.length).toBeLessThan(previous.length); // a fresh live file, not a full one
  // b's own count now says "over the bound", but the live file it would rotate is nearly empty.
  b(dated, 1_700_000_001_000);
  expect(readFileSync(path, "utf8").startsWith(freshLive)).toBe(true); // appended, not replaced
  expect(readFileSync(`${path}.1`, "utf8")).toBe(previous); // the window was not thrown away
});

test("a rotation that finds the log already rotated does not disable rotation for the process", () => {
  // Another receiver rotating between this one's stat and its rename makes the rename find nothing.
  // Treating that as a failure leaves this process never rotating again, so its log grows forever.
  const path = join(state.dir, "raced.jsonl");
  const record = inboundLagLog(path, () => {}, 400);
  const dated: TgInbound = { ...base, date: 1_700_000_000 };
  const realRename = fs.renameSync;
  let raced = false;
  const spy = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
    if (!raced) {
      raced = true;
      throw Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
    }
    return realRename(from, to);
  }) as typeof fs.renameSync);
  try {
    for (let i = 0; i < 10; i++) record({ ...dated, updateId: 200 + i }, 1_700_000_001_000);
  } finally {
    spy.mockRestore();
  }
  // Rotation stayed available: the live file is bounded and the window was moved aside.
  expect(statSync(path).size).toBeLessThanOrEqual(400);
  expect(statSync(`${path}.1`).size).toBeGreaterThan(0);
});

test("a claim that moved another receiver's fresh file puts it back instead of promoting it", () => {
  // Between this receiver's stat and its rename another one rotated the log and started a small live
  // file. Promoting that file to `.1` would throw away the retained window.
  mkdirSync(state.dir, { recursive: true });
  const path = join(state.dir, "stolen.jsonl");
  // A live file already past the bound, so the very next record decides to rotate.
  const window = Array.from({ length: 20 }, (_, i) => `{"lagMs":1000,"updateId":${300 + i}}`).join("\n") + "\n";
  expect(Buffer.byteLength(window)).toBeGreaterThan(400); // past the bound, so the next record rotates
  writeFileSync(path, window);
  const record = inboundLagLog(path, () => {}, 400);
  const dated: TgInbound = { ...base, date: 1_700_000_000 };
  const realRename = fs.renameSync;
  let raced = false;
  const spy = spyOn(fs, "renameSync").mockImplementation(((from: string, to: string) => {
    if (!raced) {
      raced = true;
      // The other receiver rotates first and leaves a tiny live file behind.
      realRename(from, `${path}.1`);
      writeFileSync(from, '{"lagMs":1}\n');
    }
    return realRename(from, to);
  }) as typeof fs.renameSync);
  try {
    record({ ...dated, updateId: 400 }, 1_700_000_001_000);
  } finally {
    spy.mockRestore();
  }
  // The fresh live file went back rather than replacing the window it was not part of.
  expect(readFileSync(path, "utf8")).toContain('"lagMs":1');
  expect(readFileSync(`${path}.1`, "utf8")).toContain('"lagMs":1000');
});
