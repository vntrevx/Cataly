import type { Clock } from "../run.ts";
import { guardText, type Http, MessengerError, withBackoff } from "./http.ts";
import { cutAt, splitForTelegramHtml, TELEGRAM_LIMIT, visibleLength } from "./split.ts";

export type TgTarget = {
  readonly chatId: number | string;
  readonly threadId?: number;
  /** A message to reply to; only the first body of a split send carries it. */
  readonly replyTo?: number;
};

export { TELEGRAM_LIMIT };

/**
 * Break text into sendable bodies, each at most `limit` characters, without losing a character.
 *
 * A break is taken at a newline (or failing that a space) in the back half of the window, so a
 * report splits between paragraphs instead of mid-sentence; text with no such break is cut hard.
 * The parts concatenate back to the input exactly, which is what the tests pin.
 */
export const splitForTelegram = (text: string): string[] => {
  const limit = TELEGRAM_LIMIT;
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const at = cutAt(rest, limit, ["\n", " "]);
    parts.push(rest.slice(0, at));
    rest = rest.slice(at);
  }
  if (rest !== "") parts.push(rest);
  return parts;
};

const retryAfter = (body: string): number | undefined => {
  try {
    const n = (JSON.parse(body) as { parameters?: { retry_after?: number } }).parameters?.retry_after;
    return typeof n === "number" ? n : undefined;
  } catch {
    return undefined;
  }
};

export class Telegram {
  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly botToken: string,
    private readonly base = "https://api.telegram.org",
  ) {}

  async call<T = unknown>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await withBackoff(
      this.http,
      this.clock,
      {
        method: "POST",
        url: `${this.base}/bot${this.botToken}/${method}`,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(params),
      },
      undefined,
      retryAfter,
    );
    let body: { ok?: boolean; result?: T; description?: string; error_code?: number };
    try {
      const parsed: unknown = JSON.parse(res.body || "{}");
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected an object");
      body = parsed as typeof body;
    } catch {
      throw new MessengerError(`telegram ${method}: malformed API response`, res.status);
    }
    if (body.ok !== true)
      throw new MessengerError(`telegram ${method}: ${body.description ?? res.status}`, body.error_code ?? res.status);
    return body.result as T;
  }

  private where(t: TgTarget): Record<string, unknown> {
    return { chat_id: t.chatId, ...(t.threadId ? { message_thread_id: t.threadId } : {}) };
  }

  async send(t: TgTarget, text: string, rich = false): Promise<number> {
    // Telegram bounds a message by the characters left after entities parsing, so HTML is split on that count with
    // its open tags closed and reopened; plain text is split on its own characters.
    const guarded = guardText(text);
    const bodies = rich ? splitForTelegramHtml(guarded) : splitForTelegram(guarded);
    let last = 0;
    for (const [at, part] of bodies.entries()) {
      const r = await this.call<{ message_id?: unknown } | null>("sendMessage", {
        ...this.where(t),
        text: part,
        ...(rich ? { parse_mode: "HTML" } : {}),
        // A reply on every body would answer the same message once per part; only the first carries it.
        ...(at === 0 && t.replyTo !== undefined
          ? { reply_parameters: { message_id: t.replyTo, allow_sending_without_reply: true } }
          : {}),
      });
      const id = r?.message_id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)
        throw new MessengerError("telegram sendMessage: malformed API response (no valid message_id)", 502);
      last = id;
    }
    return last;
  }

  async edit(t: TgTarget, messageId: number, text: string, rich = false): Promise<void> {
    const guarded = guardText(text);
    // An edit replaces one existing message, so it cannot be split; the bound is what Telegram counts for it.
    const size = rich ? visibleLength(guarded) : guarded.length;
    if (size > TELEGRAM_LIMIT)
      throw new MessengerError(
        `telegram edit: text exceeds ${TELEGRAM_LIMIT} UTF-16 code units; shorten --text or send without --edit`,
        400,
      );
    await this.call("editMessageText", {
      chat_id: t.chatId,
      message_id: messageId,
      text: guarded,
      ...(rich ? { parse_mode: "HTML" } : {}),
    });
  }

  /** The read receipt: one reaction on the owner's message, replaced (not stacked) on a repeat. */
  async react(t: TgTarget, messageId: number, emoji: string): Promise<void> {
    await this.call("setMessageReaction", {
      chat_id: t.chatId,
      message_id: messageId,
      reaction: [{ type: "emoji", emoji }],
    });
  }

  async typing(t: TgTarget): Promise<void> {
    await this.call("sendChatAction", { ...this.where(t), action: "typing" });
  }

  async draft(t: TgTarget, draftId: number, text: string): Promise<void> {
    await this.call("sendMessageDraft", { ...this.where(t), draft_id: draftId, text: guardText(text) });
  }

  async createTopic(chatId: number | string, name: string): Promise<number> {
    const r = await this.call<{ message_thread_id: number }>("createForumTopic", {
      chat_id: chatId,
      name: guardText(name).slice(0, 128),
    });
    return r.message_thread_id;
  }

  async renameTopic(chatId: number | string, threadId: number, name: string): Promise<void> {
    await this.call("editForumTopic", {
      chat_id: chatId,
      message_thread_id: threadId,
      name: guardText(name).slice(0, 128),
    });
  }

  async closeTopic(chatId: number | string, threadId: number): Promise<void> {
    await this.call("closeForumTopic", { chat_id: chatId, message_thread_id: threadId });
  }

  async reopenTopic(chatId: number | string, threadId: number): Promise<void> {
    await this.call("reopenForumTopic", { chat_id: chatId, message_thread_id: threadId });
  }
}

export const THINKING = "Thinking…";

export type DraftStream = { push(text: string): Promise<void>; finish(text: string, rich?: boolean): Promise<number> };

export const streamDraft = (tg: Telegram, clock: Clock, t: TgTarget, minIntervalMs = 800): DraftStream => {
  const draftId = Math.max(1, clock.now() % 2_000_000_000);
  let lastAt = Number.NEGATIVE_INFINITY;
  let pending = "";
  let shown = "";
  const flush = async () => {
    if (pending === shown) return;
    await tg.draft(t, draftId, pending);
    shown = pending;
    lastAt = clock.now();
  };
  return {
    async push(text) {
      pending = text || THINKING;
      if (clock.now() - lastAt >= minIntervalMs) await flush();
    },
    async finish(text, rich = false) {
      return tg.send(t, text, rich);
    },
  };
};

export const startThinking = async (tg: Telegram, clock: Clock, t: TgTarget): Promise<DraftStream> => {
  const s = streamDraft(tg, clock, t);
  await s.push(THINKING);
  return s;
};

export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const htmlTable = (head: readonly string[], rows: readonly (readonly string[])[]): string => {
  const cells = [head, ...rows];
  const widths = head.map((_, i) => Math.max(...cells.map((r) => (r[i] ?? "").length)));
  const line = (r: readonly string[]) => r.map((c, i) => escapeHtml(c.padEnd(widths[i] ?? 0))).join("  ");
  return `<pre>${[line(head), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n")}</pre>`;
};
