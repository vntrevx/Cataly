import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The persisted `getUpdates` cursor. An offset that reads back as 0 replays every update Telegram still
 * retains (24 hours), so a torn or unreadable file is reported rather than accepted as a fresh start.
 */
export type TgInboundStore = { load(): number; save(offset: number): void };

/** `<botId> <offset>`, or a legacy bare offset from before the bot id was recorded. */
const STORED = /^(?:(\d+) )?(\d+)$/;

/**
 * The cursor for one bot's `getUpdates`. `botId` is the token's numeric prefix: an offset belongs to the
 * bot that produced it, and a cursor carried over to a different bot confirms — and so discards — every
 * update that bot has waiting, because a bot's `update_id`s start far below another bot's.
 */
export const fileTgInboundStore = (path: string, botId?: string): TgInboundStore => {
  // One warning per failure kind per process: load() runs on every poll, and a broken meter must not
  // flood the receiver log. Load and save are separate flags because a start that warns about a torn
  // offset must still report that it cannot persist the new one.
  let warnedLoad = false;
  let warnedSave = false;
  const warn = (scope: "load" | "save", message: string): void => {
    if (scope === "load" ? warnedLoad : warnedSave) return;
    if (scope === "load") warnedLoad = true;
    else warnedSave = true;
    // stdout like every other inbound WARN, so a monitor filtering stdout sees it.
    console.log(`WARN ${message} (warned once)`.slice(0, 300));
  };
  // The offset this process has already handled. A write that fails must not make the next poll
  // replay what was just delivered, so memory wins until a write lands.
  let handled: number | undefined;
  let dirReady = false;
  return {
    load(): number {
      if (handled !== undefined) return handled;
      let text: string;
      try {
        text = readFileSync(path, "utf8").trim();
      } catch (error) {
        // No file yet is a fresh start. Any other failure is a real problem: an unreadable offset
        // replays up to 24 hours of updates, so it is named rather than swallowed.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          warn(
            "load",
            `telegram-offset at ${path} is unreadable (${String((error as Error).message)}); restarting from 0`,
          );
        return 0;
      }
      // An empty file is a write that did not finish, not offset 0: `Number("")` is 0 and would
      // otherwise pass every check and silently replay the whole retained history.
      const stored = STORED.exec(text);
      if (stored === null) {
        warn(
          "load",
          `telegram-offset at ${path} is not a stored offset (${JSON.stringify(text.slice(0, 40))}); restarting from 0`,
        );
        return 0;
      }
      const [, storedBot, storedOffset] = stored;
      // A legacy bare offset carries no bot to check it against; the next save records one.
      if (storedBot !== undefined && botId !== undefined && storedBot !== botId) {
        warn(
          "load",
          `telegram-offset at ${path} belongs to bot ${storedBot}, not ${botId}; restarting from 0 rather than confirming away this bot's updates`,
        );
        return 0;
      }
      const n = Number(storedOffset);
      if (!Number.isSafeInteger(n) || n < 0) {
        warn(
          "load",
          `telegram-offset at ${path} is not a stored offset (${JSON.stringify(text.slice(0, 40))}); restarting from 0`,
        );
        return 0;
      }
      handled = n;
      return n;
    },
    save(offset: number): void {
      handled = offset;
      const staged = `${path}.${process.pid}.staged`;
      try {
        // The state dir may not exist yet on a fresh install; without this the first save
        // fails with ENOENT and the same update is re-printed every tick.
        if (!dirReady) {
          mkdirSync(dirname(path), { recursive: true });
          dirReady = true;
        }
        // Write, flush, then rename: a kill or a full disk leaves the previous offset intact, and a
        // power loss cannot leave the rename durable over data still only in the page cache — which
        // would read back as an empty file, i.e. offset 0 and a replay of everything retained.
        const fd = openSync(staged, "w", 0o600);
        try {
          writeSync(fd, botId === undefined ? String(offset) : `${botId} ${offset}`);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(staged, path);
        // Make the rename itself durable. Losing it costs a replay from the previous offset, which is
        // at-least-once delivery, so a filesystem that refuses a directory fsync is not an error.
        try {
          const dfd = openSync(dirname(path), "r");
          try {
            fsyncSync(dfd);
          } finally {
            closeSync(dfd);
          }
        } catch {
          // the file is already flushed; only the rename's durability is lost
        }
      } catch (error) {
        // The update was delivered; failing to record it must not deliver it again this run.
        try {
          rmSync(staged, { force: true });
        } catch {
          // the staged copy is only ever a partial offset; leaving it is harmless
        }
        warn(
          "save",
          `telegram-offset at ${path} not saved (${String((error as Error).message)}); continuing from memory for this run`,
        );
      }
    },
  };
};
