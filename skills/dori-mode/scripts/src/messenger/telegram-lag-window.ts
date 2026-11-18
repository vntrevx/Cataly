import { statSync } from "node:fs";

import { readLagTail } from "./telegram-lag.ts";

/**
 * The last `limit` nonblank records across a rotation, newest last.
 *
 * The live file holds the newest records, so it is read first; `.1` only supplies what it cannot, or a
 * rotation that left a full previous file would freeze the window on pre-rotation readings. A rotation
 * can land between any two reads, moving the file just read into `.1` while a fresh live file starts
 * empty, so the live file is read again once `.1` turns out to have records — the last read always sees
 * the newest ones — and a line read twice is dropped by value. Records carry their update id, so two
 * distinct records never share a line. A missing file is an empty window, not a failure: a receiver
 * stopped between a rotation's rename and its next append leaves only `.1`.
 */
export const readLagWindow = (
  path: string,
  limit: number,
  read: (p: string, n: number) => string[] = readLagTail,
  identity: (p: string) => number | undefined = (p) => statSync(p, { throwIfNoEntry: false })?.ino,
): readonly string[] => {
  const readTail = (p: string, n: number): string[] => {
    try {
      return read(p, n);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  // A rotation is detected by the live file's identity, not by comparing record text: two distinct
  // records can serialise to the same bytes (an edit and its message at the same lag), so dropping
  // equal lines would silently lose readings. Reading live, then `.1`, then checking the live file's
  // identity again tells us whether a rename landed in between; if it did, the pair of reads is not a
  // consistent snapshot and is taken again.
  const attempt = (): {
    readonly stable: boolean;
    readonly lines: readonly string[];
    readonly prev: readonly string[];
  } => {
    const before = identity(path);
    const lines = readTail(path, limit);
    const prev = readTail(`${path}.1`, limit);
    return { stable: before === identity(path), lines, prev };
  };
  let taken = attempt();
  // A rotation during the read is rare, so one retry almost always settles; the bound keeps a receiver
  // rotating continuously from looping here.
  for (let i = 0; i < 2 && !taken.stable; i++) taken = attempt();
  if (taken.prev.length === 0) return taken.lines;
  // `.1` is a different file, so a line equal to one from the live file can only be the same record
  // seen from both sides of a rotation — never a distinct record. Two receivers appending to one log
  // can write identical lines (their `updateId`s are per bot), but those are only ever compared within
  // one file's window against the other's, and the count that matters is the window size, not identity.
  const merged = [...taken.prev.filter((line) => !taken.lines.includes(line)), ...taken.lines];
  return merged.slice(-limit);
};
