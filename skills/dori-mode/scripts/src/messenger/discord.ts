import type { Clock } from "../run.ts";
import { discordApiBase } from "./discord-api-base.ts";
import { DEFAULT_RETRY, DeliveryUncertainError, guardText, type Http, MessengerError, withBackoff } from "./http.ts";
import { DISCORD_LIMIT, splitForDiscord } from "./split.ts";

const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

const discordErrorCode = (body: string): string | undefined => {
  try {
    const parsed = JSON.parse(body) as { code?: unknown } | null;
    return typeof parsed?.code === "number" ? String(parsed.code) : undefined;
  } catch {
    return undefined;
  }
};

export type DcChannel = {
  readonly id: string;
  readonly type: number;
  readonly name?: string;
  readonly topic?: string | null;
  readonly parent_id?: string | null;
  readonly available_tags?: readonly { readonly id: string; readonly name: string }[];
  readonly flags?: number;
  readonly owner_id?: string;
  readonly message?: { readonly id: string };
};

export type ThreadCreated = (thread: DcChannel) => Promise<void>;

/** Forum and media channels contain posts, each represented by a thread. */
export const isForumType = (type: number): boolean => type === 15 || type === 16;

const responseId = (body: { readonly id?: unknown } | null, operation: string): string => {
  if (typeof body?.id !== "string" || !body.id)
    throw new DeliveryUncertainError(`${operation}: missing remote ID`, 200);
  return body.id;
};

/** Only these channel types give parent_id the meaning of a thread parent. */
export const isThreadType = (type: unknown): boolean => type === 10 || type === 11 || type === 12;

export class Discord {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = discordApiBase(process.env["DORI_DISCORD_API_BASE"]),
  ) {}

  async call<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await withBackoff(
      this.http,
      this.clock,
      {
        method,
        operation: `discord ${method} ${path}`,
        url: `${this.base}${path}`,
        headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(signal === undefined ? {} : { signal }),
      },
      // Cancellable live metadata owns its existing 2s–30s retry outside this single HTTP attempt.
      signal === undefined ? undefined : { ...DEFAULT_RETRY, attempts: 1 },
      retryAfter,
    );
    if (res.status >= 300)
      throw new MessengerError(
        `discord ${method} ${path}: ${res.status} ${res.body.slice(0, 160)}`,
        res.status,
        discordErrorCode(res.body),
      );
    try {
      return (res.body ? JSON.parse(res.body) : {}) as T;
    } catch (error) {
      if (method !== "GET") throw new DeliveryUncertainError(`discord ${method} ${path}`, res.status);
      throw error;
    }
  }

  /**
   * Posts the text as consecutive messages of at most 2000 characters (`splitForDiscord`) and returns their IDs in
   * order. `replyTo` makes the first message a reply that pings nobody; a deleted target still posts, unlinked. A failed
   * part stops the rest; its error names the parts already posted, which stay.
   */
  async send(channelId: string, content: string, opts: { readonly replyTo?: string } = {}): Promise<string[]> {
    return await this.post(channelId, splitForDiscord(guardText(content)), opts.replyTo);
  }

  /** `before`: messages of the same text already posted (a forum starter), counted in a failure's part numbers. */
  private async post(
    channelId: string,
    parts: readonly string[],
    replyTo?: string,
    before: readonly string[] = [],
  ): Promise<string[]> {
    const ids: string[] = [...before];
    const total = before.length + parts.length;
    for (const part of parts) {
      const reference =
        ids.length === 0 && replyTo !== undefined
          ? { message_reference: { message_id: replyTo, fail_if_not_exists: false } }
          : {};
      try {
        const sent = await this.call<{ id: string }>("POST", `/channels/${channelId}/messages`, {
          content: part,
          allowed_mentions: { parse: [] },
          ...reference,
        });
        ids.push(responseId(sent, `discord POST /channels/${channelId}/messages`));
      } catch (e) {
        if (ids.length === 0) throw e;
        // Any failure after a posted part, a transport error or an unreadable answer included, names what stays.
        const why = e instanceof MessengerError ? e.message : `discord POST /channels/${channelId}/messages failed`;
        throw new MessengerError(
          `${why} (part ${ids.length + 1} of ${total}; already posted: ${ids.join(" ")})`,
          e instanceof MessengerError ? e.status : 0,
          e instanceof MessengerError ? e.code : undefined,
          e instanceof MessengerError ? e.outcome : "uncertain",
        );
      }
    }
    return ids;
  }

  /** One message is edited in place: text over the limit is refused before any request, never split. */
  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    const guarded = guardText(content);
    if (guarded.length > DISCORD_LIMIT)
      throw new MessengerError(
        `discord edit: text exceeds ${DISCORD_LIMIT} UTF-16 code units; shorten the text or send without --edit`,
        400,
      );
    responseId(
      await this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, { content: guarded }),
      `discord PATCH /channels/${channelId}/messages/${messageId}`,
    );
  }

  async typing(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  async startThread(channelId: string, messageId: string, name: string, created?: ThreadCreated): Promise<string> {
    const thread = await this.call<DcChannel>("POST", `/channels/${channelId}/messages/${messageId}/threads`, {
      name: guardText(name).slice(0, 100),
    });
    const id = responseId(thread, `discord POST /channels/${channelId}/messages/${messageId}/threads`);
    if (created) await created(thread);
    return id;
  }

  async setThread(
    threadId: string,
    patch: { readonly name?: string; readonly archived?: boolean; readonly appliedTags?: readonly string[] },
  ): Promise<string> {
    return responseId(
      await this.call("PATCH", `/channels/${threadId}`, {
        ...(patch.name ? { name: guardText(patch.name).slice(0, 100) } : {}),
        ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
        ...(patch.appliedTags !== undefined ? { applied_tags: patch.appliedTags } : {}),
      }),
      `discord PATCH /channels/${threadId}`,
    );
  }

  /** Forum posts include a starter message; text-channel threads optionally receive one after creation. */
  async createThread(
    channel: DcChannel,
    name: string,
    opts: { readonly text?: string; readonly appliedTags?: readonly string[]; readonly created?: ThreadCreated } = {},
  ): Promise<{ readonly id: string; readonly messageId?: string }> {
    const title = guardText(name).slice(0, 100);
    const text = opts.text === undefined ? undefined : guardText(opts.text);
    if (isForumType(channel.type)) {
      // The starter message holds the first part; longer text continues as messages in the new post.
      const [starter = "", ...more] = splitForDiscord(text ?? name);
      const thread = await this.call<DcChannel>("POST", `/channels/${channel.id}/threads`, {
        name: title,
        message: { content: starter, allowed_mentions: { parse: [] } },
        ...(opts.appliedTags !== undefined ? { applied_tags: opts.appliedTags } : {}),
      });
      responseId(thread, `discord POST /channels/${channel.id}/threads`);
      if (opts.created) await opts.created(thread);
      if (thread.message !== undefined) responseId(thread.message, `discord forum starter ${thread.id}`);
      if (more.length > 0)
        await this.post(thread.id, more, undefined, thread.message === undefined ? [] : [thread.message.id]);
      return { id: thread.id, ...(thread.message === undefined ? {} : { messageId: thread.message.id }) };
    }
    const thread = await this.call<DcChannel>("POST", `/channels/${channel.id}/threads`, {
      name: title,
      type: 11,
    });
    responseId(thread, `discord POST /channels/${channel.id}/threads`);
    if (opts.created) await opts.created(thread);
    return text === undefined ? { id: thread.id } : { id: thread.id, ...(await this.firstOf(thread.id, text)) };
  }

  /** A thread on an existing message, then optional text inside it. */
  async threadOnMessage(
    channelId: string,
    messageId: string,
    name: string,
    text?: string,
    created?: ThreadCreated,
  ): Promise<{ readonly id: string; readonly messageId?: string }> {
    const guarded = text === undefined ? undefined : guardText(text);
    const id = await this.startThread(channelId, messageId, name, created);
    return guarded === undefined ? { id } : { id, ...(await this.firstOf(id, guarded)) };
  }

  /** Sends text into a new thread and names its first message, the one a `mid=` refers to. */
  private async firstOf(threadId: string, text: string): Promise<{ readonly messageId?: string }> {
    const [first] = await this.send(threadId, text);
    return first === undefined ? {} : { messageId: first };
  }

  /** Add or remove the bot's own reaction, using Discord's URL-encoded emoji route. */
  async react(channelId: string, messageId: string, emoji: string, remove = false): Promise<void> {
    await this.call(
      remove ? "DELETE" : "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    );
  }

  channel(id: string): Promise<DcChannel> {
    return this.call<DcChannel>("GET", `/channels/${id}`);
  }

  guildChannels(guildId: string): Promise<readonly DcChannel[]> {
    return this.call<readonly DcChannel[]>("GET", `/guilds/${guildId}/channels`);
  }
}
