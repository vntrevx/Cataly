import type { Cli } from "./cli-context.ts";
import { discordClient } from "./cli-discord-ops.ts";
import { isForumType, isThreadType } from "./messenger/discord.ts";
import { discordInboundOptions } from "./messenger/discord-inbound-env.ts";
import { isDiscordSnowflake } from "./messenger/discord-inbound-state.ts";
import { discordSourceIds, verifyDiscordSource } from "./messenger/discord-source.ts";
import { guardText, MessengerError } from "./messenger/http.ts";
import { LANE_KEY, RESERVED_LANE_KEY } from "./registry.ts";

/** Read-only capability and original-source checks; no receipt or remote mutation happens here. */
export const threadSourcePlan = async ({ positionals, opt, strings, values }: Cli) => {
  const ids = discordSourceIds(values["source"], fail);
  const action = positionals[1];
  const lane = opt("lane");
  if (action !== "create" && action !== "set") throw fail("thread discord needs create or set");
  if (lane === undefined || !LANE_KEY.test(lane) || lane === RESERVED_LANE_KEY)
    throw fail("source-bound thread needs a valid non-lead --lane KEY");
  if (values["archive"] === true && values["unarchive"] === true) throw fail("choose --archive or --unarchive");
  const target = action === "create" ? opt("to") : positionals[2];
  if (!isDiscordSnowflake(target)) throw fail("source-bound thread targets must use Discord IDs");
  const message = values["message"] === undefined ? undefined : opt("message");
  if (
    values["message"] !== undefined &&
    (action !== "create" || !isDiscordSnowflake(message) || message !== ids.messageId || target !== ids.channelId)
  )
    throw fail("--message must be the exact original source message in the target channel");
  if (action === "create" && (values["archive"] !== undefined || values["unarchive"] !== undefined))
    throw fail("archive flags apply only to thread set");
  if (action === "set" && values["text"] !== undefined) throw fail("thread set does not send text");
  const rawName = values["title"];
  if ((action === "create" || rawName !== undefined) && (typeof rawName !== "string" || !rawName.trim()))
    throw fail("thread title must be nonempty");
  const originalName = typeof rawName === "string" ? guardText(rawName) : undefined;
  const name = action === "create" ? originalName : originalName?.slice(0, 100);
  if (name !== undefined && !name.slice(0, 100).trim())
    throw fail("thread title must be nonempty within 100 characters");
  const text = values["text"];
  if (text !== undefined && typeof text !== "string") throw fail("--text needs text");
  if (typeof text === "string") guardText(text);
  const tags = strings("tag");
  if (values["tag"] !== undefined && (tags.length === 0 || tags.some((tag) => !tag.trim())))
    throw fail("--tag needs an exact available tag ID or name");
  const archived = values["archive"] === true ? true : values["unarchive"] === true ? false : undefined;
  if (action === "set" && name === undefined && tags.length === 0 && archived === undefined)
    throw fail("thread set needs --title, --tag, --archive or --unarchive");
  const dc = discordClient();
  const origin = await verifyDiscordSource(dc, ids, discordInboundOptions(), "thread", fail);
  const parentId = origin.parent ?? origin.channel.id;
  if (action === "create" && target !== parentId) throw fail("thread create target is not the original source parent");
  if (action === "set" && origin.parent !== undefined && target !== origin.channel.id)
    throw fail("a thread source may only control its own thread");
  const parent = origin.parent === undefined ? origin.channel : await dc.channel(parentId);
  if (!parent || parent.id !== parentId || ![0, 5, 15, 16].includes(parent.type))
    throw fail("original source does not have a supported thread parent");
  const thread =
    action === "set" ? (origin.channel.id === target ? origin.channel : await dc.channel(target)) : undefined;
  if (
    action === "set" &&
    (!thread || thread.id !== target || !isThreadType(thread.type) || thread.parent_id !== parentId)
  )
    throw fail("thread target is not under the original source parent");
  if (action === "create" && (message === undefined ? parent.type === 5 : isForumType(parent.type)))
    throw fail("this parent requires a different thread creation capability");
  if (message !== undefined && tags.length > 0)
    throw fail("--tag needs a forum post; --message opens a thread on a message");
  return { action, lane, target, message, name, text, tags, archived, dc, origin, parent, parentId } as const;
};

const fail = (message: string) => new MessengerError(message, 400);
