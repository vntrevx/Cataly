import { existsSync, readFileSync } from "node:fs";

import { writeWhole as durableWrite } from "./durable-write.ts";

/**
 * The persisted `getUpdates` cursor. An offset that reads back as 0 replays every update Telegram still
 * retains (24 hours), so a torn or unreadable file is reported rather than accepted as a fresh start.
 */
export type TgInboundStore = { load(): number; save(offset: number): void };

/** A stored offset, in the bare decimal form every release of this store has written. */
const STORED = /^\d+$/;

/** A Telegram bot id: the digits before the colon in its token. */
const BOT_ID = /^\d+$/;

/**
 * One cursor file per bot, because an `update_id` belongs to the bot that issued it.
 *
 * The obvious alternative — one file for all bots, with the bot recorded beside it — cannot be made
 * safe. Update ids are per bot and a bot's start far below another's, so handing one bot's cursor to
 * another makes `getUpdates` confirm, and discard, everything the second bot has waiting. Recording the
 * bot beside the shared cursor only helps readers that check the record, and a release from before the
 * record existed reads the cursor with `Number(...)` and checks nothing: during an A-to-B transition
 * that release, reached by a rollback, would adopt B's cursor. Separate files remove the question —
 * A's cursor stays in A's file, untouched, for as long as B is running.
 *
 * `path` itself is A's file for every install that predates the split, so it is only ever read as the
 * seed for a bot's own file and never written again. A rollback to an older release therefore finds the
 * cursor it left, which replays rather than discards.
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
  // A token whose prefix is not digits is a malformed token, not a bot id; such a token cannot
  // authenticate, so its cursor has no owner to separate it from and falls back to the shared path.
  const owner = botId !== undefined && BOT_ID.test(botId) ? botId : undefined;
  const cursorPath = owner === undefined ? path : `${path}.${owner}`;
  // The offset this process has already handled. A write that fails must not make the next poll
  // replay what was just delivered, so memory wins until a write lands.
  let handled: number | undefined;
  let dirReady = false;
  const writeWhole = (target: string, text: string): void =>
    durableWrite(
      target,
      text,
      () => dirReady,
      () => {
        dirReady = true;
      },
    );

  /** The offset stored in one file, or undefined when it is absent or not an offset. */
  const readStored = (file: string): number | undefined => {
    let text: string;
    try {
      text = readFileSync(file, "utf8").trim();
    } catch (error) {
      // No file yet is a fresh start. Any other failure is a real problem: an unreadable offset
      // replays up to 24 hours of updates, so it is named rather than swallowed.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        warn(
          "load",
          `telegram-offset at ${file} is unreadable (${String((error as Error).message)}); restarting from 0`,
        );
      return undefined;
    }
    // An empty file is a write that did not finish, not offset 0: `Number("")` is 0 and would
    // otherwise pass every check and silently replay the whole retained history.
    if (!STORED.test(text)) {
      warn(
        "load",
        `telegram-offset at ${file} is not a stored offset (${JSON.stringify(text.slice(0, 40))}); restarting from 0`,
      );
      return undefined;
    }
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n < 0) {
      warn(
        "load",
        `telegram-offset at ${file} is not a stored offset (${JSON.stringify(text.slice(0, 40))}); restarting from 0`,
      );
      return undefined;
    }
    return n;
  };

  return {
    load(): number {
      if (handled !== undefined) return handled;
      const own = readStored(cursorPath);
      if (own !== undefined) {
        handled = own;
        return own;
      }
      // First start for this bot: adopt the shared file an earlier release wrote, if it is still there.
      // A shared cursor cannot be attributed to a bot, so it is only a starting point — the next save
      // writes this bot's own file and the shared one is never touched again.
      if (cursorPath !== path && !existsSync(cursorPath)) {
        const legacy = readStored(path);
        if (legacy !== undefined) {
          warn(
            "load",
            `telegram-offset at ${path} predates per-bot cursors; adopting ${legacy} for bot ${owner ?? "?"} into ${cursorPath}`,
          );
          handled = legacy;
          return legacy;
        }
      }
      return 0;
    },
    save(offset: number): void {
      handled = offset;
      try {
        writeWhole(cursorPath, String(offset));
      } catch (error) {
        // The update was delivered; failing to record it must not deliver it again this run.
        warn(
          "save",
          `telegram-offset at ${cursorPath} not saved (${String((error as Error).message)}); continuing from memory for this run`,
        );
      }
    },
  };
};
