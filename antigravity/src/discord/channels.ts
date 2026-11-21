import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, isSingleLine, withFileLock } from "../core/fs-utils.js";
import { type DcChannel, type DiscordClient, isDiscordSnowflake } from "./client.js";

export type ChannelPurpose = {
  readonly purpose: string;
  readonly name?: string;
  readonly updatedAt: string;
};

export type InboundContext = {
  readonly channel: {
    readonly id: string;
    readonly name?: string;
    readonly topic?: string;
    readonly dm?: true;
    readonly purpose: string | null;
  };
  readonly thread: {
    readonly id: string;
    readonly name?: string;
    readonly purpose: string | null;
  } | null;
  readonly error?: string;
};

const THREAD_TYPES = new Set([10, 11, 12]);
const DM_TYPES = new Set([1, 3]);

const CHANNEL_CACHE_TTL_MS = 60_000;
const CHANNEL_CACHE_MAX_ENTRIES = 500;
const DEFAULT_LOOKUP_TIMEOUT_MS = 5_000;

type ChannelCacheEntry = {
  readonly channel: DcChannel;
  readonly expiresAt: number;
};

const channelCache = new Map<string, ChannelCacheEntry>();

export function clearChannelCache(): void {
  channelCache.clear();
}

function getCachedChannel(id: string, now: number): DcChannel | undefined {
  const entry = channelCache.get(id);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    channelCache.delete(id);
    return undefined;
  }
  return entry.channel;
}

function setCachedChannel(id: string, channel: DcChannel, ttlMs: number, now: number): void {
  if (ttlMs <= 0) return;
  if (channelCache.has(id)) {
    channelCache.delete(id);
  } else if (channelCache.size >= CHANNEL_CACHE_MAX_ENTRIES) {
    for (const [key, entry] of channelCache) {
      if (entry.expiresAt <= now) channelCache.delete(key);
    }
    if (channelCache.size >= CHANNEL_CACHE_MAX_ENTRIES) {
      const oldestKey = channelCache.keys().next().value;
      if (oldestKey !== undefined) channelCache.delete(oldestKey);
    }
  }
  channelCache.set(id, { channel, expiresAt: now + ttlMs });
}

async function fetchChannelWithTimeout(client: DiscordClient, id: string, timeoutMs: number): Promise<DcChannel> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client.channel(id),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`channel lookup timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export class DiscordChannels {
  readonly path: string;

  constructor(readonly stateDir: string) {
    this.path = join(stateDir, "discord-channels.json");
  }

  read(): Record<string, ChannelPurpose> {
    if (!existsSync(this.path)) return {};
    return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, ChannelPurpose>;
  }

  set(id: string, purpose: string, name?: string, now = Date.now()): ChannelPurpose {
    if (!isDiscordSnowflake(id)) throw new Error(`invalid Discord ID: ${id}`);
    const trimmed = purpose.trim();
    if (!isSingleLine(trimmed, 500)) throw new Error("purpose must be a single line of 1..500 characters");
    return withFileLock(`${this.path}.lock`, () => {
      const all = this.read();
      const entry: ChannelPurpose = {
        purpose: trimmed,
        ...(name?.trim() ? { name: name.trim() } : {}),
        updatedAt: new Date(now).toISOString(),
      };
      all[id] = entry;
      atomicWriteFile(this.path, `${JSON.stringify(all, null, 2)}\n`);
      return entry;
    });
  }

  clear(id: string): boolean {
    return withFileLock(`${this.path}.lock`, () => {
      const all = this.read();
      if (!(id in all)) return false;
      delete all[id];
      atomicWriteFile(this.path, `${JSON.stringify(all, null, 2)}\n`);
      return true;
    });
  }
}

export async function resolveInboundContext(
  client: DiscordClient,
  channels: DiscordChannels,
  channelId: string,
  opts: { readonly timeoutMs?: number; readonly ttlMs?: number } = {},
): Promise<InboundContext> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
  const ttlMs = opts.ttlMs ?? CHANNEL_CACHE_TTL_MS;
  const errors: string[] = [];
  let purposes: Record<string, ChannelPurpose> = {};
  try {
    purposes = channels.read();
  } catch {
    errors.push("channel purposes unreadable");
  }
  const purpose = (id: string): string | null => purposes[id]?.purpose ?? null;

  const describe = async (id: string): Promise<DcChannel | undefined> => {
    const now = Date.now();
    const cached = ttlMs > 0 ? getCachedChannel(id, now) : undefined;
    if (cached) return cached;
    try {
      const fetched = await fetchChannelWithTimeout(client, id, timeoutMs);
      setCachedChannel(id, fetched, ttlMs, Date.now());
      return fetched;
    } catch (e) {
      errors.push(`channel lookup failed for ${id}: ${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    }
  };

  const here = await describe(channelId);
  if (here && DM_TYPES.has(here.type)) {
    return {
      channel: { id: channelId, dm: true, purpose: purpose(channelId) },
      thread: null,
      ...(errors.length ? { error: errors.join("; ") } : {}),
    };
  }
  if (here && THREAD_TYPES.has(here.type) && typeof here.parent_id === "string") {
    const parent = await describe(here.parent_id);
    return {
      channel: {
        id: here.parent_id,
        ...(parent?.name ? { name: parent.name } : {}),
        ...(parent?.topic ? { topic: parent.topic } : {}),
        purpose: purpose(here.parent_id),
      },
      thread: {
        id: channelId,
        ...(here.name ? { name: here.name } : {}),
        purpose: purpose(channelId),
      },
      ...(errors.length ? { error: errors.join("; ") } : {}),
    };
  }

  return {
    channel: {
      id: channelId,
      ...(here?.name ? { name: here.name } : {}),
      ...(here?.topic ? { topic: here.topic } : {}),
      purpose: purpose(channelId),
    },
    thread: null,
    ...(errors.length ? { error: errors.join("; ") } : {}),
  };
}
