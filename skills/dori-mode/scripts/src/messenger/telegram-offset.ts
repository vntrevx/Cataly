import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The persisted `getUpdates` cursor. An offset that reads back as 0 replays every update Telegram still
 * retains (24 hours), so a torn or unreadable file is reported rather than accepted as a fresh start.
 */
export type TgInboundStore = { load(): number; save(offset: number): void };

export const fileTgInboundStore = (path: string): TgInboundStore => {
  // load() runs on every poll; a corrupt file must warn once, not once per poll.
  let warned = false;
  const warn = (message: string): void => {
    if (warned) return;
    warned = true;
    // stdout like every other inbound WARN, so a monitor filtering stdout sees it.
    console.log(`WARN ${message} (warned once)`.slice(0, 300));
  };
  // The offset this process has already handled. A write that fails must not make the next poll
  // replay what was just delivered, so memory wins until a write lands.
  let handled: number | undefined;
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
          warn(`telegram-offset at ${path} is unreadable (${String((error as Error).message)}); restarting from 0`);
        return 0;
      }
      const n = Number(text);
      // An empty file is a write that did not finish, not offset 0: `Number("")` is 0 and would
      // otherwise pass every check and silently replay the whole retained history.
      if (text === "" || !Number.isSafeInteger(n) || n < 0) {
        warn(
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
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(staged, String(offset));
        // Write-then-rename: a kill or a full disk leaves the previous offset intact, never a
        // truncated file that reads back as 0.
        renameSync(staged, path);
      } catch (error) {
        // The update was delivered; failing to record it must not deliver it again this run.
        try {
          rmSync(staged, { force: true });
        } catch {
          // the staged copy is only ever a partial offset; leaving it is harmless
        }
        warn(
          `telegram-offset at ${path} not saved (${String((error as Error).message)}); continuing from memory for this run`,
        );
      }
    },
  };
};
