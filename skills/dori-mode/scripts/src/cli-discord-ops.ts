/** Discord send/thread/react operations and URL audio staging for the existing transcription hook. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Command, die, messageText } from "./cli-context.ts";
import { type DcChannel, Discord, isForumType } from "./messenger/discord.ts";
import { discordInboundEnv } from "./messenger/discord-inbound-state.ts";
import { fetchHttp } from "./messenger/http.ts";
import { DISCORD_LIMIT } from "./messenger/split.ts";
import { TranscriptionError } from "./messenger/voice.ts";
import { recordMark, recordSent } from "./owes.ts";
import { realClock } from "./run.ts";

export const discordClient = () =>
  new Discord(fetchHttp, realClock, process.env["DORI_DISCORD_TOKEN"] ?? die("DORI_DISCORD_TOKEN is not set"));

/** Local paths pass through; downloaded audio belongs only to this invocation and is always removed. */
export const withLocalAudio = async (source: string, use: (file: string) => Promise<string>): Promise<string> => {
  if (!/^https?:\/\//i.test(source)) return await use(source);
  const dir = mkdtempSync(join(tmpdir(), "dori-audio-"));
  try {
    let file: string;
    try {
      const url = new URL(source);
      const response = await fetch(url);
      if (!response.ok) throw new TranscriptionError(`transcribe: GET ${url.pathname} answered ${response.status}`);
      file = join(dir, basename(url.pathname) || "audio");
      writeFileSync(file, new Uint8Array(await response.arrayBuffer()), { mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error instanceof TranscriptionError) throw error;
      throw new TranscriptionError("transcribe: could not download audio");
    }
    return await use(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** An exact channel ID, or a unique channel name in the explicitly selected guild. */
export const channelOf = async (dc: Discord, raw: string): Promise<DcChannel> => {
  if (/^\d+$/.test(raw)) return await dc.channel(raw);
  const guild = discordInboundEnv(
    "DORI_DISCORD_GUILD_ID (to look up a channel by name)",
    process.env["DORI_DISCORD_GUILD_ID"],
  );
  const name = raw.replace(/^#/, "");
  const hits = (await dc.guildChannels(guild)).filter((channel) => channel.name === name);
  if (hits.length !== 1) die(`--to ${raw}: ${hits.length} channels have that name in guild ${guild}`);
  return hits[0]!;
};

/** Tags replace the complete applied set; unknown names include the forum's known tag names in the error. */
export const tagIds = (forum: DcChannel, names: readonly string[]): string[] =>
  names.map((name) => {
    const tags = forum.available_tags ?? [];
    return (
      tags.find((tag) => tag.name === name || tag.id === name)?.id ??
      die(
        `forum ${forum.id} has no tag ${JSON.stringify(name)}; tags: ${tags.map((tag) => tag.name).join(", ") || "none"}`,
      )
    );
  });

export const sendDiscord: Command = async (cli) => {
  const { need, opt, values, config } = cli;
  const thread = opt("thread");
  const to = thread === undefined ? need("to") : undefined;
  const text = await messageText(cli);
  // An --edit given empty ("$UNSET") or not a message id is refused before any request: it must never post anew.
  const edit = values["edit"] === undefined ? undefined : discordInboundEnv("--edit", opt("edit"));
  // Likewise a --reply that is not a message id never becomes a plain post.
  const reply = values["reply"] === undefined ? undefined : discordInboundEnv("--reply", opt("reply"));
  if (edit !== undefined && reply !== undefined) die("--reply makes a new message; it cannot be used with --edit");
  // An edit replaces one message, so it is never split: over the limit it is refused before the channel lookup.
  if (edit !== undefined && text.length > DISCORD_LIMIT)
    die(`--edit text exceeds ${DISCORD_LIMIT} UTF-16 code units; shorten the text or send without --edit`);
  const dc = discordClient();
  let target: string;
  if (thread !== undefined) target = discordInboundEnv("--thread", thread);
  else {
    const channel = await channelOf(dc, to!);
    if (isForumType(channel.type))
      die(`${channel.id} is a forum: post with dori thread discord create, or pass --thread`);
    target = channel.id;
  }
  if (edit !== undefined) await dc.edit(target, edit, text);
  else {
    const ids = await dc.send(target, text, reply === undefined ? {} : { replyTo: reply });
    // A partially posted split send is not a complete answer.
    await recordSent(config.stateDir, target, Date.now());
    console.log(`SENT ${ids.join(" ")}`);
  }
};

export const threadDiscord: Command = async (cli) => {
  if (cli.values["source"] !== undefined)
    return (await import("./cli-discord-thread-source.ts")).sourceThreadDiscord(cli);
  const { positionals, need, opt, strings, values } = cli;
  const action = positionals[1];
  const tags = strings("tag");
  if (values["archive"] === true && values["unarchive"] === true) die("choose --archive or --unarchive");
  const dc = discordClient();
  if (action === "create") {
    // A thread on an existing message: checked before any request, so a bad id never opens a thread without one.
    const message = values["message"] === undefined ? undefined : discordInboundEnv("--message", opt("message"));
    // Any --tag counts, a bare one included: it is never silently dropped from a --message thread.
    if (message !== undefined && values["tag"] !== undefined)
      die("--tag needs a forum post; --message opens a thread on a message");
    const channel = await channelOf(dc, need("to"));
    if (tags.length && !isForumType(channel.type)) die("--tag needs a forum channel");
    if (message !== undefined && isForumType(channel.type))
      die(`${channel.id} is a forum: its posts are threads already; drop --message`);
    const title = need("title");
    const name = values["title"];
    const text = values["text"];
    const titled = typeof name === "string" ? name : title;
    const thread =
      message === undefined
        ? await dc.createThread(channel, titled, {
            ...(typeof text === "string" ? { text } : {}),
            ...(tags.length ? { appliedTags: tagIds(channel, tags) } : {}),
          })
        : await dc.threadOnMessage(channel.id, message, titled, typeof text === "string" ? text : undefined);
    console.log(`THREAD ${thread.id}${thread.messageId === undefined ? "" : ` mid=${thread.messageId}`}`);
  } else if (action === "set") {
    const threadId = discordInboundEnv("thread", positionals[2]);
    const title = values["title"] === undefined ? undefined : need("title");
    const name = values["title"];
    let appliedTags: string[] | undefined;
    if (tags.length) {
      const parent = (await dc.channel(threadId)).parent_id ?? die(`${threadId} is not a thread`);
      const forum = await dc.channel(parent);
      if (!isForumType(forum.type)) die("--tag needs a forum post");
      appliedTags = tagIds(forum, tags);
    }
    const archived = values["archive"] === true ? true : values["unarchive"] === true ? false : undefined;
    if (title === undefined && appliedTags === undefined && archived === undefined)
      die("thread set needs --title, --tag, --archive or --unarchive");
    const id = await dc.setThread(threadId, {
      ...(title === undefined ? {} : { name: typeof name === "string" ? name : title }),
      ...(appliedTags === undefined ? {} : { appliedTags }),
      ...(archived === undefined ? {} : { archived }),
    });
    console.log(`THREAD ${id}`);
  } else die("thread discord needs create or set");
};

export const reactDiscord: Command = async ({ need, opt, values, config }) => {
  const thread = opt("thread");
  const channel = thread === undefined ? discordInboundEnv("--to", need("to")) : discordInboundEnv("--thread", thread);
  const message = discordInboundEnv("--message", need("message"));
  const remove = values["remove"] === true;
  await discordClient().react(channel, message, opt("emoji") || "\u{1f440}", remove);
  // A read receipt on the owner's exact message is half of the answer; the gate reads this to settle the owe.
  if (!remove) await recordMark(config.stateDir, channel, message, Date.now());
  console.log(`REACTED ${channel} ${remove ? "-" : "+"}`);
};
