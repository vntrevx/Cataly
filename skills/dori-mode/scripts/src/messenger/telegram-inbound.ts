import type { TgInboundStore } from "./telegram-offset.ts";
import type { Telegram } from "./telegram.ts";

/** `message` for a new message, `edit` when the owner edited an earlier one. */
export type TgInboundKind = "message" | "edit";

export type TgMedia = { readonly kind: string; readonly fileId: string; readonly messageId?: number };

export type TgInbound = {
  readonly kind: TgInboundKind;
  readonly source: "dm" | "topic";
  readonly chat: number;
  readonly thread?: number;
  readonly updateId: number;
  /** The Telegram message_id — the id a later edit replaces (edit lines print it as mid=). */
  readonly messageId?: number;
  /** The message_id this one replies to; absent when it replies to nothing or only sits in a topic. */
  readonly replyTo?: number;
  readonly from: number;
  readonly username?: string;
  readonly text?: string;
  /**
   * What receive-lag is measured against, in unix seconds: the message's own date, or for an edit the
   * edit's date. Absent when the payload carried none, which leaves the lag unrecorded rather than
   * reporting the age of the message that was edited.
   */
  readonly date?: number;
  readonly media?: TgMedia;
};

/**
 * Owner-gated Telegram inbound: DMs from the configured owner and, when a group topic is
 * configured, that owner's messages in that topic only. Everything else is dropped.
 */
export type TgInboundOptions = {
  readonly ownerId: number;
  readonly groupChatId?: number;
  readonly topicId?: number;
};

/**
 * Env ints accept only /^-?\d+$/ after trimming; empty, whitespace-only, `1e3` and
 * `0x10` are refused at start with an error that names the variable.
 */
export const envInt = (name: string, raw: string | undefined): number => {
  if (raw === undefined) throw new Error(`${name} is not set`);
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) throw new Error(`${name} must be an integer, got: ${JSON.stringify(raw)}`);
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be an integer, got: ${JSON.stringify(raw)}`);
  return n;
};

/**
 * The inbound watch loop. Without `--loop` (loopMin <= 0) it is one-shot: a single
 * bounded poll, then it returns — scripts rely on that. With `--loop`, it re-polls
 * immediately after any poll that returned updates — kept or gate-dropped alike, since
 * more may be waiting behind that batch — and only sleeps after a truly empty poll
 * (the 25s long-poll already returns on arrival, so bursts deliver without waiting
 * out the interval).
 */
export const telegramInboundLoop = async (
  tg: Telegram,
  store: TgInboundStore,
  opts: TgInboundOptions,
  loopMin: number,
  emit: (inbound: TgInbound) => void = () => {},
  warn: (message: string) => void = () => {},
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): Promise<void> => {
  for (;;) {
    let polled: { inbound: readonly TgInbound[]; updates: number } | undefined;
    try {
      polled = await pollTelegramInbound(tg, store, opts, emit);
    } catch (e) {
      warn(e instanceof Error ? e.message : String(e));
    }
    if (loopMin <= 0) return; // one-shot: one bounded drain
    if (polled !== undefined && polled.updates > 0) continue; // more may be waiting behind this batch
    await sleep(loopMin * 60_000);
  }
};

type TgFile = { readonly file_id?: string };
type TgUser = {
  readonly id: number;
  readonly is_bot?: boolean;
  readonly username?: string;
  readonly first_name?: string;
};
type TgMessage = {
  readonly message_id?: number;
  readonly from?: TgUser;
  readonly chat?: { readonly id: number; readonly type?: string };
  readonly is_topic_message?: boolean;
  readonly message_thread_id?: number;
  readonly reply_to_message?: { readonly message_id?: number };
  readonly text?: string;
  readonly caption?: string;
  /** Unix seconds Telegram recorded the message; absent on some old or edited payloads. */
  readonly date?: number;
  /** Unix seconds Telegram recorded the edit; absent when the update carries no edit_date. */
  readonly edit_date?: number;
  readonly location?: unknown;
  readonly voice?: TgFile;
  readonly audio?: TgFile;
  readonly video?: TgFile;
  readonly video_note?: TgFile;
  readonly animation?: TgFile;
  readonly document?: TgFile;
  readonly photo?: readonly TgFile[];
};
type TgUpdate = { readonly update_id: number; readonly message?: TgMessage; readonly edited_message?: TgMessage };

/**
 * The topic a message belongs to, when it is a topic message. `message_thread_id` alone
 * is not it: for a reply in a forum's General topic Telegram puts the reply root's id
 * there, not the topic id (telegram-bot-api#447), and in a private chat run with topics
 * it only marks topic messages. `is_topic_message` is the reliable signal, so General
 * (replies included) resolves to no thread — callers treat it as topic 1 — and a
 * private-chat topic message keeps its thread.
 */
const threadOf = (m: TgMessage): number | undefined =>
  m.is_topic_message === true ? (m.message_thread_id ?? 1) : undefined;

/** The message replied to. A topic message that replies to nothing names the topic's root (id = topic id): no reply. */
const replyOf = (m: TgMessage): number | undefined => {
  const id = m.reply_to_message?.message_id;
  return m.is_topic_message === true && id === m.message_thread_id ? undefined : id;
};

/** The largest photo variant is the last array element; file ids are unique per size. */
const mediaOf = (m: TgMessage): TgMedia | undefined => {
  const kinds: readonly (readonly [string, TgFile | undefined])[] = [
    ["voice", m.voice],
    ["audio", m.audio],
    ["video", m.video],
    ["video_note", m.video_note],
    ["animation", m.animation],
    ["document", m.document],
    ["photo", m.photo?.[m.photo.length - 1]],
  ];
  for (const [kind, f] of kinds)
    if (f?.file_id !== undefined)
      return { kind, fileId: f.file_id, ...(m.message_id === undefined ? {} : { messageId: m.message_id }) };
  return undefined;
};

/**
 * Poll `getUpdates` once (new messages and edits) and hand every kept update to `emit`
 * as it is processed.
 *
 * Delivery is at-least-once: the stored offset advances past an update only after `emit`
 * returned for it (a throwing `emit` aborts the batch with the offset left before the
 * update, so the next poll returns it again — duplicates carry the same `updateId`).
 * Updates that are dropped by the gates advance the offset immediately: there is nothing
 * to deliver for them, and `getUpdates` cannot replay an update a bot has consumed.
 */
export const pollTelegramInbound = async (
  tg: Telegram,
  store: TgInboundStore,
  opts: TgInboundOptions,
  emit: (inbound: TgInbound) => void = () => {},
): Promise<{ inbound: readonly TgInbound[]; updates: number }> => {
  const updates = await tg.call<readonly TgUpdate[]>("getUpdates", {
    offset: store.load(),
    timeout: 25,
    allowed_updates: ["message", "edited_message"],
  });
  const out: TgInbound[] = [];
  for (const u of updates) {
    const kind: TgInboundKind = u.edited_message === undefined ? "message" : "edit";
    const m = u.message ?? u.edited_message;
    let keep = false;
    if (m?.from && !m.from.is_bot && m.from.id === opts.ownerId) {
      if (m.chat?.type === "private" && Number(m.chat.id) === opts.ownerId) keep = true;
      else if (
        (m.chat?.type === "group" || m.chat?.type === "supergroup") &&
        opts.groupChatId !== undefined &&
        Number(m.chat.id) === opts.groupChatId
      ) {
        // De-conflict: in a forum group the Dori only ever listens to its own topic.
        // General counts as topic 1 — including replies there, whose reply-root id in
        // message_thread_id is not a topic id.
        const topic = threadOf(m) ?? 1;
        keep = opts.topicId === undefined || topic === opts.topicId;
      }
    }
    if (!keep) {
      store.save(u.update_id + 1);
      continue;
    }
    // A live location arrives as a stream of edited_message updates carrying no new
    // text; emitting one line per refresh would flood the consumer. Drop them.
    if (kind === "edit" && m!.location !== undefined && m!.text === undefined && m!.caption === undefined) {
      store.save(u.update_id + 1);
      continue;
    }
    const source = m!.chat!.type === "private" ? "dm" : "topic";
    const thread = source === "topic" ? (threadOf(m!) ?? 1) : threadOf(m!);
    const replyTo = replyOf(m!);
    // An edit is measured from when it was edited: `date` is the original message's age, so an old
    // message edited now would otherwise record hours of "receive lag" that never happened.
    const lagDate = kind === "edit" ? m!.edit_date : m!.date;
    const media = mediaOf(m!);
    const inbound: TgInbound = {
      kind,
      source,
      ...(m!.message_id === undefined ? {} : { messageId: m!.message_id }),
      ...(replyTo === undefined ? {} : { replyTo }),
      chat: Number(m!.chat!.id),
      ...(thread === undefined ? {} : { thread }),
      updateId: u.update_id,
      from: m!.from!.id,
      ...(m!.from!.username === undefined ? {} : { username: m!.from!.username }),
      ...(m!.text === undefined && m!.caption === undefined ? {} : { text: m!.text ?? m!.caption }),
      ...(lagDate === undefined ? {} : { date: lagDate }),
      ...(media === undefined ? {} : { media }),
    };
    emit(inbound); // may throw: offset stays before this update, so it is polled again
    out.push(inbound);
    store.save(u.update_id + 1);
  }
  return { inbound: out, updates: updates.length };
};
