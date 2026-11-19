/** The Discord Gateway plumbing shared by `dori presence discord` and `dori inbound discord --gateway`. */
import { die, every } from "./cli-context.ts";
import { Discord } from "./messenger/discord.ts";
import { DiscordChannels, inboundContext } from "./messenger/discord-channels.ts";
import type { GatewayClock, GatewaySocket } from "./messenger/discord-gateway.ts";
import { discordInbound, formatDiscordInbound, formatInboundContext } from "./messenger/discord-inbound.ts";
import { type Emit, isTransient } from "./messenger/discord-inbound-api.ts";
import { discordInboundLive } from "./messenger/discord-inbound-live.ts";
import { discordInboundQueue } from "./messenger/discord-inbound-queue.ts";
import { discordInboundEnv } from "./messenger/discord-inbound-state.ts";
import { fetchHttp } from "./messenger/http.ts";
import { headEmitter, reconcileHead } from "./messenger/head-admission.ts";
import { recordOwes } from "./owes.ts";
import { realClock } from "./run.ts";

export const openDiscordSocket = (url: string): GatewaySocket => {
  const ws = new WebSocket(url);
  return {
    send: (data) => ws.send(data),
    close: (code) => ws.close(code),
    onMessage: (cb) => ws.addEventListener("message", (event) => cb(String(event.data))),
    onClose: (cb) => ws.addEventListener("close", (event) => cb(event.code)),
    onError: (cb) => ws.addEventListener("error", () => cb()),
  };
};

export const discordClock: GatewayClock = {
  now: realClock.now,
  random: Math.random,
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Waits for a Gateway connection to end, closing it on SIGINT or SIGTERM. */
export const untilStopped = async (gateway: { done: Promise<void>; close(): void }): Promise<void> => {
  const stop = () => gateway.close();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await gateway.done;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    gateway.close();
  }
};

const idList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");

/**
 * Configured parents follow active threads unless DORI_DISCORD_THREADS=off; scope all keeps its own discovery.
 * `context` adds the channel, thread, topic and recorded purposes to each single stdout group.
 */
export const discordInboundCommand = async (
  stateDir: string,
  gateway: boolean,
  pollMinutes: number,
  context = false,
) => {
  const env = process.env;
  const ownerId = discordInboundEnv("DORI_DISCORD_OWNER_ID", env["DORI_DISCORD_OWNER_ID"]);
  const scope = env["DORI_DISCORD_SCOPE"]?.trim();
  if (scope !== undefined && scope !== "" && scope !== "all") die("DORI_DISCORD_SCOPE must be all or unset");
  const all = scope === "all";
  const setting = env["DORI_DISCORD_THREADS"]?.trim().toLowerCase();
  if (setting !== undefined && setting !== "" && setting !== "off" && setting !== "on")
    die("DORI_DISCORD_THREADS must be on, off or unset");
  const threads = setting !== "off";
  const channelIds = ["DORI_DISCORD_CHANNEL_ID", "DORI_DISCORD_CHANNEL_IDS"].flatMap((name) =>
    idList(env[name]).map((id) => discordInboundEnv(name, id)),
  );
  if (!all && channelIds.length === 0) discordInboundEnv("DORI_DISCORD_CHANNEL_ID", env["DORI_DISCORD_CHANNEL_ID"]);
  const token = env["DORI_DISCORD_TOKEN"] || die("DORI_DISCORD_TOKEN is not set");
  const queue = discordInboundQueue(stateDir, env["DORI_MONITOR_ADMISSION"] === "1");
  // A dead head must not leave an idle receiver holding the SQLite owner lock.
  const disconnected = () => {
    queue.close();
    process.exit(1);
  };
  if (env["DORI_MONITOR_ADMISSION"] === "1") process.once("disconnect", disconnected);
  try {
    await reconcileHead(queue);
    if (!gateway && queue.first())
      die("Discord inbound has pending Gateway work; restart with --gateway before REST mode");
    const discord = new Discord(fetchHttp, realClock, token);
    const intake = await discordInbound(discord, queue.storeFor, {
      ownerId,
      channelIds: [...new Set(channelIds)],
      all,
      threads,
    });
    const watching = all ? "all" : intake.channels().join(",");
    const where = context ? inboundContext(discord, new DiscordChannels(stateDir), realClock.now) : undefined;
    // The owe and complete context group precede native receipt, cursor and exact-ID ACK.
    const emit: Emit = headEmitter(queue, intake.botId, ownerId, async (message, signal) => {
      const text = where
        ? `${formatDiscordInbound(message)}\n${formatInboundContext(message, await where(message.channel))}`
        : formatDiscordInbound(message);
      await recordOwes(stateDir, text, Date.now(), signal);
      signal?.throwIfAborted();
      return text;
    });
    console.log(
      `INBOUND_READY discord owner=${ownerId} channel=${watching} bot=${intake.botId}${gateway ? " mode=gateway" : ""}`,
    );
    if (!gateway) return await every(pollMinutes, () => intake.poll(emit), isTransient);
    await untilStopped(
      discordInboundLive(intake, openDiscordSocket, token, discordClock, emit, (l) => console.log(l), queue),
    );
  } finally {
    process.off("disconnect", disconnected);
    queue.close();
  }
};
