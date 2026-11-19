import { realClock } from "../run.ts";
import { Discord, type DcChannel } from "./discord.ts";
import { isOwnerMessage, type Message } from "./discord-inbound-api.ts";
import { discordInboundOptions } from "./discord-inbound-env.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";
import { fetchHttp } from "./http.ts";
import { type RemoteMedia, TranscriptionError } from "./voice.ts";

const refused = (reason: string): TranscriptionError => new TranscriptionError(`attachment: ${reason}`);

/** Raw segments are inspected before URL canonicalization can remove traversal. */
const attachmentUrl = (raw: string, channel: string, file: string): URL => {
  const path = /^https:\/\/[^/?#]+(\/[^?#]*)(?:\?[^#]*)?$/i.exec(raw)?.[1];
  const parts = path?.split("/") ?? [];
  if (
    raw.includes("\\") ||
    parts.length !== 5 ||
    parts[1] !== "attachments" ||
    parts[2] !== channel ||
    parts[3] !== file ||
    !parts[4]
  )
    throw refused("resource path does not match the original channel and file");
  let name = parts[4];
  for (;;) {
    if (
      name === "." ||
      name === ".." ||
      name.includes("/") ||
      name.includes("\\") ||
      [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    )
      throw refused("resource path contains traversal or a path separator");
    // Decode bytes independently so invalid UTF-8 cannot hide an encoded separator.
    const decoded = name.replace(/%[0-9a-f]{2}/gi, (octet) => String.fromCharCode(Number.parseInt(octet.slice(1), 16)));
    if (decoded === name) break;
    name = decoded;
  }
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  )
    throw refused("resource is not an authorized Discord attachment origin");
  return url;
};

/** A reference is not a bearer credential: the current bot, owner and original route must still authorize it. */
export const discordAttachment = (reference: string): RemoteMedia => {
  const [scheme, bot, owner, channel, messageId, file, ...extra] = reference.split(":");
  if (
    scheme !== "discord-file" ||
    extra.length ||
    !isDiscordSnowflake(bot) ||
    !isDiscordSnowflake(owner) ||
    !isDiscordSnowflake(channel) ||
    !isDiscordSnowflake(messageId) ||
    !isDiscordSnowflake(file)
  )
    throw refused("Discord attachment reference is invalid");
  return async (signal, maxBytes) => {
    try {
      const options = discordInboundOptions();
      if (options.ownerId !== owner) throw refused("reference belongs to another owner");
      const token = process.env["DORI_DISCORD_TOKEN"];
      if (!token) throw refused("set DORI_DISCORD_TOKEN to the original bot token");
      const dc = new Discord(fetchHttp, realClock, token);
      const me = await dc.call<{ id?: string; bot?: boolean }>("GET", "/users/@me");
      if (me?.bot !== true || me.id !== bot || bot === owner) throw refused("reference belongs to another bot");
      const route = await dc.call<DcChannel>("GET", `/channels/${channel}`);
      if (route?.id !== channel || !Number.isSafeInteger(route.type))
        throw refused("channel metadata does not match the original route");
      if (!options.all && !options.channelIds.includes(channel)) {
        if (
          options.threads === false ||
          ![10, 11, 12].includes(route.type) ||
          !route.parent_id ||
          !options.channelIds.includes(route.parent_id)
        )
          throw refused("original channel is outside the current watched scope");
        const parent = await dc.call<DcChannel>("GET", `/channels/${route.parent_id}`);
        if (parent?.id !== route.parent_id || ![0, 5, 15, 16].includes(parent.type))
          throw refused("thread parent does not match the current watched scope");
      }
      const message = await dc.call<Message>("GET", `/channels/${channel}/messages/${messageId}`);
      if (message?.id !== messageId || message.channel_id !== channel || !isOwnerMessage(message, owner, bot))
        throw refused("message is not the original owner's resource on this route");
      if (!Array.isArray(message.attachments)) throw refused("attachment metadata is unavailable");
      const matches = message.attachments.filter(
        (value: unknown) =>
          !!value && typeof value === "object" && !Array.isArray(value) && (value as { id?: unknown }).id === file,
      );
      if (matches.length !== 1) throw refused("original attachment is missing or ambiguous");
      const { filename, size, url: raw } = matches[0] as Record<string, unknown>;
      if (
        typeof filename !== "string" ||
        typeof raw !== "string" ||
        typeof size !== "number" ||
        !Number.isSafeInteger(size) ||
        size < 0
      )
        throw refused("attachment metadata is invalid");
      if (size > maxBytes) throw refused("declared size exceeds the limit; adjust transcribeMaxBytes or --max-bytes");
      const url = attachmentUrl(raw, channel, file);
      // The signed resource URL is used only here; the bot Authorization header never reaches the CDN.
      const response = await fetch(url, { signal, redirect: "error", credentials: "omit" });
      if (
        response.redirected ||
        (response.url && response.url !== url.href) ||
        (response.status >= 300 && response.status < 400)
      )
        throw refused("attachment redirects and origin substitutions are forbidden");
      return { name: url.pathname.split("/").at(-1)!, response, expectedSize: size };
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw refused("metadata or download failed; check the original bot, owner and channel access");
    }
  };
};
