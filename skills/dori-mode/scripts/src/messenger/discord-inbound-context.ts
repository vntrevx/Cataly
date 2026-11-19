/** Bounded channel metadata and local purpose context; neither is an owner instruction. */
import { type DcChannel, type Discord, isThreadType } from "./discord.ts";
import type { DiscordChannels } from "./discord-channels.ts";
import { MessengerError } from "./http.ts";

export type InboundContext = {
  readonly channel: {
    readonly id: string;
    readonly name?: string;
    readonly topic?: string;
    readonly dm?: true;
    readonly purpose: string | null;
  };
  readonly thread: { readonly id: string; readonly name?: string; readonly purpose: string | null } | null;
  readonly error?: string;
};

const DM_TYPES = new Set([1, 3]);
const CACHE_MS = 60_000;
/** Most lookups held at once; a burst across more channels than this in one minute evicts the oldest. */
const CACHE_MAX = 500;
const TIMED_OUT = Symbol("timed out");

/**
 * Resolves where a message was posted, never throwing: a thread is named under its parent channel, each with its own
 * recorded purpose, and a DM is marked as one. Channel lookups are cached for a minute and bounded by `timeoutMs`. A
 * failed or late lookup or an unreadable purpose file still returns a record, with what is known and an `error` that
 * names the failure without echoing a response body.
 */
export const inboundContext = (discord: Discord, channels: DiscordChannels, now: () => number, timeoutMs = 5_000) => {
  // One lookup per channel per minute, shared while in flight: a failure or a hang is remembered too, so a burst of
  // owner messages in a broken channel makes one request, not one per message.
  type Entry = { readonly at: number; readonly value: Promise<DcChannel>; settled: boolean };
  const cache = new Map<string, Entry>();
  const lookup = (id: string): { readonly value: Promise<DcChannel>; readonly stuck: boolean } => {
    const hit = cache.get(id);
    if (hit && now() - hit.at < CACHE_MS)
      return { value: hit.value, stuck: !hit.settled && now() - hit.at >= timeoutMs };
    // A long-running intake meets many channels and threads once: drop every expired entry, and past the cap the
    // oldest, so the cache holds at most the channels of the last minute, never more than CACHE_MAX.
    for (const [key, old] of cache) if (now() - old.at >= CACHE_MS) cache.delete(key);
    cache.delete(id);
    for (const key of cache.keys()) {
      if (cache.size < CACHE_MAX) break;
      cache.delete(key);
    }
    const entry: Entry = { at: now(), value: discord.channel(id), settled: false };
    const settle = () => {
      entry.settled = true;
    };
    entry.value.then(settle, settle);
    cache.set(id, entry);
    return { value: entry.value, stuck: false };
  };
  const where = async (channelId: string): Promise<InboundContext> => {
    const errors: string[] = [];
    let purposes: ReturnType<DiscordChannels["read"]> = {};
    try {
      purposes = channels.read();
    } catch {
      errors.push("channel purposes unreadable");
    }
    const purpose = (id: string): string | null => purposes[id]?.purpose ?? null;
    /** The channel as looked up, or its ID and purpose alone when the lookup fails. */
    const described = async (id: string): Promise<DcChannel | undefined> => {
      // Retries and a hung connection must not hold the owner's message: past the bound it goes out without them.
      const pending = lookup(id);
      if (pending.stuck) {
        errors.push("channel lookup timed out");
        return undefined;
      }
      const late = Promise.withResolvers<typeof TIMED_OUT>();
      const timer = setTimeout(() => late.resolve(TIMED_OUT), timeoutMs);
      try {
        const found = await Promise.race([pending.value, late.promise]);
        if (found !== TIMED_OUT) return found;
        errors.push("channel lookup timed out");
      } catch (e) {
        errors.push(`channel lookup failed${e instanceof MessengerError && e.status > 0 ? ` (HTTP ${e.status})` : ""}`);
      } finally {
        clearTimeout(timer);
      }
      return undefined;
    };
    const channel = (id: string, c: DcChannel | undefined): InboundContext["channel"] => ({
      id,
      ...(typeof c?.name === "string" ? { name: c.name } : {}),
      ...(typeof c?.topic === "string" && c.topic !== "" ? { topic: c.topic } : {}),
      purpose: purpose(id),
    });
    const here = await described(channelId);
    let record: Omit<InboundContext, "error">;
    if (here && DM_TYPES.has(here.type))
      record = { channel: { id: channelId, dm: true, purpose: purpose(channelId) }, thread: null };
    else if (here && isThreadType(here.type) && typeof here.parent_id === "string") {
      const thread = {
        id: channelId,
        ...(typeof here.name === "string" ? { name: here.name } : {}),
        purpose: purpose(channelId),
      };
      record = { channel: channel(here.parent_id, await described(here.parent_id)), thread };
    } else record = { channel: channel(channelId, here), thread: null };
    return errors.length ? { ...record, error: errors.join("; ") } : record;
  };
  /** `cached()`: how many lookups are held, so the eviction can be checked. */
  return Object.assign(where, { cached: (): number => cache.size });
};
