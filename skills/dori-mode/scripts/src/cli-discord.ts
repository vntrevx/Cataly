/** The Discord Gateway plumbing shared by `dori presence discord` and `dori inbound discord --gateway`. */
import { die, every } from "./cli-context.ts";
import { Discord } from "./messenger/discord.ts";
import { DiscordChannels, inboundContext } from "./messenger/discord-channels.ts";
import type { GatewayClock, GatewaySocket } from "./messenger/discord-gateway.ts";
import { routeDiscordAskReply } from "./messenger/discord-ask-mailbox.ts";
import { discordInbound, formatDiscordInbound, formatInboundContext } from "./messenger/discord-inbound.ts";
import type { Emit } from "./messenger/discord-inbound-api.ts";
import { discordInboundLive } from "./messenger/discord-inbound-live.ts";
import { discordInboundQueue } from "./messenger/discord-inbound-queue.ts";
import { discordInboundOptions } from "./messenger/discord-inbound-env.ts";
import { fetchHttp } from "./messenger/http.ts";
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

/**
 * Configured parents follow active threads unless DORI_DISCORD_THREADS=off; scope all keeps its own discovery.
 * `context` adds the channel, thread, topic and recorded purposes to each single stdout group.
 */
export const discordInboundCommand = async (
  stateDir: string,
  gateway: boolean,
  pollMinutes: number,
  context = false,
  attachmentRefs = false,
) => {
  const env = process.env;
  const options = discordInboundOptions(env);
  const { ownerId, all } = options;
  const token = env["DORI_DISCORD_TOKEN"] || die("DORI_DISCORD_TOKEN is not set");
  const queue = discordInboundQueue(stateDir);
  try {
    if (!gateway && queue.first())
      die("Discord inbound has pending Gateway work; restart with --gateway before REST mode");
    const discord = new Discord(fetchHttp, realClock, token);
    const intake = await discordInbound(discord, queue.storeFor, options);
    const watching = all ? "all" : intake.channels().join(",");
    const where = context ? inboundContext(discord, new DiscordChannels(stateDir), realClock.now) : undefined;
    // Context and the owner line remain one stdout group, after the owe is published.
    const emit: Emit = async (message, signal) => {
      signal?.throwIfAborted();
      const line = formatDiscordInbound(message, attachmentRefs);
      if (routeDiscordAskReply(stateDir, message, ownerId)) return;
      const text = where ? `${line}\n${formatInboundContext(message, await where(message.channel))}` : line;
      await recordOwes(stateDir, text, Date.now(), signal);
      signal?.throwIfAborted();
      console.log(text);
    };
    console.log(
      `INBOUND_READY discord owner=${ownerId} channel=${watching} bot=${intake.botId}${gateway ? " mode=gateway" : ""}`,
    );
    if (!gateway) return await every(pollMinutes, () => intake.poll(emit));
    await untilStopped(
      discordInboundLive(intake, openDiscordSocket, token, discordClock, emit, (l) => console.log(l), queue),
    );
  } finally {
    queue.close();
  }
};
