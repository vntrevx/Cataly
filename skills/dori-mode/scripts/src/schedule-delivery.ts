import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Discord } from "./messenger/discord.ts";
import { fetchHttp, type Http, MessengerError } from "./messenger/http.ts";
import { Slack } from "./messenger/slack.ts";
import { Telegram } from "./messenger/telegram.ts";
import { ThreadLedger } from "./messenger/thread-ledger.ts";
import { realClock } from "./run.ts";
import { scheduleOutput } from "./schedule-store.ts";
import { scheduleDestination, ScheduleError, type ScheduledJob, type ScheduleRun } from "./schedule-types.ts";
import { slackToken } from "./slack-token.ts";

export async function deliverSchedule(
  stateDir: string,
  job: ScheduledJob,
  receipt: ScheduleRun,
  stopped: AbortSignal,
  emit: (line: string) => unknown,
  http: Http = fetchHttp,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Pick<ScheduleRun, "delivery" | "receipts">> {
  if (job.deliver === "log") return { delivery: "logged" };
  stopped.throwIfAborted();
  const output = scheduleOutput(stateDir, receipt.id);
  const bytes = statSync(output).size;
  const body =
    bytes <= 65536 ? readFileSync(output, "utf8") : "Output exceeds 64 KiB; read the complete private log: " + output;
  const header = `[schedule] ${job.name} at=${new Date(receipt.at).toISOString()} exit=${receipt.code} signal=${receipt.signal ?? "none"} bytes=${bytes}\nlog=${output}`;
  let text = `${header}\n${body}`;
  if (job.deliver === "wake") {
    await emit("SCHEDULE_WAKE " + JSON.stringify({ name: job.name, run: receipt.id, text, output }));
    return { delivery: "wake-emitted" };
  }
  const target = scheduleDestination(job.deliver)!;
  // One report, not a burst of messages or provider-side truncation; the complete raw log stays on disk.
  if (text.length > 2000)
    text = `${header}\nOutput exceeds the single-post budget; read the complete private log above.`;
  if (text.length > 2000) throw new ScheduleError("schedule metadata exceeds the 2000-character post budget");
  // Scheduler delivery is single-attempt, unlike the shared messenger retry policy.
  // The post shares its deadline and the scheduler's cancellation generation.
  const signal = AbortSignal.any([stopped, AbortSignal.timeout(30_000)]);
  const once: Http = async (request) => {
    signal.throwIfAborted();
    const result = await http({ ...request, signal });
    if (result.status === 429 || result.status >= 500)
      throw new MessengerError("scheduled post was not confirmed; request not retried", result.status);
    return result;
  };
  const token = (key: string): string => {
    const value = env[key];
    if (!value) throw new ScheduleError(key + " is not set for scheduled delivery");
    return value;
  };
  if (target.platform === "discord") {
    const ids = await new Discord(once, realClock, token("DORI_DISCORD_TOKEN")).send(target.to, text);
    if (!ids.length || !ids.every((id) => typeof id === "string" && /^[1-9]\d+$/.test(id)))
      throw new ScheduleError("Discord scheduled post has no valid acknowledgement; it will not be retried");
    return { delivery: "posted", receipts: ids };
  }
  if (target.platform === "telegram") {
    const id = await new Telegram(once, realClock, token("DORI_TELEGRAM_TOKEN")).send(
      { chatId: target.to, ...(target.thread === undefined ? {} : { threadId: Number(target.thread) }) },
      text,
    );
    return { delivery: "posted", receipts: [String(id)] };
  }
  const auth = slackToken(env);
  if (!auth) throw new ScheduleError("DORI_SLACK_TOKEN or DORI_SLACK_TOKEN_FILE is required for scheduled delivery");
  const posted = await new Slack(
    once,
    realClock,
    { token: auth, ...(env["DORI_SLACK_COOKIE"] ? { cookie: env["DORI_SLACK_COOKIE"] } : {}) },
    undefined,
    new ThreadLedger(join(stateDir, "slack-threads.json")),
  ).post(target.to, text, target.thread);
  if (posted.channel !== target.to || !/^\d+\.\d+$/.test(posted.ts))
    throw new ScheduleError("Slack scheduled post has no matching acknowledgement; it will not be retried");
  return { delivery: "posted", receipts: [posted.channel + "/" + posted.ts] };
}
