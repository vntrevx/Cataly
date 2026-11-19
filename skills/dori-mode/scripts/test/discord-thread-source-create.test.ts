import { expect, test } from "bun:test";
import { type DiscordRoute, ids, withDiscordCli } from "./discord-fakes.ts";
import {
  bot,
  bypassAdvice,
  create,
  createIn,
  created,
  environment,
  forum,
  lane,
  mutations,
  options,
  origin,
  owner,
  ownerMessage,
  receiptBytes,
  receiptMode,
  register,
  type SourceScenario,
  source,
} from "./discord-thread-source-fakes.ts";

const posted = `THREAD ${ids.thread} mid=${ids.starter}`;
const forumPost = `POST /channels/${ids.forum}/threads`;

test("a source-bound forum post sends one suppressed, tagged POST and a new process replays it unchanged", async () => {
  await withDiscordCli(async (f) => {
    const text = "starter @everyone <@7>";
    const first = await f.invoke(create(["--text", text]), options());
    expect([first.code, first.err, first.out, mutations(first.keys)]).toEqual([0, "", posted, [forumPost]]);
    expect(first.keys).toContain(`GET /channels/${ids.forum}/messages/${origin}`);
    expect(first.requests.find((request) => request.key === forumPost)!.body).toEqual({
      name: "task",
      message: { content: text, allowed_mentions: { parse: [] } },
      applied_tags: [ids.working],
    });
    expect(receiptMode(f)).toBe(0o600);
    const bytes = receiptBytes(f);
    const replay = await f.invoke(create(["--text", text]), options());
    expect([replay.code, replay.err, replay.out, mutations(replay.keys)]).toEqual([0, "", posted, []]);
    expect(receiptBytes(f)).toBe(bytes);
    // create -> launch: the launched lane names the created thread, and the confirmed replay still holds.
    await register(f, lane, `discord:${ids.thread}`);
    const launched = await f.invoke(create(["--text", text]), options());
    expect([launched.code, launched.out, mutations(launched.keys)]).toEqual([0, posted, []]);
    expect(receiptBytes(f)).toBe(bytes);
  });
}, 60_000);

type Refusal = readonly [string, readonly string[], Record<string, DiscordRoute>?, Record<string, string>?];
const message = (body: unknown): Record<string, DiscordRoute> => ({
  [`GET /channels/${ids.forum}/messages/${origin}`]: { body },
});
/** A source in channel `id` (a DM, category or thread) whose original message is otherwise valid. */
const sourceIn = (id: string, channel: Record<string, unknown>): Record<string, DiscordRoute> => ({
  [`GET /channels/${id}`]: { body: { id, ...channel } },
  [`GET /channels/${id}/messages/${origin}`]: { body: ownerMessage(id) },
});
const watching = (id: string, extra: Record<string, string> = {}) => ({
  ...environment,
  DORI_DISCORD_CHANNEL_ID: id,
  ...extra,
});
const valid = ownerMessage(ids.forum);
const fromThread = `discord 41 ${origin}`;
const named = watching(ids.forum, { DORI_DISCORD_GUILD_ID: ids.guild });
const missing = { [`GET /channels/${ids.forum}/messages/${origin}`]: { status: 404, body: {} } };
const threadsOff = { DORI_DISCORD_THREADS: "off" };
const childOf = (parent: string) => sourceIn("41", { type: 11, parent_id: parent });
const refusedSources: readonly Refusal[] = [
  ["a malformed source", create([], "discord 30")],
  ["a non-Discord source", create([], `slack ${ids.forum} ${origin}`)],
  ["a non-numeric message", create([], `discord ${ids.forum} 3.5`)],
  ["a missing lane", create([], source, null)],
  ["the lead key", create([], source, "lead")],
  ["an invalid lane key", create([], source, "Bad Key")],
  ["a destination by name", createIn("#tasks", ["--tag", "working"], source), {}, named],
  ["another author", create(), message({ ...valid, author: { id: "8" } })],
  ["a bot author", create(), message({ ...valid, author: { id: owner, bot: true } })],
  ["a webhook", create(), message({ ...valid, webhook_id: "80" })],
  ["a system message", create(), message({ ...valid, type: 7 })],
  ["another message", create(), message(ownerMessage(ids.forum, "36"))],
  ["another channel", create(), message(ownerMessage(ids.media))],
  ["a missing message", create(), missing],
  ["an invalid bot identity", create(), { "GET /users/@me": { body: { id: 99 } } }],
  ["an unwatched source", create(), {}, watching(ids.text)],
  ["another parent", createIn(ids.media, [], source), sourceIn(ids.media, { type: 16, available_tags: [] })],
  ["a DM source", createIn("70"), sourceIn("70", { type: 1 }), watching("70")],
  ["a category source", createIn("71"), sourceIn("71", { type: 4 }), watching("71")],
  ["a thread under another parent", create([], fromThread), childOf(ids.text), watching("41")],
  ["a thread while threads are off", create([], fromThread), childOf(ids.forum), watching(ids.forum, threadsOff)],
];
for (const [label, args, override, env] of refusedSources)
  test(`source-bound create refuses ${label} without any mutation or receipt`, async () => {
    await withDiscordCli(async (f) => {
      const result = await f.invoke(args, options(override, env));
      expect([result.code, result.out, mutations(result.keys)]).toEqual([1, "", []]);
      expect(receiptBytes(f)).toBeNull();
    });
  });

test("a thread source creates under its actual parent", async () => {
  await withDiscordCli(async (f) => {
    const result = await f.invoke(create([], fromThread), options(childOf(ids.forum)));
    expect([result.code, result.out, mutations(result.keys)]).toEqual([0, posted, [forumPost]]);
  });
});

test("a fresh create refuses a lane key that is already registered", async () => {
  await withDiscordCli(async (f) => {
    await register(f, lane, "discord:45");
    const result = await f.invoke(create(), options());
    expect([result.code, result.out, mutations(result.keys)]).toEqual([1, "", []]);
    expect(receiptBytes(f)).toBeNull();
  });
});

const tag = (id: string, name: string) => ({ id, name });
const tagged = (availableTags: readonly { id: string; name: string }[]) => ({
  [`GET /channels/${ids.forum}`]: { body: { ...forum, available_tags: availableTags } },
});
const refusedTags: readonly [string, readonly string[], Record<string, DiscordRoute>][] = [
  ["a required tag that is missing", createIn(ids.forum), {}],
  ["an unknown tag", createIn(ids.forum, ["--tag", "unknown"]), {}],
  ["a tag name held twice", create(), tagged([tag("60", "working"), tag("62", "working")])],
  ["an ID that is another tag's name", createIn(ids.forum, ["--tag", "61"]), tagged([tag("60", "61"), tag("61", "x")])],
];
for (const [label, args, override] of refusedTags)
  test(`source-bound forum create refuses ${label} before any POST`, async () => {
    await withDiscordCli(async (f) => {
      const result = await f.invoke(args, options(override));
      expect([result.code, result.out, mutations(result.keys)]).toEqual([1, "", []]);
      expect(receiptBytes(f)).toBeNull();
    });
  });

test("an exact tag ID selects that one tag", async () => {
  await withDiscordCli(async (f) => {
    const result = await f.invoke(createIn(ids.forum, ["--tag", ids.done]), options());
    expect([result.code, result.out]).toEqual([0, posted]);
    const body = result.requests.find((request) => request.key === forumPost)?.body;
    expect(body).toMatchObject({ applied_tags: [ids.done] });
  });
});

const inChannel = (id: string, type: number): SourceScenario => ({
  routes: {
    "GET /users/@me": { body: { id: bot } },
    [`GET /channels/${id}`]: { body: { id, type, name: "c" } },
    [`GET /channels/${id}/messages/${origin}`]: { body: ownerMessage(id) },
    [`GET /channels/${id}/messages/36`]: { body: ownerMessage(id, "36") },
    [`POST /channels/${id}/threads`]: { body: created(id, type === 16 ? { message: { id: ids.starter } } : {}) },
    [`POST /channels/${id}/messages/${origin}/threads`]: { body: created(id, { type: type === 5 ? 10 : 11 }, origin) },
  },
  environment: { ...environment, DORI_DISCORD_CHANNEL_ID: id },
});

test("source-bound create supports text, media and announcement-with-message threads only", async () => {
  await withDiscordCli(async (f) => {
    const textPost = `POST /channels/${ids.text}/threads`;
    const text = await f.invoke(createIn(ids.text), inChannel(ids.text, 0));
    expect([text.code, text.out, mutations(text.keys)]).toEqual([0, `THREAD ${ids.thread}`, [textPost]]);
    expect(text.requests.find((request) => request.key === textPost)?.body).toEqual({ name: "task", type: 11 });
  });
  await withDiscordCli(async (f) => {
    const media = await f.invoke(createIn(ids.media, [], undefined, "media-task"), inChannel(ids.media, 16));
    expect([media.code, media.out, mutations(media.keys)]).toEqual([
      0,
      posted,
      [`POST /channels/${ids.media}/threads`],
    ]);
  });
  await withDiscordCli(async (f) => {
    const announced = createIn("22", ["--message", origin], undefined, "news-task");
    const onMessage = await f.invoke(announced, inChannel("22", 5));
    const messagePost = `POST /channels/22/messages/${origin}/threads`;
    expect([onMessage.code, onMessage.out, mutations(onMessage.keys)]).toEqual([0, `THREAD ${origin}`, [messagePost]]);
  });
}, 60_000);

const textSource = `discord ${ids.text} ${origin}`;
const refusedShapes: readonly [string, readonly string[], SourceScenario][] = [
  ["an announcement channel without --message", createIn("22"), inChannel("22", 5)],
  ["a --message other than the original", createIn(ids.text, ["--message", "36"]), inChannel(ids.text, 0)],
  ["a --message in another channel", createIn("23", ["--message", origin], textSource), inChannel(ids.text, 0)],
  ["a --message on a forum", createIn(ids.forum, ["--message", origin]), inChannel(ids.forum, 15)],
  ["a voice channel", createIn("24"), inChannel("24", 2)],
];
for (const [label, args, scenario] of refusedShapes)
  test(`source-bound create refuses ${label} before any mutation`, async () => {
    await withDiscordCli(async (f) => {
      const result = await f.invoke(args, scenario);
      expect([result.code, result.out, mutations(result.keys)]).toEqual([1, "", []]);
    });
  });

test("a confirmed create is not cloned under another key, another source or other input", async () => {
  await withDiscordCli(async (f) => {
    expect((await f.invoke(create(), options())).out).toBe(posted);
    const bytes = receiptBytes(f);
    const another = { [`GET /channels/${ids.forum}/messages/36`]: { body: ownerMessage(ids.forum, "36") } };
    const clones = [
      create([], source, "other-task"),
      create([], `discord ${ids.forum} 36`),
      create(["--text", "changed"]),
    ];
    for (const args of clones) {
      const result = await f.invoke(args, options(another));
      expect([result.code, result.out, mutations(result.keys)]).toEqual([1, "", []]);
      expect(result.err).not.toMatch(bypassAdvice);
      expect(receiptBytes(f)).toBe(bytes);
    }
  });
}, 60_000);
