import type { Clock } from "../run.ts";
import { guardText, type Http, MessengerError, withBackoff } from "./http.ts";
import { DISCORD_LIMIT, splitForDiscord } from "./split.ts";

const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { retry_after?: number }).retry_after;
    return typeof n === "number" ? n : undefined;
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
};

/** Forum and media channels contain posts, each represented by a thread. */
export const isForumType = (type: number): boolean => type === 15 || type === 16;

export class Discord {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = "https://discord.com/api/v10",
  ) {}

  async call<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const res = await withBackoff(
      this.http,
      this.clock,
      {
        method,
        url: `${this.base}${path}`,
        headers: { Authorization: `Bot ${this.botToken}`, "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
      undefined,
      retryAfter,
    );
    if (res.status >= 300)
      throw new MessengerError(`discord ${method} ${path}: ${res.status} ${res.body.slice(0, 160)}`, res.status);
    return (res.body ? JSON.parse(res.body) : {}) as T;
  }

  /**
   * Posts the text as consecutive messages of at most 2000 characters (`splitForDiscord`) and returns their IDs in
   * order. `replyTo` binds the first message to the same physical channel and pings nobody; a missing target fails. A failed
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
          ? { message_reference: { message_id: replyTo, channel_id: channelId, fail_if_not_exists: true } }
          : {};
      try {
        const sent = await this.call<{ id: string }>("POST", `/channels/${channelId}/messages`, {
          content: part,
          allowed_mentions: { parse: [] },
          ...reference,
        });
        ids.push(sent.id);
      } catch (e) {
        if (ids.length === 0) throw e;
        // Any failure after a posted part, a transport error or an unreadable answer included, names what stays.
        const why = e instanceof MessengerError ? e.message : `discord POST /channels/${channelId}/messages failed`;
        throw new MessengerError(
          `${why} (part ${ids.length + 1} of ${total}; already posted: ${ids.join(" ")})`,
          e instanceof MessengerError ? e.status : 0,
          e instanceof MessengerError ? e.code : undefined,
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
    await this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, { content: guarded });
  }

  async typing(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  async startThread(channelId: string, messageId: string, name: string): Promise<string> {
    return (
      await this.call<{ id: string }>("POST", `/channels/${channelId}/messages/${messageId}/threads`, {
        name: guardText(name).slice(0, 100),
      })
    ).id;
  }

  async setThread(
    threadId: string,
    patch: { readonly name?: string; readonly archived?: boolean; readonly appliedTags?: readonly string[] },
  ): Promise<string> {
    return (
      await this.call<{ id: string }>("PATCH", `/channels/${threadId}`, {
        ...(patch.name ? { name: guardText(patch.name).slice(0, 100) } : {}),
        ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
        ...(patch.appliedTags !== undefined ? { applied_tags: patch.appliedTags } : {}),
      })
    ).id;
  }

  /** Forum posts include a starter message; text-channel threads optionally receive one after creation. */
  async createThread(
    channel: DcChannel,
    name: string,
    opts: { readonly text?: string; readonly appliedTags?: readonly string[] } = {},
  ): Promise<{ readonly id: string; readonly messageId?: string }> {
    const title = guardText(name).slice(0, 100);
    const text = opts.text === undefined ? undefined : guardText(opts.text);
    if (isForumType(channel.type)) {
      // The starter message holds the first part; longer text continues as messages in the new post.
      const [starter = "", ...more] = splitForDiscord(text ?? name);
      const thread = await this.call<{ id: string; message?: { id: string } }>(
        "POST",
        `/channels/${channel.id}/threads`,
        {
          name: title,
          message: { content: starter, allowed_mentions: { parse: [] } },
          ...(opts.appliedTags !== undefined ? { applied_tags: opts.appliedTags } : {}),
        },
      );
      if (more.length > 0)
        await this.post(thread.id, more, undefined, thread.message === undefined ? [] : [thread.message.id]);
      return { id: thread.id, ...(thread.message === undefined ? {} : { messageId: thread.message.id }) };
    }
    const thread = await this.call<{ id: string }>("POST", `/channels/${channel.id}/threads`, {
      name: title,
      type: 11,
    });
    return text === undefined ? { id: thread.id } : { id: thread.id, ...(await this.firstOf(thread.id, text)) };
  }

  /** A thread on an existing message, then optional text inside it. */
  async threadOnMessage(
    channelId: string,
    messageId: string,
    name: string,
    text?: string,
  ): Promise<{ readonly id: string; readonly messageId?: string }> {
    const guarded = text === undefined ? undefined : guardText(text);
    const id = await this.startThread(channelId, messageId, name);
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
