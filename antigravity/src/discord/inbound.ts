import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../core/config.js";
import { Decisions } from "../core/decisions.js";
import { atomicWriteFile, withFileLock } from "../core/fs-utils.js";
import { DiscordChannels, type InboundContext, resolveInboundContext } from "./channels.js";
import type { DcAttachment, DcChannel, DcMessage, DiscordClient } from "./client.js";

export type InboundMessageRecord = {
  readonly channelId: string;
  readonly messageId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly timestamp: string;
  readonly content: string;
  readonly replyToMessageId?: string;
  readonly replyToContent?: string;
  readonly matchedDecisionId?: string;
  readonly parsedCommand?: { readonly name: string; readonly args: string };
  readonly autoAcked?: boolean;
  readonly attachments: readonly {
    readonly filename: string;
    readonly size: number;
    readonly contentType?: string;
    readonly url: string;
    readonly localPath?: string;
  }[];
  readonly context?: InboundContext;
};

export type PollResult = {
  readonly messages: readonly InboundMessageRecord[];
  readonly baselinedChannels: readonly string[];
  readonly polledChannels: readonly string[];
  readonly warnings: readonly string[];
};

export type ObligationRecord = {
  readonly messageId: string;
  readonly channelId: string;
  readonly receivedAt: string;
  readonly eyesReacted: boolean;
  readonly replied: boolean;
};

const DEFAULT_THREAD_CACHE_TTL_MS = 25_000;
type ThreadCacheEntry = { readonly threads: readonly DcChannel[]; readonly expiresAt: number };
const threadCache = new Map<string, ThreadCacheEntry>();

export function clearThreadCache(): void {
  threadCache.clear();
}

function compareSnowflake(a: string, b: string): number {
  const ba = BigInt(a);
  const bb = BigInt(b);
  return ba < bb ? -1 : ba > bb ? 1 : 0;
}

export class DiscordInboundState {
  readonly cursorsPath: string;
  readonly obligationsPath: string;

  constructor(readonly stateDir: string) {
    this.cursorsPath = join(stateDir, "discord-cursors.json");
    this.obligationsPath = join(stateDir, "discord-obligations.json");
  }

  readCursors(): Record<string, string> {
    if (!existsSync(this.cursorsPath)) return {};
    return JSON.parse(readFileSync(this.cursorsPath, "utf8")) as Record<string, string>;
  }

  saveCursors(cursors: Record<string, string>): void {
    withFileLock(`${this.cursorsPath}.lock`, () => {
      atomicWriteFile(this.cursorsPath, `${JSON.stringify(cursors, null, 2)}\n`);
    });
  }

  advanceCursors(updates: Readonly<Record<string, string>>): Record<string, string> {
    return withFileLock(`${this.cursorsPath}.lock`, () => {
      const current = this.readCursors();
      let changed = false;
      for (const [channelId, msgId] of Object.entries(updates)) {
        if (!msgId) continue;
        const prev = current[channelId];
        if (!prev || compareSnowflake(msgId, prev) > 0) {
          current[channelId] = msgId;
          changed = true;
        }
      }
      if (changed) {
        atomicWriteFile(this.cursorsPath, `${JSON.stringify(current, null, 2)}\n`);
      }
      return current;
    });
  }

  readObligations(): ObligationRecord[] {
    if (!existsSync(this.obligationsPath)) return [];
    return JSON.parse(readFileSync(this.obligationsPath, "utf8")) as ObligationRecord[];
  }

  recordObligation(channelId: string, messageId: string, now = Date.now()): void {
    withFileLock(`${this.obligationsPath}.lock`, () => {
      const list = this.readObligations();
      if (list.some((o) => o.messageId === messageId)) return;
      list.push({
        channelId,
        messageId,
        receivedAt: new Date(now).toISOString(),
        eyesReacted: false,
        replied: false,
      });
      atomicWriteFile(this.obligationsPath, `${JSON.stringify(list.slice(-100), null, 2)}\n`);
    });
  }

  markEyesReacted(messageId: string): void {
    withFileLock(`${this.obligationsPath}.lock`, () => {
      const list = this.readObligations().map((o) => (o.messageId === messageId ? { ...o, eyesReacted: true } : o));
      atomicWriteFile(this.obligationsPath, `${JSON.stringify(list, null, 2)}\n`);
    });
  }

  markMessageReplied(messageId: string): void {
    withFileLock(`${this.obligationsPath}.lock`, () => {
      const list = this.readObligations().map((o) => (o.messageId === messageId ? { ...o, replied: true } : o));
      atomicWriteFile(this.obligationsPath, `${JSON.stringify(list, null, 2)}\n`);
    });
  }

  markChannelReplied(channelId: string): void {
    withFileLock(`${this.obligationsPath}.lock`, () => {
      const list = this.readObligations().map((o) => (o.channelId === channelId ? { ...o, replied: true } : o));
      atomicWriteFile(this.obligationsPath, `${JSON.stringify(list, null, 2)}\n`);
    });
  }

  pendingObligations(): ObligationRecord[] {
    return this.readObligations().filter((o) => !o.eyesReacted || !o.replied);
  }
}

export async function pollDiscordInbound(
  client: DiscordClient,
  stateDir: string,
  opts: {
    readonly ownerId?: string;
    readonly channelIds?: readonly string[];
    readonly guildId?: string;
    readonly followThreads?: boolean;
    readonly includeContext?: boolean;
    readonly includeHistoryOnFirstPoll?: boolean;
    readonly threadCacheTtlMs?: number;
    readonly catalyHome?: string;
  } = {},
): Promise<PollResult> {
  const cfg = loadConfig(opts.catalyHome).discord;
  const ownerId = opts.ownerId ?? cfg.ownerId;
  if (!ownerId) {
    throw new Error("Discord ownerId is not configured. Set it via cataly_config_set (discord.ownerId).");
  }

  const baseChannels = [...(opts.channelIds ?? cfg.channelIds ?? [])];
  if (baseChannels.length === 0) {
    throw new Error("No Discord channelIds configured. Set discord.channelIds via cataly_config_set.");
  }

  const warnings: string[] = [];
  const allChannels = new Set<string>(baseChannels);
  const followThreads = opts.followThreads ?? cfg.followThreads ?? true;
  const guildId = opts.guildId ?? cfg.guildId;
  const threadCacheTtlMs = opts.threadCacheTtlMs ?? DEFAULT_THREAD_CACHE_TTL_MS;

  if (followThreads && guildId) {
    const now = Date.now();
    const cached = threadCacheTtlMs > 0 ? threadCache.get(guildId) : undefined;
    let activeThreads: readonly DcChannel[] | undefined;
    if (cached && cached.expiresAt > now) {
      activeThreads = cached.threads;
    } else {
      try {
        activeThreads = await client.activeGuildThreads(guildId);
        if (threadCacheTtlMs > 0) {
          threadCache.set(guildId, { threads: activeThreads, expiresAt: Date.now() + threadCacheTtlMs });
        }
      } catch (e) {
        warnings.push(`failed to list active guild threads: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (activeThreads) {
      for (const th of activeThreads) {
        if (th.parent_id && allChannels.has(th.parent_id)) {
          allChannels.add(th.id);
        }
      }
    }
  }

  const state = new DiscordInboundState(stateDir);
  const channelsStore = new DiscordChannels(stateDir);
  const decisionsStore = new Decisions(stateDir);
  const cursors = state.readCursors();
  const cursorUpdates: Record<string, string> = {};
  const baselinedChannels: string[] = [];
  const polledChannels: string[] = [];
  const messages: InboundMessageRecord[] = [];

  const channelList = [...allChannels];
  const CONCURRENCY = 4;
  const fetchedPerChannel: { channelId: string; fetched?: DcMessage[]; error?: string }[] = Array.from({
    length: channelList.length,
  });
  let nextIdx = 0;

  const workers = Array.from({ length: Math.min(CONCURRENCY, channelList.length) }, async () => {
    while (nextIdx < channelList.length) {
      const i = nextIdx++;
      const channelId = channelList[i]!;
      const cursor = cursors[channelId];
      try {
        const fetched = await client.messages(channelId, cursor ? { after: cursor, limit: 50 } : { limit: 10 });
        fetchedPerChannel[i] = { channelId, fetched };
      } catch (e) {
        fetchedPerChannel[i] = { channelId, error: e instanceof Error ? e.message : String(e) };
      }
    }
  });
  await Promise.all(workers);

  for (const entry of fetchedPerChannel) {
    const { channelId, fetched, error } = entry;
    polledChannels.push(channelId);
    if (error || !fetched) {
      warnings.push(`channel ${channelId} poll failed: ${error ?? "unknown error"}`);
      continue;
    }

    const cursor = cursors[channelId];
    const sorted = [...fetched].sort((a, b) => compareSnowflake(a.id, b.id));
    const latestId = sorted.at(-1)?.id;

    if (!cursor && !opts.includeHistoryOnFirstPoll) {
      if (latestId) cursorUpdates[channelId] = latestId;
      baselinedChannels.push(channelId);
      continue;
    }

    if (latestId && (!cursor || compareSnowflake(latestId, cursor) > 0)) {
      cursorUpdates[channelId] = latestId;
    }

    const ownerMessages = sorted.filter((m) => m.author.id === ownerId && !m.author.bot);
    for (const msg of ownerMessages) {
      const context = opts.includeContext ? await resolveInboundContext(client, channelsStore, channelId) : undefined;
      const attachments = (msg.attachments ?? []).map((a: DcAttachment) => ({
        filename: a.filename,
        size: a.size,
        ...(a.content_type ? { contentType: a.content_type } : {}),
        url: a.url,
      }));
      const replyId = msg.message_reference?.message_id;
      const matched = replyId
        ? (decisionsStore.match(replyId) ?? decisionsStore.match(`discord:${channelId}/${replyId}`))
        : null;

      messages.push({
        channelId,
        messageId: msg.id,
        authorId: msg.author.id,
        authorName: msg.author.global_name || msg.author.username,
        timestamp: msg.timestamp,
        content: msg.content,
        ...(replyId ? { replyToMessageId: replyId } : {}),
        ...(msg.referenced_message?.content ? { replyToContent: msg.referenced_message.content } : {}),
        ...(matched ? { matchedDecisionId: matched.id } : {}),
        attachments,
        ...(context ? { context } : {}),
      });
      state.recordObligation(channelId, msg.id);
    }
  }

  state.advanceCursors(cursorUpdates);
  return { messages, baselinedChannels, polledChannels, warnings };
}
