import { type DcChannel, type Discord, isThreadType } from "./discord.ts";
import type { DiscordInboundOptions } from "./discord-inbound.ts";
import { inboundRequest, isOwnerMessage, type Message } from "./discord-inbound-api.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";

/** Parse before credentials or remote lookups so malformed source input cannot select another conversation. */
export const discordSourceIds = (raw: unknown, fail: (message: string) => Error) => {
  const invalid = () => fail('--source must be "discord CHANNEL MESSAGE" with Discord IDs');
  if (typeof raw !== "string") throw invalid();
  const match = /^discord ([1-9][0-9]*) ([1-9][0-9]*)$/.exec(raw);
  const channelId = match?.[1];
  const messageId = match?.[2];
  if (match?.[0] !== raw || !isDiscordSnowflake(channelId) || !isDiscordSnowflake(messageId)) throw invalid();
  return { channelId, messageId };
};

/** Purpose and thread commands share the same current owner, physical source and watch-scope boundary. */
export const verifyDiscordSource = async (
  client: Discord,
  ids: ReturnType<typeof discordSourceIds>,
  options: DiscordInboundOptions,
  label: string,
  fail: (message: string) => Error,
) => {
  const { channelId, messageId } = ids;
  const request = inboundRequest(client);
  const me = await request<{ id?: unknown } | null>("/users/@me");
  const botId = me?.id;
  if (!isDiscordSnowflake(botId)) throw fail(`Discord ${label} source bot identity is invalid`);
  const channel = await request<DcChannel>(`/channels/${channelId}`);
  if (!channel || channel.id !== channelId || !Number.isInteger(channel.type))
    throw fail(`Discord ${label} source channel identity is invalid`);
  let parent: string | undefined;
  if (isThreadType(channel.type)) {
    if (!isDiscordSnowflake(channel.parent_id)) throw fail(`Discord ${label} source parent is invalid`);
    parent = channel.parent_id;
  }
  if (
    !options.all &&
    !options.channelIds.includes(channelId) &&
    !(options.threads !== false && parent !== undefined && options.channelIds.includes(parent))
  )
    throw fail("original source is outside the current Discord inbound scope");
  const message = await request<Message>(`/channels/${channelId}/messages/${messageId}`);
  if (
    !message ||
    message.id !== messageId ||
    message.channel_id !== channelId ||
    !isOwnerMessage(message, options.ownerId, botId)
  )
    throw fail(`Discord ${label} source is not the exact owner message`);
  return { client, channel, parent, identity: { botId, ownerId: options.ownerId, channelId, messageId } };
};
