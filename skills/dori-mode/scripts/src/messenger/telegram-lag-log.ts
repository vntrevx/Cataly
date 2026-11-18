import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { inboundLagRecord, type TgInbound } from "./telegram-lag.ts";

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
  /** The bot whose updates this log receives; written into every record so two bots' rows differ. */
  bot?: string,
): ((i: TgInbound, nowMs: number) => void) => {
  let failed = false;
  // Once a rotation has failed it will fail the same way for every later record, so it is not retried:
  // the file is allowed to grow, as the one warning says, instead of costing a doomed rename per message.
  let rotationOff = false;
  let dirReady = false;
  // The file's size, read once and then tracked: a stat per message would cost more than the write.
  let bytes: number | undefined;

  /**
   * Move the live log to `.1` when it has outgrown the bound.
   *
   * Another receiver may share the file, so the real file decides rather than this process's counter.
   * It is claimed under a private name first: between the stat and the rename another receiver can
   * rotate the same log and start a fresh one, and promoting that file to `.1` would discard the
   * retained window. The claimed file's identity says which one was actually moved, and anything that
   * is not the file measured goes back as the live log rather than being lost.
   */
  const rotate = (length: number): void => {
    const before = statSync(path, { throwIfNoEntry: false });
    // Absent or already small means another receiver rotated it: follow whatever file is there now.
    if (before === undefined || before.size + length <= rotateBytes) {
      bytes = before?.size ?? 0;
      return;
    }
    const claimed = `${path}.${process.pid}.rotating`;
    const restore = (): void => {
      try {
        renameSync(claimed, path);
      } catch {
        // nothing recoverable; the next append starts a live file either way
      }
    };
    try {
      renameSync(path, claimed);
    } catch (e) {
      // A rename that finds nothing means another receiver rotated it; that is not a failure.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        rotationOff = true; // once only: the single attempt for the rest of the process
        warn(`inbound lag log ${path} could not rotate (${e instanceof Error ? e.message : String(e)}); growing`);
      }
      bytes = 0;
      return;
    }
    const after = statSync(claimed, { throwIfNoEntry: false });
    if (after === undefined || after.ino !== before.ino) {
      restore(); // not the file measured: another receiver had already replaced it
    } else {
      try {
        renameSync(claimed, `${path}.1`);
      } catch (e) {
        // The window cannot be moved aside, so the live log goes back and is left to grow.
        rotationOff = true;
        warn(`inbound lag log ${path} could not rotate (${e instanceof Error ? e.message : String(e)}); growing`);
        restore();
      }
    }
    bytes = 0;
  };

  return (i, nowMs) => {
    try {
      if (!dirReady) {
        mkdirSync(dirname(path), { recursive: true });
        dirReady = true;
      }
      bytes ??= statSync(path, { throwIfNoEntry: false })?.size ?? 0;
      const line = `${JSON.stringify(inboundLagRecord(i, nowMs, bot))}\n`;
      const length = Buffer.byteLength(line);
      if (!rotationOff && bytes + length > rotateBytes) rotate(length);
      appendFileSync(path, line, { encoding: "utf8", mode: 0o600 });
      bytes += length;
    } catch (e) {
      // One warning, not one per message: a broken meter must not flood the receiver log.
      if (failed) return;
      failed = true;
      warn(`inbound lag log ${path} unwritable (${e instanceof Error ? e.message : String(e)}); lag not recorded`);
    }
  };
};
