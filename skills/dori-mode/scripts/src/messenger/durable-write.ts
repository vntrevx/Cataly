import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Replace `target` with `text` in one step: staged, flushed, renamed, and the rename flushed.
 *
 * `ready`/`markReady` let a caller create the state directory once per process rather than once per
 * write. A short write, a kill, a full disk or a power loss all leave the previous value whole.
 */
export const writeWhole = (target: string, text: string, ready: () => boolean, markReady: () => void): void => {
  const staged = `${target}.${process.pid}.staged`;
  try {
    if (!ready()) {
      // The state dir may not exist yet on a fresh install; without this the first save
      // fails with ENOENT and the same update is re-printed every tick.
      mkdirSync(dirname(target), { recursive: true });
      markReady();
    }
    // Write, flush, then rename: a kill or a full disk leaves the previous value intact, and a
    // power loss cannot leave the rename durable over data still only in the page cache — which
    // would read back as an empty file, i.e. offset 0 and a replay of everything retained.
    const fd = openSync(staged, "w", 0o600);
    try {
      // A short write leaves a prefix of the number — `123` of `123456` — and every prefix is a
      // valid offset, so the next start would resume from an older cursor and replay the updates
      // in between. The previous value is still whole at this point, so failing is the safe answer.
      const written = writeSync(fd, text);
      if (written !== Buffer.byteLength(text))
        throw new Error(`short write (${written} of ${Buffer.byteLength(text)} bytes)`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staged, target);
    // Make the rename itself durable. Losing it costs a replay from the previous offset, which is
    // at-least-once delivery, so a filesystem that refuses a directory fsync is not an error.
    try {
      const dfd = openSync(dirname(target), "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // the file is already flushed; only the rename's durability is lost
    }
  } catch (error) {
    try {
      rmSync(staged, { force: true });
    } catch {
      // the staged copy is only ever a partial value; leaving it is harmless
    }
    throw error;
  }
};
