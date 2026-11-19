import { inboundActivity, InboundActivityError } from "../../../../src/update/source-activity.ts";
import { type Command, die, envSlackToken, every, slackAuth } from "./cli-context.ts";
import { discordInboundCommand } from "./cli-discord.ts";
import { fetchHttp } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { pollSlackInbound } from "./messenger/slack-inbound.ts";
import { Telegram } from "./messenger/telegram.ts";
import { envInt, fileTgInboundStore, telegramInboundLoop } from "./messenger/telegram-inbound.ts";
import { inboundLagLog } from "./messenger/telegram-lag.ts";
import { formatTelegramInbound } from "./messenger/telegram-line.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { realClock } from "./run.ts";

const telegramInbound = async (stateDir: string, minutes: number, activityFile?: string): Promise<void> => {
  const tg = new Telegram(
    fetchHttp,
    realClock,
    process.env["DORI_TELEGRAM_TOKEN"] ?? die("DORI_TELEGRAM_TOKEN is not set"),
  );
  const store = fileTgInboundStore(`${stateDir}/telegram-offset`);
  const num = (name: string): number => {
    try {
      return envInt(name, process.env[name]);
    } catch (e) {
      return die(e instanceof Error ? e.message : String(e));
    }
  };
  const ownerId = num("DORI_TELEGRAM_OWNER_ID");
  // One warning per process: a token that cannot react must not flood the receiver log on every message.
  let reactWarned = false;
  const groupChatId = process.env["DORI_TELEGRAM_GROUP_ID"] === undefined ? undefined : num("DORI_TELEGRAM_GROUP_ID");
  const topicId = process.env["DORI_TELEGRAM_TOPIC_ID"] === undefined ? undefined : num("DORI_TELEGRAM_TOPIC_ID");
  // The INBOUND line stays exactly as monitors parse it; receive lag goes to its own jsonl.
  const recordLag = inboundLagLog(`${stateDir}/telegram-lag.jsonl`, (m) => console.log(`WARN ${m}`.slice(0, 300)));
  const activity = inboundActivity(activityFile, "telegram");
  try {
    console.log(`INBOUND_READY telegram owner=${ownerId} group=${groupChatId ?? "-"} topic=${topicId ?? "-"}`);
    await telegramInboundLoop(
      tg,
      store,
      {
        ownerId,
        ...(groupChatId !== undefined ? { groupChatId } : {}),
        ...(topicId !== undefined ? { topicId } : {}),
      },
      minutes,
      (i) => {
        activity?.received();
        console.log(formatTelegramInbound(i));
        recordLag(i, realClock.now());
        // Read receipt: the owner sees the message was picked up the moment it is received.
        // One reaction only (never a bubble — it would clear the typing indicator), and a
        // failed reaction must never cost the message, so it is warned once and dropped.
        if (i.kind === "message" && i.messageId !== undefined) {
          const target = {
            chatId: i.chat,
            ...(i.thread !== undefined && i.thread !== 1 ? { threadId: i.thread } : {}),
          };
          void tg.react(target, i.messageId, "\u{1F440}").catch((e: unknown) => {
            if (reactWarned) return;
            reactWarned = true;
            console.log(
              `WARN reaction failed (${e instanceof Error ? e.message : String(e)}); still answering`.slice(0, 300),
            );
          });
        }
      },
      (m) => console.log(`WARN ${m}`.slice(0, 300)),
      undefined,
      activity ? (available) => (available ? activity.healthy() : activity.unavailable()) : undefined,
    );
  } finally {
    activity?.close();
  }
};

export const inboundCommand: Command = async ({ key, loopMinutes, config, values }) => {
  const minutes = loopMinutes();
  const context = values["context"] === true;
  if (context && key !== "discord") die("--context is supported for discord only");
  const activityFile = values["activity-file"];
  if (activityFile !== undefined && typeof activityFile !== "string") return die("--activity-file must be a path");
  if (key === "telegram") return await telegramInbound(config.stateDir, minutes, activityFile);
  if (key === "discord")
    return await discordInboundCommand(
      config.stateDir,
      values["gateway"] === true,
      values["loop"] === undefined ? 3 / 60 : minutes,
      context,
      activityFile,
    );
  if (key !== "slack") die("inbound supports slack, telegram or discord");
  const auth = slackAuth(envSlackToken() ?? die("DORI_SLACK_TOKEN is not set (nor DORI_SLACK_TOKEN_FILE)"));
  const ledger = new ThreadLedger(`${config.stateDir}/slack-threads.json`);
  const slack = new Slack(fetchHttp, realClock, auth, undefined, ledger);
  const me = String((await slack.call("auth.test", {}))["user_id"] ?? die("auth.test returned no user_id"));
  const activity = inboundActivity(activityFile, "slack");
  console.log("INBOUND_READY slack");
  try {
    await every(
      minutes,
      async () => {
        try {
          // Full text, JSON-escaped on one line, as Telegram's: a monitor reads nothing but this line.
          const complete = await pollSlackInbound(slack, ledger, { selfUserId: me }, (i) => {
            activity?.received();
            console.log(
              `INBOUND ${i.source} ${i.channel} ${i.threadTs ?? "-"} ${i.ts || "-"} ${i.user ?? "-"} ${JSON.stringify(i.text ?? "")}`,
            );
          });
          if (complete) activity?.healthy();
          else activity?.unavailable();
        } catch (error) {
          if (error instanceof InboundActivityError) throw error;
          activity?.unavailable();
          throw error;
        }
      },
      (error) => error instanceof InboundActivityError,
    );
  } finally {
    activity?.close();
  }
};
