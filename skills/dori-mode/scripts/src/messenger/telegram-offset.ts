import { existsSync, readFileSync, rmSync } from "node:fs";

import { writeWhole as durableWrite } from "./durable-write.ts";

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
  const writeWhole = (target: string, text: string): void =>
    durableWrite(
      target,
      text,
      () => dirReady,
      () => {
        dirReady = true;
      },
    );

  return {
    load(): number {
      if (handled !== undefined) return handled;
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
      // A bot transition writes a marker before it touches either file and removes it after both have
      // landed. While it exists the pair is not a settled snapshot, and the sidecar may still name the
      // bot a rollback would use, so nothing here can be trusted under any token. `sidecarBot` is read
      // first so a save can complete the transition and clear the marker rather than leaving it forever.
      if (existsSync(`${path}.pending`)) {
        warn(
          "load",
          `telegram-offset at ${path} was mid-transition to another bot (${path}.pending); restarting from 0 rather than trusting a cursor and a bot that may disagree`,
        );
        return 0;
      }
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
      // The cached bot is not authoritative: a receiver replaced on the same state dir leaves this one
      // believing the sidecar still names it, and writing its cursor beside the other bot's id is the
      // discard this whole mechanism prevents. The file is the truth, so it is re-read before the cache
      // is trusted. A read per save is cheaper than the write that follows it.
      const persisted = (): string | undefined => {
        try {
          const text = readFileSync(`${path}.bot`, "utf8").trim();
          return BOT_ID.test(text) ? text : undefined;
        } catch {
          return undefined;
        }
      };
      const tag = (): boolean => {
        if (bot === undefined) return false;
        if (bot === persisted()) {
          sidecarBot = bot;
          return true;
        }
        try {
          writeWhole(`${path}.bot`, bot);
          sidecarBot = bot;
          return true;
        } catch (error) {
          warn(
            "save",
            `telegram-offset bot id at ${path}.bot not saved (${String((error as Error).message)}); a token swap will not be detected`,
          );
          return false;
        }
      };
      const onDisk = persisted();
      // A sidecar that exists but cannot be read leaves the bot unknown, which is as unsafe as a
      // mismatch: treat it as a transition so the marker makes every reader refuse the pair.
      const unknown = onDisk === undefined && existsSync(`${path}.bot`);
      // A sidecar naming another bot is a transition. With no sidecar yet (a fresh install, or an
      // upgrade from a release that never wrote one) the bot is simply recorded, and the cursor is not
      // written unless that lands: an untagged cursor is accepted under any token by the next start.
      const changed = unknown || (onDisk !== undefined && bot !== undefined && onDisk !== bot);
      // The marker goes down before either file and comes off after both name this bot, so a crash
      // anywhere between leaves it and every start refuses the pair. A marker left by an earlier process
      // is completed here too, rather than pinning every future start at 0.
      const marking = bot !== undefined && (changed || existsSync(`${path}.pending`));
      if (marking) {
        try {
          writeWhole(`${path}.pending`, bot);
        } catch {
          // Without the marker the transition cannot be made safe, so nothing else is written.
          return;
        }
      }
      // The bot record always goes before the cursor. A release from before this sidecar existed reads
      // the bare cursor with `Number(...)` and ignores the marker, so leaving the OLD cursor in place
      // until the tag has switched is what keeps a rollback to it from adopting a cursor that is not its
      // own; only after the tag lands can the cursor safely become this bot's.
      if (bot !== undefined && !tag()) return;
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
      // The marker goes last: while it exists every reader of this version refuses the pair.
      if (marking) {
        try {
          rmSync(`${path}.pending`, { force: true });
        } catch {
          // a leftover marker only costs one restart from 0
        }
      }
    },
  };
};
