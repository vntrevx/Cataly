import type { Discord } from "./discord.ts";
import type { InboundContext } from "./discord-channels.ts";
import {
  type DiscordInbound,
  discoverChannels,
  type Emit,
  inboundProtocolError,
  inboundRequest,
  isOwnerMessage,
  type Message,
  messagePage,
  toInbound,
} from "./discord-inbound-api.ts";
import type { DiscordInboundQueue } from "./discord-inbound-queue.ts";
import { discordInboundEnv, type DiscordInboundStore, isDiscordSnowflake } from "./discord-inbound-state.ts";
import { MessengerError } from "./http.ts";

export type { DiscordInbound } from "./discord-inbound-api.ts";
export type DiscordInboundOptions = {
  ownerId: string;
  /** Channels and threads that must be reachable; a failure on one of them is an error. */
  channelIds: readonly string[];
  /** Also watch every text channel, active thread and the owner DM the bot can see; inaccessible ones are skipped. */
  all?: boolean;
};

/** Formats one unchanged text line followed by reply and attachment records for the existing single emit. */
export const formatDiscordInbound = (message: DiscordInbound): string => {
  const id = `discord ${message.channel} ${message.message}`;
  return [
    `INBOUND ${id} from=owner ref=${message.reference ?? "-"} ${JSON.stringify(message.text)}`,
    ...(message.replyTo ? [`INBOUND_REPLY ${id} ${JSON.stringify(message.replyTo)}`] : []),
    ...message.attachments.map((attachment) => `INBOUND_ATTACHMENT ${id} ${JSON.stringify(attachment)}`),
  ].join("\n");
};

/** The `--context` record that ends a message's group: where it was posted and the purposes recorded there. */
export const formatInboundContext = (message: DiscordInbound, context: InboundContext): string =>
  `INBOUND_CONTEXT discord ${message.channel} ${message.message} ${JSON.stringify(context)}`;

const newer = (a: string, b: string): boolean => BigInt(a) > BigInt(b);
const unavailable = (error: unknown): boolean =>
  error instanceof MessengerError && (error.status === 403 || error.status === 404);

/**
 * Bot-authenticated intake with per-channel cursors. Known REST and queued owners merge in ID order before each
 * delivery boundary; an older frame admitted during an awaited emit can arrive late without regressing the cursor.
 * Emit-before-checkpoint crashes and ambiguous legacy queue recovery can repeat a request. Presence is separate.
 */
export const discordInbound = async (
  discord: Discord,
  storeFor: (channelId: string, seed?: boolean) => DiscordInboundStore,
  opts: DiscordInboundOptions,
) => {
  const ownerId = discordInboundEnv("DORI_DISCORD_OWNER_ID", opts.ownerId);
  const explicit = opts.channelIds.map((id) => discordInboundEnv("DORI_DISCORD_CHANNEL_IDS", id));
  const request = inboundRequest(discord);
  const me = await request<{ id?: string; bot?: boolean }>("/users/@me");
  if (me?.bot !== true || !isDiscordSnowflake(me.id)) {
    throw new MessengerError("Discord inbound requires an authenticated bot identity; use a bot token", 401);
  }
  const botId = me.id;
  if (botId === ownerId)
    throw new MessengerError("DORI_DISCORD_OWNER_ID must identify the human owner, not the bot", 0);
  const application = await request<{ flags?: number }>("/applications/@me");
  const flags = application?.flags;
  if (typeof flags !== "number" || !Number.isSafeInteger(flags) || (flags & ((1 << 18) | (1 << 19))) === 0) {
    throw new MessengerError(
      "Discord inbound needs Message Content Intent enabled for this bot in the Developer Portal",
      403,
    );
  }
  const watched = new Map<string, DiscordInboundStore>();
  const current = (store: DiscordInboundStore): string => {
    const cursor = store.load();
    if (cursor === undefined)
      throw new MessengerError("Discord inbound cursor disappeared; restore its state before retrying", 0);
    return cursor;
  };
  /** Only history-read failures can make a discovered channel unavailable, never state or delivery failures. */
  const readPage = async (channelId: string, limit: number, before?: string) => {
    try {
      return await messagePage(request, channelId, limit, before);
    } catch (error) {
      if (explicit.includes(channelId) || !unavailable(error)) throw error;
      watched.delete(channelId);
      return undefined;
    }
  };
  const attach = async (channelId: string): Promise<void> => {
    const store = storeFor(channelId);
    const cursor = store.load();
    const latest = await readPage(channelId, 1); // Also verifies channel access before readiness.
    if (latest === undefined) return;
    if (latest.some((message) => message.channel_id !== channelId)) {
      throw inboundProtocolError("Discord inbound channel response does not match the configured channel");
    }
    if (cursor === undefined) store.save(latest[0]?.id ?? "0"); // Cold start skips existing history.
    watched.set(channelId, store);
  };
  const refresh = async (): Promise<void> => {
    for (const id of explicit) if (!watched.has(id)) await attach(id);
    if (!opts.all) return;
    for (const id of await discoverChannels(request, ownerId)) {
      if (watched.has(id)) continue;
      await attach(id);
    }
  };
  const accepts = (message: Message): boolean =>
    !!message &&
    isDiscordSnowflake(message.id) &&
    isDiscordSnowflake(message.channel_id) &&
    (opts.all === true || watched.has(message.channel_id));
  const deliver = async (message: Message, store: DiscordInboundStore, emit: Emit, cursor = message.id) => {
    if (isOwnerMessage(message, ownerId, botId)) await emit(toInbound(message));
    store.save(cursor); // Checkpoint only after successful delivery; a late frame never moves it backwards.
  };
  const accept = async (message: Message, emit: Emit, admittedAfter?: string | null): Promise<void> => {
    if (!accepts(message)) return;
    if (admittedAfter !== undefined && admittedAfter !== null && admittedAfter !== "0")
      discordInboundEnv("Discord inbound queue admission cursor", admittedAfter);
    let store = watched.get(message.channel_id);
    if (!store) {
      store = storeFor(message.channel_id);
      if (store.load() === undefined) store.save(String(BigInt(message.id) - 1n));
      watched.set(message.channel_id, store);
    }
    const cursor = current(store);
    if (
      !newer(message.id, cursor) &&
      (admittedAfter === undefined ||
        message.id === cursor ||
        (admittedAfter !== null && !newer(message.id, admittedAfter)) ||
        !isOwnerMessage(message, ownerId, botId))
    )
      return;
    await deliver(message, store, emit, newer(message.id, cursor) ? message.id : cursor);
  };
  const pollChannel = async (
    channelId: string,
    store: DiscordInboundStore,
    emit: Emit,
    queue?: DiscordInboundQueue,
  ): Promise<void> => {
    const after = current(store);
    const latest = await readPage(channelId, 1);
    if (latest === undefined) return;
    if (latest.some((message) => message.channel_id !== channelId)) {
      throw inboundProtocolError("Discord inbound channel response does not match the configured channel");
    }
    const head = latest[0];
    // No REST gap: leave retained queue records and their admission cursors for the FIFO drain.
    if (!head || !newer(head.id, after)) return;
    // Keep the probed message even if it disappears before the full history read.
    const pending = new Map<string, Message>([[head.id, head]]);
    let before: string | undefined;
    for (;;) {
      const messages = await readPage(channelId, 100, before);
      if (messages === undefined) return;
      let oldest: string | undefined;
      for (const message of messages) {
        if (oldest === undefined || newer(oldest, message.id)) oldest = message.id;
        if (message.channel_id === channelId && newer(message.id, after) && !pending.has(message.id)) {
          pending.set(message.id, message);
        }
      }
      if (before !== undefined && oldest !== undefined && !newer(before, oldest)) {
        throw inboundProtocolError("Discord inbound pagination did not advance");
      }
      if (messages.length < 100 || oldest === undefined || !newer(oldest, after)) break;
      before = oldest;
    }
    const ordered = [...pending.values()].sort((a, b) => (newer(a.id, b.id) ? 1 : newer(b.id, a.id) ? -1 : 0));
    for (const [index, message] of ordered.entries()) {
      // An owner checkpoint covers the preceding filtered run; only a trailing run needs its own save.
      if (!isOwnerMessage(message, ownerId, botId) && index !== ordered.length - 1) continue;
      if (queue) {
        let after = "0";
        let row = 0;
        for (
          let job = queue.nextOwner(channelId, ownerId, message.id, after, row);
          job;
          job = queue.nextOwner(channelId, ownerId, message.id, after, row)
        ) {
          const retained = JSON.parse(job.payload) as Message;
          if (!accepts(retained)) throw inboundProtocolError("Discord inbound queue message is invalid");
          after = retained.id;
          row = job.id;
          if (!isOwnerMessage(retained, ownerId, botId)) continue;
          await accept(retained, emit, job.admittedAfter);
          queue.acknowledge(channelId, retained.id);
          after = "0"; // Recheck arrivals admitted while the previous owner emit was awaited.
          row = 0;
        }
      }
      if (newer(message.id, current(store))) {
        await deliver(message, store, emit);
        queue?.acknowledge(channelId, message.id);
      }
    }
  };
  await refresh();
  let polls = 0;
  return {
    botId,
    accepts,
    cursorFor(channel: string): string | undefined {
      const store = watched.get(channel);
      return store ? current(store) : storeFor(channel, false).load();
    },
    channels: (): string[] => [...watched.keys()],
    /** Reads every watched channel from its cursor; the REST path and the Gateway backfill. */
    async poll(emit: Emit, queue?: DiscordInboundQueue): Promise<void> {
      if (opts.all && ++polls % 100 === 0) await refresh(); // Pick up channels and threads created since start.
      for (const [channelId, store] of [...watched]) await pollChannel(channelId, store, emit, queue);
    },
    /** Reconciles the watched set, then reads each channel from its cursor; used after a Gateway (re)connect. */
    async sync(emit: Emit, queue?: DiscordInboundQueue): Promise<void> {
      await refresh();
      if (opts.all && queue) {
        for (let channel = queue.nextChannel(""); channel !== undefined; channel = queue.nextChannel(channel))
          if (!watched.has(channel)) await attach(channel);
      }
      await this.poll(emit, queue);
    },
    /** Direct calls retain the cursor gate; queued calls supply their persisted admission position. */
    accept,
  };
};
