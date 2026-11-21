import { loadConfig } from "../core/config.js";
import { Decisions } from "../core/decisions.js";
import { downloadDiscordAttachment } from "./attachments.js";
import { DiscordChannels, resolveInboundContext } from "./channels.js";
import type { DcAttachment, DcMessage, DiscordClient } from "./client.js";
import { parseDiscordCommand, runLocalDiscordCommand } from "./commands.js";
import { DiscordInboundState, type InboundMessageRecord, pollDiscordInbound } from "./inbound.js";

// GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | DIRECT_MESSAGES (1<<12) | MESSAGE_CONTENT (1<<15)
export const CATALY_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

export type MinimalWebSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
};

export type WebSocketFactory = (url: string) => MinimalWebSocket;

export type GatewayWaitOptions = {
  readonly botToken: string;
  readonly client: DiscordClient;
  readonly stateDir: string;
  readonly catalyHome?: string;
  readonly timeoutMs?: number; // 0 = unlimited
  readonly debounceMs?: number; // default 700; 0 disables burst coalescing
  readonly maxDebounceMs?: number; // default 2000; hard cap for coalescing window
  readonly includeContext?: boolean;
  readonly downloadAttachments?: boolean;
  readonly autoAck?: boolean;
  readonly handleLocalCommands?: boolean;
  readonly activityName?: string;
  readonly wsFactory?: WebSocketFactory;
  readonly onStatus?: (status: string) => void;
};

export type GatewayWaitResult =
  { readonly kind: "messages"; readonly messages: readonly InboundMessageRecord[] } | { readonly kind: "timeout" };

type GatewayPayload = {
  op: number;
  d: unknown;
  s?: number | null;
  t?: string | null;
};

const DEFAULT_DEBOUNCE_MS = 700;
const DEFAULT_MAX_DEBOUNCE_MS = 2000;

function compareSnowflake(a: string, b: string): number {
  const ba = BigInt(a);
  const bb = BigInt(b);
  return ba < bb ? -1 : ba > bb ? 1 : 0;
}

const defaultWsFactory: WebSocketFactory = (url) => new WebSocket(url) as unknown as MinimalWebSocket;

/**
 * Connect to Discord Gateway v10 WebSocket with online presence, backfill any missed messages via REST on READY,
 * and resolve immediately (<100ms) when an owner message arrives in a watched channel or its threads.
 */
export async function waitForDiscordGateway(opts: GatewayWaitOptions): Promise<GatewayWaitResult> {
  const cfg = loadConfig(opts.catalyHome).discord;
  const ownerId = cfg.ownerId;
  if (!ownerId) throw new Error("Discord ownerId is not configured");
  const watchedParents = new Set(cfg.channelIds ?? []);
  if (watchedParents.size === 0) throw new Error("No Discord channelIds configured");
  const followThreads = cfg.followThreads ?? true;

  // 1. Immediate REST backfill before opening socket so messages sent while offline arrive instantly
  const backfill = await pollDiscordInbound(opts.client, opts.stateDir, {
    includeContext: opts.includeContext ?? true,
    catalyHome: opts.catalyHome,
  });
  if (backfill.messages.length > 0) {
    const remaining: InboundMessageRecord[] = [];
    const backfillState = new DiscordInboundState(opts.stateDir);
    for (const m of backfill.messages) {
      const parsed = parseDiscordCommand(m.content);
      if (opts.handleLocalCommands && parsed?.localZeroToken) {
        const res = runLocalDiscordCommand(parsed, opts.stateDir, opts.catalyHome);
        if (res.handled && res.reply) {
          const [reactRes, sendRes] = await Promise.allSettled([
            opts.client.react(m.channelId, m.messageId, "👀"),
            opts.client.send(m.channelId, res.reply, { replyTo: m.messageId }),
          ]);
          if (reactRes.status === "fulfilled") {
            backfillState.markEyesReacted(m.messageId);
          } else {
            opts.onStatus?.(`LOCAL_COMMAND_REACT_FAILED /${parsed.name}`);
          }
          if (sendRes.status === "fulfilled") {
            backfillState.markMessageReplied(m.messageId);
            opts.onStatus?.(`LOCAL_COMMAND_HANDLED /${parsed.name}`);
            continue;
          }
          opts.onStatus?.(
            `LOCAL_COMMAND_SEND_FAILED /${parsed.name}: ${sendRes.reason instanceof Error ? sendRes.reason.message : String(sendRes.reason)}`,
          );
        }
      }
      remaining.push(parsed ? { ...m, parsedCommand: { name: parsed.name, args: parsed.args } } : m);
    }
    if (remaining.length > 0) {
      return { kind: "messages", messages: await finalizeInboundMessages(remaining, opts) };
    }
  }

  let gatewayUrl = "wss://gateway.discord.gg/?v=10&encoding=json";
  try {
    const gw = await opts.client.gatewayBot();
    if (gw.url) {
      gatewayUrl = gw.url.includes("?") ? `${gw.url}&v=10&encoding=json` : `${gw.url}/?v=10&encoding=json`;
    }
  } catch {
    // use default gateway URL
  }

  const state = new DiscordInboundState(opts.stateDir);
  const channelsStore = new DiscordChannels(opts.stateDir);
  const wsFactory = opts.wsFactory ?? defaultWsFactory;
  const timeoutMs = opts.timeoutMs ?? 0;
  const debounceMs =
    opts.debounceMs === undefined
      ? DEFAULT_DEBOUNCE_MS
      : Number.isFinite(opts.debounceMs) && opts.debounceMs > 0
        ? Math.round(opts.debounceMs)
        : 0;
  const maxDebounceMs =
    opts.maxDebounceMs === undefined
      ? DEFAULT_MAX_DEBOUNCE_MS
      : Number.isFinite(opts.maxDebounceMs) && opts.maxDebounceMs > 0
        ? Math.round(opts.maxDebounceMs)
        : DEFAULT_MAX_DEBOUNCE_MS;
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Number.POSITIVE_INFINITY;
  const activityName = opts.activityName ?? "Antigravity Cataly";

  return new Promise<GatewayWaitResult>((resolvePromise, rejectPromise) => {
    let settled = false;
    let flushing = false;
    let ws: MinimalWebSocket | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    let firstBufferedAt: number | null = null;
    const pendingRecords: InboundMessageRecord[] = [];
    const seenMessageIds = new Set<string>();
    const inFlight = new Set<Promise<void>>();
    let seq: number | null = null;
    let consecutiveFailures = 0;

    const cleanup = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      heartbeatTimer = null;
      timeoutTimer = null;
      reconnectTimer = null;
      debounceTimer = null;
      if (ws) {
        try {
          ws.close(1000, "done");
        } catch {
          // ignore
        }
        ws = null;
      }
    };

    const finish = (result: GatewayWaitResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise(result);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(err);
    };

    const flushPending = async (timeoutIfEmpty = false) => {
      if (settled || flushing) return;
      flushing = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
      if (settled) return;
      if (pendingRecords.length === 0) {
        flushing = false;
        if (timeoutIfEmpty) {
          finish({ kind: "timeout" });
        }
        return;
      }
      const batch = pendingRecords
        .splice(0, pendingRecords.length)
        .sort((a, b) => compareSnowflake(a.messageId, b.messageId));
      firstBufferedAt = null;
      try {
        const messages = await maybeAttachDownloads(batch, opts);
        const cursorUpdates: Record<string, string> = {};
        for (const rec of messages) {
          const prev = cursorUpdates[rec.channelId];
          if (!prev || compareSnowflake(rec.messageId, prev) > 0) {
            cursorUpdates[rec.channelId] = rec.messageId;
          }
        }
        state.advanceCursors(cursorUpdates);
        for (const rec of messages) {
          state.recordObligation(rec.channelId, rec.messageId);
          if (rec.autoAcked) {
            state.markEyesReacted(rec.messageId);
          }
        }
        finish({ kind: "messages", messages });
      } catch (err) {
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    };

    const handleTimeout = () => {
      if (settled || flushing) return;
      void flushPending(true);
    };

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(handleTimeout, timeoutMs);
    }

    const isWatchedChannel = async (channelId: string): Promise<boolean> => {
      if (watchedParents.has(channelId)) return true;
      if (!followThreads) return false;
      try {
        const ch = await opts.client.channel(channelId);
        if (ch.parent_id && watchedParents.has(ch.parent_id)) {
          return true;
        }
      } catch {
        // ignore lookup errors
      }
      return false;
    };

    const connect = () => {
      if (settled) return;
      if (Date.now() >= deadline) {
        handleTimeout();
        return;
      }
      ws = wsFactory(gatewayUrl);

      ws.addEventListener("message", (rawEvent: unknown) => {
        if (settled || flushing) return;
        const data =
          typeof rawEvent === "object" && rawEvent !== null && "data" in rawEvent
            ? String((rawEvent as { data: unknown }).data)
            : String(rawEvent);
        let payload: GatewayPayload;
        try {
          payload = JSON.parse(data) as GatewayPayload;
        } catch {
          return;
        }
        if (typeof payload.s === "number") seq = payload.s;

        // op 10: HELLO -> start heartbeat & IDENTIFY with online presence
        if (payload.op === 10) {
          const interval = Number((payload.d as { heartbeat_interval?: number })?.heartbeat_interval ?? 41_250);
          if (heartbeatTimer) clearInterval(heartbeatTimer);
          heartbeatTimer = setInterval(() => {
            if (ws && ws.readyState === 1) {
              ws.send(JSON.stringify({ op: 1, d: seq }));
            }
          }, interval);
          heartbeatTimer.unref?.();

          ws?.send(
            JSON.stringify({
              op: 2,
              d: {
                token: opts.botToken,
                intents: CATALY_GATEWAY_INTENTS,
                properties: { os: process.platform, browser: "cataly-antigravity", device: "cataly-antigravity" },
                presence: {
                  since: null,
                  activities: [{ name: activityName, type: 3 }],
                  status: "online",
                  afk: false,
                },
              },
            }),
          );
          return;
        }

        // op 1: server requests immediate heartbeat
        if (payload.op === 1 && ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ op: 1, d: seq }));
          return;
        }

        // op 7 RECONNECT or op 9 INVALID_SESSION -> close & reconnect cleanly
        if (payload.op === 7 || payload.op === 9) {
          try {
            ws?.close(4000, "reconnect");
          } catch {
            // ignore
          }
          return;
        }

        // op 0 DISPATCH
        if (payload.op === 0 && payload.t === "READY") {
          consecutiveFailures = 0;
          opts.onStatus?.("GATEWAY_ONLINE");
          return;
        }

        if (payload.op === 0 && payload.t === "MESSAGE_CREATE") {
          const msg = payload.d as DcMessage;
          if (!msg?.author || msg.author.id !== ownerId || msg.author.bot) return;
          if (settled || flushing) return;
          if (seenMessageIds.has(msg.id)) return;
          const savedCursor = state.readCursors()[msg.channel_id];
          if (savedCursor && compareSnowflake(msg.id, savedCursor) <= 0) return;
          seenMessageIds.add(msg.id);

          let selfTask!: Promise<void>;
          selfTask = (async () => {
            try {
              if (!(await isWatchedChannel(msg.channel_id))) return;
              if (settled) return;

              const parsedCmd = parseDiscordCommand(msg.content);
              if (opts.handleLocalCommands && parsedCmd?.localZeroToken) {
                const localRes = runLocalDiscordCommand(parsedCmd, opts.stateDir, opts.catalyHome);
                if (localRes.handled && localRes.reply) {
                  const [reactRes, sendRes] = await Promise.allSettled([
                    opts.client.react(msg.channel_id, msg.id, "👀"),
                    opts.client.send(msg.channel_id, localRes.reply, { replyTo: msg.id }),
                  ]);
                  if (reactRes.status !== "fulfilled") {
                    opts.onStatus?.(`LOCAL_COMMAND_REACT_FAILED /${parsedCmd.name}`);
                  }
                  if (sendRes.status === "fulfilled") {
                    state.advanceCursors({ [msg.channel_id]: msg.id });
                    state.recordObligation(msg.channel_id, msg.id);
                    if (reactRes.status === "fulfilled") {
                      state.markEyesReacted(msg.id);
                    }
                    state.markMessageReplied(msg.id);
                    opts.onStatus?.(`LOCAL_COMMAND_HANDLED /${parsedCmd.name}`);
                    return;
                  }
                  opts.onStatus?.(
                    `LOCAL_COMMAND_SEND_FAILED /${parsedCmd.name}: ${sendRes.reason instanceof Error ? sendRes.reason.message : String(sendRes.reason)}`,
                  );
                  return;
                }
              }

              // Fire instant 👀 read-receipt + typing indicator in parallel with context lookup (<200ms UX)
              const ackPromise = opts.autoAck
                ? Promise.allSettled([
                    opts.client.react(msg.channel_id, msg.id, "👀").then(() => true),
                    opts.client.typing(msg.channel_id),
                  ]).then((res) => res[0]?.status === "fulfilled" && res[0].value === true)
                : Promise.resolve(false);

              const [autoAcked, context] = await Promise.all([
                ackPromise,
                (opts.includeContext ?? true)
                  ? resolveInboundContext(opts.client, channelsStore, msg.channel_id)
                  : Promise.resolve(undefined),
              ]);
              const decisions = new Decisions(opts.stateDir);
              const replyId = msg.message_reference?.message_id;
              const matched = replyId
                ? (decisions.match(replyId) ?? decisions.match(`discord:${msg.channel_id}/${replyId}`))
                : null;

              const attachments = (msg.attachments ?? []).map((a: DcAttachment) => ({
                filename: a.filename,
                size: a.size,
                ...(a.content_type ? { contentType: a.content_type } : {}),
                url: a.url,
              }));

              const record: InboundMessageRecord = {
                channelId: msg.channel_id,
                messageId: msg.id,
                authorId: msg.author.id,
                authorName: msg.author.global_name || msg.author.username,
                timestamp: msg.timestamp,
                content: msg.content,
                ...(replyId ? { replyToMessageId: replyId } : {}),
                ...(msg.referenced_message?.content ? { replyToContent: msg.referenced_message.content } : {}),
                ...(matched ? { matchedDecisionId: matched.id } : {}),
                ...(parsedCmd ? { parsedCommand: { name: parsedCmd.name, args: parsedCmd.args } } : {}),
                ...(autoAcked ? { autoAcked: true } : {}),
                attachments,
                ...(context ? { context } : {}),
              };

              if (settled) return;
              pendingRecords.push(record);
              if (flushing) return;

              if (parsedCmd || debounceMs <= 0) {
                inFlight.delete(selfTask);
                void flushPending(false);
                return;
              }
              const now = Date.now();
              if (firstBufferedAt === null) {
                firstBufferedAt = now;
              }
              if (debounceTimer) {
                clearTimeout(debounceTimer);
                debounceTimer = null;
              }
              const maxRemaining = Math.max(0, firstBufferedAt + maxDebounceMs - now);
              const waitMs = Math.min(debounceMs, maxRemaining);
              if (waitMs <= 0) {
                inFlight.delete(selfTask);
                void flushPending(false);
                return;
              }
              debounceTimer = setTimeout(() => {
                debounceTimer = null;
                void flushPending(false);
              }, waitMs);
            } catch {
              // Leave cursor untouched so next REST backfill can recover cleanly
            }
          })().finally(() => {
            inFlight.delete(selfTask);
          });
          inFlight.add(selfTask);
        }
      });

      ws.addEventListener("error", () => {
        // close event will handle reconnect / fallback
      });

      ws.addEventListener("close", (ev: unknown) => {
        if (settled) return;
        if (heartbeatTimer) {
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
        }
        const closeCode =
          typeof ev === "object" && ev !== null && "code" in ev ? Number((ev as { code: unknown }).code) : 1006;

        void (async () => {
          if (flushing) return;
          if (inFlight.size > 0 || pendingRecords.length > 0) {
            await flushPending(false);
            if (settled) return;
          }
          // Fatal auth/intent codes: do not spin forever; let caller fall back to REST
          if (closeCode === 4004 || closeCode === 4013 || closeCode === 4014) {
            fail(new Error(`Discord Gateway fatal close code ${closeCode}`));
            return;
          }
          consecutiveFailures++;
          if (consecutiveFailures >= 5) {
            fail(new Error(`Discord Gateway disconnected ${consecutiveFailures} times (last code ${closeCode})`));
            return;
          }
          const delayMs = Math.min(2000 * consecutiveFailures, 15_000);
          reconnectTimer = setTimeout(() => connect(), delayMs);
        })();
      });
    };

    connect();
  });
}

async function finalizeInboundMessages(
  messages: readonly InboundMessageRecord[],
  opts: GatewayWaitOptions,
): Promise<InboundMessageRecord[]> {
  const withAck = opts.autoAck
    ? await Promise.all(
        messages.map(async (m) => {
          const state = new DiscordInboundState(opts.stateDir);
          const [reactRes] = await Promise.allSettled([
            opts.client.react(m.channelId, m.messageId, "👀").then(() => {
              state.markEyesReacted(m.messageId);
              return true;
            }),
            opts.client.typing(m.channelId),
          ]);
          const acked = reactRes?.status === "fulfilled" && reactRes.value === true;
          return acked ? { ...m, autoAcked: true } : m;
        }),
      )
    : [...messages];
  return maybeAttachDownloads(withAck, opts);
}

async function maybeAttachDownloads(
  messages: readonly InboundMessageRecord[],
  opts: GatewayWaitOptions,
): Promise<InboundMessageRecord[]> {
  if (!opts.downloadAttachments) return [...messages];
  const out: InboundMessageRecord[] = [];
  for (const m of messages) {
    if (m.attachments.length === 0) {
      out.push(m);
      continue;
    }
    const enriched = await Promise.all(
      m.attachments.map(async (att) => {
        try {
          const dl = await downloadDiscordAttachment(att.url, opts.stateDir, {
            messageId: m.messageId,
            filename: att.filename,
          });
          return { ...att, localPath: dl.savedPath };
        } catch {
          return att;
        }
      }),
    );
    out.push({ ...m, attachments: enriched });
  }
  return out;
}
