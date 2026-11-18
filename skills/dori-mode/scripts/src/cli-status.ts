import { homedir } from "node:os";
import { BoardError, type BoardTarget, updateBoard } from "./board.ts";
import { type Command, die } from "./cli-context.ts";
import { laneEta, laneStatus, StatusError } from "./status.ts";
import { renderBoard, renderStatus } from "./status-render.ts";

const status: Command = async ({ key, values, deps }) => {
  const snapshot = await laneStatus(deps, key);
  console.log(
    values["json"]
      ? JSON.stringify(snapshot, null, 2)
      : `${renderStatus(snapshot)}\nOBSERVED ${snapshot.observedAt} (read-only)`,
  );
};

const eta: Command = async ({ key, values, deps }) => {
  const prefix = key?.trim() || die("eta needs a nonempty lane-key prefix");
  const estimate = laneEta(await deps.registry.list(), prefix);
  console.log(
    values["json"]
      ? JSON.stringify(estimate)
      : estimate.medianMinutes === null
        ? `ETA ${prefix}: insufficient history (n=${estimate.samples}; need 3)`
        : `ETA ${prefix}: p50 ${estimate.medianMinutes}m, range ${estimate.minMinutes}-${estimate.maxMinutes}m, n=${estimate.samples} (historical elapsed time, not a promise)`,
  );
};

const board: Command = async ({ key, values, need, opt, loopMinutes, deps, config }) => {
  if (key !== "discord" && key !== "telegram") return die("board needs discord or telegram");
  const minutes = loopMinutes();
  const messageId = opt("message");
  if (values["message"] !== undefined && !/^[1-9]\d*$/.test(messageId ?? ""))
    die("--message must be a positive decimal message ID");
  const thread = opt("thread");
  let target: BoardTarget;
  if (key === "discord") {
    if (values["to"] !== undefined && values["thread"] !== undefined) return die("choose --to or --thread, not both");
    const to = values["thread"] !== undefined ? (thread ?? "") : need("to");
    if (!/^[1-9]\d*$/.test(to)) die("board destination must be a positive decimal Discord ID");
    target = { platform: key, to };
  } else {
    const to = need("to");
    if (!/^-?[1-9]\d*$/.test(to)) die("board --to must be a numeric Telegram chat ID");
    if (values["thread"] !== undefined && (!/^[1-9]\d*$/.test(thread ?? "") || !Number.isSafeInteger(Number(thread))))
      die("board --thread must be a positive Telegram topic ID");
    if (messageId && !Number.isSafeInteger(Number(messageId))) die("--message must be a safe Telegram message ID");
    target = { platform: key, to, ...(thread ? { thread: Number(thread) } : {}) };
  }
  const name = key === "discord" ? "DORI_DISCORD_TOKEN" : "DORI_TELEGRAM_TOKEN";
  const token = process.env[name] ?? die(`${name} is not set`);
  let recovery = messageId;
  for (;;) {
    const snapshot = await laneStatus(deps, opt("lane"));
    const result = await updateBoard({
      stateDir: config.stateDir,
      target,
      token,
      clock: deps.clock,
      body: renderBoard(snapshot, homedir(), key === "discord" ? 1960 : 4056),
      ...(recovery ? { messageId: recovery } : {}),
    });
    console.log(`BOARD ${key} ${result.action} ${result.messageId}`);
    recovery = undefined;
    if (minutes === 0) return;
    await deps.clock.sleep(minutes * 60_000);
  }
};

export const statusErrors = [StatusError, BoardError] as const;
export const statusCommands: Readonly<Record<string, Command>> = { status, board, eta };
