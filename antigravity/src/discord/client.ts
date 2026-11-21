import { DISCORD_LIMIT, splitForDiscord } from "./split.js";

export type DcChannel = {
  readonly id: string;
  readonly type: number;
  readonly name?: string;
  readonly topic?: string | null;
  readonly parent_id?: string | null;
  readonly guild_id?: string;
  readonly available_tags?: readonly { readonly id: string; readonly name: string }[];
};

export type DcAttachment = {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly content_type?: string;
  readonly url: string;
};

export type DcMessage = {
  readonly id: string;
  readonly channel_id: string;
  readonly content: string;
  readonly timestamp: string;
  readonly author: {
    readonly id: string;
    readonly username: string;
    readonly global_name?: string | null;
    readonly bot?: boolean;
  };
  readonly message_reference?: {
    readonly message_id?: string;
    readonly channel_id?: string;
  };
  readonly referenced_message?: DcMessage | null;
  readonly attachments?: readonly DcAttachment[];
};

export type DiscordHttpRequest = {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
};

export type DiscordHttpResponse = {
  readonly status: number;
  readonly body: string;
};

export type DiscordHttpClient = (req: DiscordHttpRequest) => Promise<DiscordHttpResponse>;

export class DiscordError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const isForumType = (type: number): boolean => type === 15 || type === 16;
export const isDiscordSnowflake = (value: string): boolean => /^\d{17,22}$/.test(value);

export function resolveDiscordApiBase(value?: string): string {
  const fallback = "https://discord.com/api/v10";
  if (!value || !value.trim()) return fallback;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new DiscordError("discord apiBase is not a valid URL", 0);
  }
  if (
    url.protocol !== "http:" ||
    url.username !== "" ||
    url.password !== "" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.href !== url.origin + url.pathname
  ) {
    throw new DiscordError("custom discord apiBase must be a loopback http:// origin", 0);
  }
  return url.href.replace(/\/+$/, "");
}

export const defaultDiscordHttp: DiscordHttpClient = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    ...(req.body !== undefined ? { body: req.body } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.text() };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class DiscordClient {
  readonly base: string;

  constructor(
    private readonly botToken: string,
    opts: { readonly apiBase?: string; readonly http?: DiscordHttpClient } = {},
  ) {
    this.base = resolveDiscordApiBase(opts.apiBase ?? process.env["CATALY_DISCORD_API_BASE"]);
    this.http = opts.http ?? defaultDiscordHttp;
  }

  private readonly http: DiscordHttpClient;

  async call<T = unknown>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    let lastStatus = 0;
    let lastBody = "";
    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await this.http({
        method,
        url: `${this.base}${path}`,
        headers: {
          Authorization: `Bot ${this.botToken}`,
          "Content-Type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      lastStatus = res.status;
      lastBody = res.body;

      if (res.status === 429 && attempt < 3) {
        let waitMs = 1_000 * (attempt + 1);
        try {
          const parsed = JSON.parse(res.body) as { retry_after?: number };
          if (typeof parsed.retry_after === "number" && parsed.retry_after > 0) {
            waitMs = Math.min(Math.ceil(parsed.retry_after * 1000) + 100, 10_000);
          }
        } catch {
          // ignore
        }
        await sleep(waitMs);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      if (res.status >= 300) {
        throw new DiscordError(`discord ${method} ${path}: HTTP ${res.status} ${res.body.slice(0, 180)}`, res.status);
      }
      return (res.body ? JSON.parse(res.body) : {}) as T;
    }
    throw new DiscordError(`discord ${method} ${path}: HTTP ${lastStatus} ${lastBody.slice(0, 180)}`, lastStatus);
  }

  async send(channelId: string, content: string, opts: { readonly replyTo?: string } = {}): Promise<string[]> {
    const trimmed = content.trim();
    if (!trimmed) throw new DiscordError("message content must not be empty", 400);
    const parts = splitForDiscord(trimmed);
    const ids: string[] = [];
    for (const part of parts) {
      const ref =
        ids.length === 0 && opts.replyTo
          ? { message_reference: { message_id: opts.replyTo, fail_if_not_exists: false } }
          : {};
      const sent = await this.call<{ id: string }>("POST", `/channels/${channelId}/messages`, {
        content: part,
        allowed_mentions: { parse: [] },
        ...ref,
      });
      ids.push(sent.id);
    }
    return ids;
  }

  async edit(channelId: string, messageId: string, content: string): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) throw new DiscordError("edited message content must not be empty", 400);
    if (trimmed.length > DISCORD_LIMIT) {
      throw new DiscordError(`edit exceeds Discord's ${DISCORD_LIMIT}-character limit`, 400);
    }
    await this.call("PATCH", `/channels/${channelId}/messages/${messageId}`, {
      content: trimmed,
      allowed_mentions: { parse: [] },
    });
  }

  async react(channelId: string, messageId: string, emoji = "👀", remove = false): Promise<void> {
    await this.call(
      remove ? "DELETE" : "PUT",
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    );
  }

  async typing(channelId: string): Promise<void> {
    await this.call("POST", `/channels/${channelId}/typing`);
  }

  async channel(id: string): Promise<DcChannel> {
    return this.call<DcChannel>("GET", `/channels/${id}`);
  }

  async messages(
    channelId: string,
    opts: { readonly after?: string; readonly limit?: number } = {},
  ): Promise<DcMessage[]> {
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(Math.max(opts.limit ?? 25, 1), 100)));
    if (opts.after) params.set("after", opts.after);
    return this.call<DcMessage[]>("GET", `/channels/${channelId}/messages?${params.toString()}`);
  }

  async activeGuildThreads(guildId: string): Promise<DcChannel[]> {
    const res = await this.call<{ threads?: DcChannel[] }>("GET", `/guilds/${guildId}/threads/active`);
    return res.threads ?? [];
  }

  async createThread(
    channelId: string,
    name: string,
    opts: { readonly messageId?: string; readonly text?: string } = {},
  ): Promise<{ readonly id: string; readonly messageId?: string }> {
    const title = name.trim().slice(0, 100);
    if (!title) throw new DiscordError("thread name must not be empty", 400);
    if (opts.messageId) {
      const thread = await this.call<{ id: string }>(
        "POST",
        `/channels/${channelId}/messages/${opts.messageId}/threads`,
        {
          name: title,
        },
      );
      if (opts.text) {
        const [first] = await this.send(thread.id, opts.text);
        return { id: thread.id, ...(first ? { messageId: first } : {}) };
      }
      return { id: thread.id };
    }
    const ch = await this.channel(channelId);
    if (isForumType(ch.type)) {
      const [starter = title, ...more] = splitForDiscord(opts.text?.trim() || title);
      const thread = await this.call<{ id: string; message?: { id: string } }>(
        "POST",
        `/channels/${channelId}/threads`,
        {
          name: title,
          message: { content: starter, allowed_mentions: { parse: [] } },
        },
      );
      for (const extra of more) {
        await this.send(thread.id, extra);
      }
      return { id: thread.id, ...(thread.message?.id ? { messageId: thread.message.id } : {}) };
    }
    const thread = await this.call<{ id: string }>("POST", `/channels/${channelId}/threads`, {
      name: title,
      type: 11,
    });
    if (opts.text) {
      const [first] = await this.send(thread.id, opts.text);
      return { id: thread.id, ...(first ? { messageId: first } : {}) };
    }
    return { id: thread.id };
  }

  async updateThread(
    threadId: string,
    patch: { readonly name?: string; readonly archived?: boolean },
  ): Promise<{ readonly id: string }> {
    return this.call<{ id: string }>("PATCH", `/channels/${threadId}`, {
      ...(patch.name ? { name: patch.name.trim().slice(0, 100) } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
    });
  }

  async gatewayBot(): Promise<{ readonly url: string; readonly shards?: number }> {
    return this.call<{ url: string; shards?: number }>("GET", "/gateway/bot");
  }

  async updateProfile(patch: {
    readonly username?: string;
    readonly avatarDataUri?: string;
    readonly bannerDataUri?: string;
    readonly description?: string;
    readonly guildId?: string;
    readonly nick?: string;
  }): Promise<{
    readonly user?: {
      readonly id: string;
      readonly username: string;
      readonly avatar?: string | null;
      readonly banner?: string | null;
    };
    readonly guildNick?: string | null;
  }> {
    let user: { id: string; username: string; avatar?: string | null; banner?: string | null } | undefined;
    if (patch.username || patch.avatarDataUri || patch.bannerDataUri) {
      user = await this.call("PATCH", "/users/@me", {
        ...(patch.username ? { username: patch.username } : {}),
        ...(patch.avatarDataUri ? { avatar: patch.avatarDataUri } : {}),
        ...(patch.bannerDataUri ? { banner: patch.bannerDataUri } : {}),
      });
    }
    if (patch.description || patch.avatarDataUri || patch.bannerDataUri) {
      await this.call("PATCH", "/applications/@me", {
        ...(patch.description ? { description: patch.description } : {}),
        ...(patch.avatarDataUri ? { icon: patch.avatarDataUri } : {}),
        ...(patch.bannerDataUri ? { cover_image: patch.bannerDataUri } : {}),
      });
    }
    let guildNick: string | null | undefined;
    if (patch.guildId && (patch.nick !== undefined || patch.bannerDataUri)) {
      const mem = await this.call<{ nick?: string | null }>("PATCH", `/guilds/${patch.guildId}/members/@me`, {
        ...(patch.nick !== undefined ? { nick: patch.nick } : {}),
        ...(patch.bannerDataUri ? { banner: patch.bannerDataUri } : {}),
      });
      guildNick = mem.nick ?? null;
    }
    return { ...(user ? { user } : {}), ...(guildNick !== undefined ? { guildNick } : {}) };
  }
}
