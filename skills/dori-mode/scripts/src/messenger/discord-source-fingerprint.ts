import { createHash } from "node:crypto";
import { type DiscordInbound, type Message, toInbound } from "./discord-inbound-api.ts";

const stableUrl = (value: string): string => {
  const url = URL.parse(value);
  if (!url || !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname)) return value;
  for (const parameter of ["ex", "is", "hm"]) url.searchParams.delete(parameter);
  return url.href;
};
/** Reply snapshots and CDN authorization are fetched context, not revisions of the owner's original input. */
export const discordSourceFingerprint = (message: DiscordInbound): string =>
  createHash("sha256")
    .update(
      JSON.stringify({
        channel: message.channel,
        message: message.message,
        reference: message.reference,
        text: message.text,
        attachments: message.attachments.map((attachment) => ({
          filename: attachment.filename,
          size: attachment.size,
          url: stableUrl(attachment.url),
          content_type: attachment.content_type,
          voice: attachment.voice,
          duration_secs: attachment.duration_secs,
        })),
      }),
    )
    .digest("hex");

/** Pending redelivery keeps the original raw record, including its first attachment and reply snapshots. */
export const discordRawFingerprint = (message: Message): string =>
  JSON.stringify([
    message.author?.id,
    message.author?.bot === true,
    message.author?.system === true,
    message.webhook_id,
    message.type,
    discordSourceFingerprint(toInbound(message)),
  ]);
