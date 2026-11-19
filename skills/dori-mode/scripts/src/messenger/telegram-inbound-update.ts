import { createHash } from "node:crypto";
import type { TgMedia } from "./telegram-inbound.ts";

type TgFile = { readonly file_id?: string; readonly file_unique_id?: string };
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
export type TgUpdate = {
  readonly update_id: number;
  readonly message?: TgMessage;
  readonly edited_message?: TgMessage;
};

/**
 * The topic a message belongs to, when it is a topic message. `message_thread_id` alone
 * is not it: for a reply in a forum's General topic Telegram puts the reply root's id
 * there, not the topic id (telegram-bot-api#447), and in a private chat run with topics
 * it only marks topic messages. `is_topic_message` is the reliable signal, so General
 * (replies included) resolves to no thread — callers treat it as topic 1 — and a
 * private-chat topic message keeps its thread.
 */
export const threadOf = (m: TgMessage): number | undefined =>
  m.is_topic_message === true ? (m.message_thread_id ?? 1) : undefined;

/** The message replied to. A topic message that replies to nothing names the topic's root (id = topic id): no reply. */
export const replyOf = (m: TgMessage): number | undefined => {
  const id = m.reply_to_message?.message_id;
  return m.is_topic_message === true && id === m.message_thread_id ? undefined : id;
};

/** The largest photo variant is the last array element; file ids are unique per size. */
export const mediaOf = (m: TgMessage): TgMedia | undefined => {
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

/** A bounded receipt carries no message text or volatile user profile fields. */
export const telegramUpdateReceipt = (update: TgUpdate): string | undefined => {
  const message = update.message ?? update.edited_message;
  if (!message) return undefined;
  // update_id distinguishes rapid A -> B -> A edits in one second, but is never
  // the sole identity: idle restarts may reuse it for a different message/revision.
  return createHash("sha256")
    .update(
      JSON.stringify({
        update: update.update_id,
        kind: update.edited_message === undefined ? "message" : "edit",
        chat: message.chat?.id,
        message: message.message_id,
        from: message.from?.id,
        date: message.date,
        edited: message.edit_date,
        thread: threadOf(message),
        reply: replyOf(message),
        text: message.text,
        caption: message.caption,
        media: [
          message.voice,
          message.audio,
          message.video,
          message.video_note,
          message.animation,
          message.document,
          message.photo?.[message.photo.length - 1],
        ].map((file) => file?.file_unique_id ?? file?.file_id),
      }),
    )
    .digest("hex");
};
