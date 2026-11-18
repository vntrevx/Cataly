import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

import type { TgInbound } from "./telegram-inbound.ts";

/**
 * One line per received Telegram message: when it arrived, how late, and which message it was.
 *
 * Why this exists: the `INBOUND` line the receiver prints is a pinned contract that monitors and
 * the lead parse by position, so receive lag cannot be appended to it. Without a separate record
 * there is no way to answer "how fast do messages actually arrive" with more than one reading
 * taken by hand — measured percentiles need every message, not a spot check.
 */
export type InboundLagRecord = {
  /** When the receiver handled it, ISO. */
  readonly at: string;
  /** Telegram's own message date in unix ms; absent when the payload carried no date. */
  readonly tgDateMs?: number;
  /** at minus tgDateMs. Absent when Telegram gave no date; clamped at 0 for clock skew. */
  readonly lagMs?: number;
  readonly updateId: number;
  readonly messageId?: number;
  readonly source: "dm" | "topic";
  readonly chat: number;
  readonly thread?: number;
  readonly from: number;
  readonly kind: "message" | "edit";
};

/**
 * Build the record for one message from the date that message is measured against: its own, or for
 * an edit the edit's date. Clamp a negative host/server clock difference to 0; a missing date stays
 * absent, so an edit Telegram dated no way at all records no lag rather than the message's age.
 */
export const inboundLagRecord = (i: TgInbound, nowMs: number): InboundLagRecord => {
  const tgDateMs = i.date === undefined ? undefined : i.date * 1000;
  return {
    at: new Date(nowMs).toISOString(),
    ...(tgDateMs === undefined ? {} : { tgDateMs, lagMs: Math.max(0, nowMs - tgDateMs) }),
    updateId: i.updateId,
    ...(i.messageId === undefined ? {} : { messageId: i.messageId }),
    source: i.source,
    chat: i.chat,
    ...(i.thread === undefined ? {} : { thread: i.thread }),
    from: i.from,
    kind: i.kind,
  };
};

/** The size one lag file may reach before it is rotated to `<path>.1`, replacing the previous one. */
export const LAG_ROTATE_BYTES = 4 * 1024 * 1024;

/**
 * Append one record per line to `path`, creating the directory on first write, and rotate the file
 * to `<path>.1` once it passes `rotateBytes` so the meter cannot grow without bound. One previous
 * file is kept, which is what `readLagTail` needs to fill a window that straddles a rotation.
 *
 * stdout stays the INBOUND line alone: this file is the meter, and a write failure must never
 * cost a message, so an unreadable or unwritable file is reported once by the caller's warn and
 * then ignored. Returns the writer so the caller decides how to surface the first failure.
 */
export const inboundLagLog = (
  path: string,
  warn: (message: string) => void = () => {},
  rotateBytes: number = LAG_ROTATE_BYTES,
): ((i: TgInbound, nowMs: number) => void) => {
  let failed = false;
  let rotatedFailed = false;
  // The file's size, read once and then tracked: a stat per message would cost more than the write.
  let bytes: number | undefined;
  return (i, nowMs) => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      bytes ??= statSync(path, { throwIfNoEntry: false })?.size ?? 0;
      const line = `${JSON.stringify(inboundLagRecord(i, nowMs))}\n`;
      if (bytes + Buffer.byteLength(line) > rotateBytes) {
        try {
          // Replace the previous file in one step: a reader sees either the old or the new one.
          renameSync(path, `${path}.1`);
          bytes = 0;
        } catch (e) {
          if (!rotatedFailed) {
            rotatedFailed = true;
            warn(`inbound lag log ${path} could not rotate (${e instanceof Error ? e.message : String(e)}); growing`);
          }
        }
      }
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
      bytes += Buffer.byteLength(line);
    } catch (e) {
      // One warning, not one per message: a broken meter must not flood the receiver log.
      if (failed) return;
      failed = true;
      warn(`inbound lag log ${path} unwritable (${e instanceof Error ? e.message : String(e)}); lag not recorded`);
    }
  };
};

export type LagSummary = {
  readonly n: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
};

/**
 * Parse one jsonl line back into its lag, or undefined when the line is not a complete record.
 *
 * A reader meets two kinds of junk: a partial final line when the receiver was killed mid-write,
 * and anything else that crept into the file. Both are skipped rather than thrown, so one bad byte
 * cannot hide a whole window of readings. Only `lagMs` is validated because it is the only field
 * the summary uses; the rest of the record is not needed to compute percentiles.
 */
export const lagOfLine = (line: string): number | undefined => {
  if (line.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || !("lagMs" in parsed)) return undefined;
  const lag = parsed.lagMs;
  return typeof lag === "number" && Number.isFinite(lag) ? lag : undefined;
};

/** Last nonblank lines, including a torn final record, read backwards in fixed-size blocks. */
export const readLagTail = (path: string, limit: number): string[] => {
  const fd = openSync(path, "r");
  try {
    const lines: string[] = [];
    const block = Buffer.alloc(8192);
    let position = fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (position > 0 && lines.length < limit) {
      const start = Math.max(0, position - block.length);
      const length = readSync(fd, block, 0, position - start, start);
      let end = length;
      for (let i = length - 1; i >= 0; i--) {
        if (block[i] !== 0x0a) continue;
        const line = Buffer.concat([block.subarray(i + 1, end), carry]).toString("utf8");
        if (line.trim() !== "") lines.push(line);
        carry = Buffer.alloc(0);
        end = i;
        if (lines.length === limit) break;
      }
      if (lines.length === limit) break;
      carry = Buffer.concat([block.subarray(0, end), carry]);
      position = start;
    }
    if (lines.length < limit) {
      const line = carry.toString("utf8");
      if (line.trim() !== "") lines.push(line);
    }
    return lines.reverse();
  } finally {
    closeSync(fd);
  }
};

/** Nearest-rank percentiles over the recorded lags, so a summary can be read without jq. */
export const summarizeLag = (lagMs: readonly number[]): LagSummary | undefined => {
  if (lagMs.length === 0) return undefined;
  const sorted = [...lagMs].sort((a, b) => a - b);
  // Nearest-rank: p90 of 10 readings is the 9th, not an interpolated value that never occurred.
  const at = (p: number): number => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] as number;
  return { n: sorted.length, p50: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted[sorted.length - 1] as number };
};
