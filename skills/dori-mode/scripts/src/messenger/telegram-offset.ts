import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The persisted `getUpdates` cursor. An offset that reads back as 0 replays every update Telegram still
 * retains (24 hours), so a torn or unreadable file is reported rather than accepted as a fresh start.
 */
export type TgInboundStore = { load(): number; save(offset: number): void };

/**
 * A bare offset, or the `<botId> <offset>` an earlier revision of this store wrote. The bare form is
 * what older releases read with `Number(...)`, so it stays the on-disk format: a rollback to one of
 * those releases must still find an offset it understands instead of replaying 24 hours of updates.
 */
const STORED = /^(?:(\d+) )?(\d+)$/;

/** A Telegram bot id: the digits before the colon in its token. */
const BOT_ID = /^\d+$/;

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
  // What the sidecar says, so a save knows whether the bot still needs recording. The inline form an
  // earlier revision wrote is checked too, but it is not a record: the next save must add the sidecar.
  let sidecarBot: string | undefined;
  // The offset this process has already handled. A write that fails must not make the next poll
  // replay what was just delivered, so memory wins until a write lands.
  let handled: number | undefined;
  let dirReady = false;

  /** Replace `target` with `text` in one step: staged, flushed, renamed, and the rename flushed. */
  const writeWhole = (target: string, text: string): void => {
    const staged = `${target}.${process.pid}.staged`;
    try {
      if (!dirReady) {
        // The state dir may not exist yet on a fresh install; without this the first save
        // fails with ENOENT and the same update is re-printed every tick.
        mkdirSync(dirname(target), { recursive: true });
        dirReady = true;
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
      const [, inlineBot, storedOffset] = stored;
      // The bot is recorded beside the offset in its own file, so the offset keeps the bare format
      // older releases parse. Only an absent record is a fresh or pre-upgrade install. Anything else
      // that leaves the bot unknown — an unreadable file, or one holding no digits because a write was
      // torn — is the case where the token may have changed, so it fails closed rather than accepting
      // an offset that could confirm away this bot's pending updates.
      let botText: string | undefined;
      try {
        botText = readFileSync(`${path}.bot`, "utf8").trim();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          warn(
            "load",
            `telegram-offset at ${path}.bot is unreadable (${String((error as Error).message)}); restarting from 0 rather than trusting an offset whose bot is unknown`,
          );
          return 0;
        }
      }
      if (botText !== undefined && !BOT_ID.test(botText)) {
        warn(
          "load",
          `telegram-offset at ${path}.bot is not a bot id (${JSON.stringify(botText.slice(0, 40))}); restarting from 0 rather than trusting an offset whose bot is unknown`,
        );
        return 0;
      }
      sidecarBot = botText;
      const recordedBot = inlineBot ?? sidecarBot;
      const n = Number(storedOffset);
      if (!Number.isSafeInteger(n) || n < 0) {
        warn(
          "load",
          `telegram-offset at ${path} is not a stored offset (${JSON.stringify(text.slice(0, 40))}); restarting from 0`,
        );
        return 0;
      }
      if (recordedBot !== undefined && botId !== undefined && recordedBot !== botId) {
        warn(
          "load",
          `telegram-offset at ${path} belongs to bot ${recordedBot}, not ${botId}; restarting from 0 rather than confirming away this bot's updates`,
        );
        return 0;
      }
      handled = n;
      return n;
    },
    save(offset: number): void {
      handled = offset;
      // A token whose prefix is not digits is a malformed token, not a bot id: recording it would make
      // every later start fail closed on a sidecar that can never match. Leave it absent instead.
      const bot = botId !== undefined && BOT_ID.test(botId) ? botId : undefined;
      const tag = (): void => {
        if (bot === undefined || bot === sidecarBot) return;
        try {
          writeWhole(`${path}.bot`, bot);
          sidecarBot = bot;
        } catch (error) {
          warn(
            "save",
            `telegram-offset bot id at ${path}.bot not saved (${String((error as Error).message)}); a token swap will not be detected`,
          );
        }
      };
      // Which file goes first decides what a crash between the two leaves, and the two cases want
      // opposite orders:
      //
      // - The bot changed (a sidecar exists and names another bot). Write the offset first, so a crash
      //   leaves the new offset beside the OLD bot id — a mismatch the next start replays from 0. The
      //   reverse order would leave a stale offset wearing this bot's name, which confirms away
      //   updates that were never delivered.
      // - There is no sidecar yet (a fresh install, or an upgrade from a release that never wrote one).
      //   Write the bot first: a crash then leaves a sidecar with no offset to misattribute (a fresh
      //   install has no offset file, so the next start is simply fresh), and on an upgrade it asserts
      //   the bot that actually owned the legacy offset. Writing the offset first would leave an
      //   untagged cursor, which the next start accepts under any token — the hole this closes.
      const changed = sidecarBot !== undefined && bot !== undefined && sidecarBot !== bot;
      if (!changed) tag();
      try {
        writeWhole(path, String(offset));
      } catch (error) {
        // The update was delivered; failing to record it must not deliver it again this run.
        warn(
          "save",
          `telegram-offset at ${path} not saved (${String((error as Error).message)}); continuing from memory for this run`,
        );
        return;
      }
      if (changed) tag();
    },
  };
};
