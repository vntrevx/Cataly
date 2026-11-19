import { expect, test } from "bun:test";
import { type DiscordRoute, ids, withDiscordCli } from "./discord-fakes.ts";
import {
  bypassAdvice,
  lane,
  mutations,
  options,
  ownerMessage,
  receiptBytes,
  receiptMode,
  register,
  set,
} from "./discord-thread-source-fakes.ts";

const patch = `PATCH /channels/${ids.thread}`;
const renamed = ["--title", "renamed"];
const second = `discord ${ids.forum} 36`;
const routes: Record<string, DiscordRoute> = {
  [`GET /channels/${ids.forum}/messages/36`]: { body: ownerMessage(ids.forum, "36") },
  "GET /channels/41": { body: { id: "41", type: 11, parent_id: ids.forum } },
  "GET /channels/42": { body: { id: "42", type: 11, parent_id: ids.media } },
};
const bodyOf = (result: { requests: { key: string; body: unknown }[] }) =>
  result.requests.find((request) => request.key === patch)?.body;

test("a source-bound rename patches only the registered thread's title and replays without a second PATCH", async () => {
  await withDiscordCli(async (f) => {
    await register(f, lane, `discord:${ids.thread}`);
    const first = await f.invoke(set(ids.thread, renamed), options(routes));
    expect([first.code, first.err, first.out, mutations(first.keys)]).toEqual([0, "", `THREAD ${ids.thread}`, [patch]]);
    // A title alone never sends an archived key.
    expect(bodyOf(first)).toEqual({ name: "renamed" });
    expect(receiptMode(f)).toBe(0o600);
    const bytes = receiptBytes(f);
    const replay = await f.invoke(set(ids.thread, renamed), options(routes));
    expect([replay.code, replay.out, mutations(replay.keys)]).toEqual([0, first.out, []]);
    expect(receiptBytes(f)).toBe(bytes);
    for (const other of [
      ["--title", "other"],
      [...renamed, "--archive"],
    ]) {
      const conflict = await f.invoke(set(ids.thread, other), options(routes));
      expect([conflict.code, conflict.out, mutations(conflict.keys)]).toEqual([1, "", []]);
      expect(conflict.err).not.toMatch(bypassAdvice);
      expect(receiptBytes(f)).toBe(bytes);
    }
  });
}, 60_000);

test("a closed lane still names its thread, and archive state is sent only when given explicitly", async () => {
  await withDiscordCli(async (f) => {
    await register(f, lane, `discord:${ids.thread}`, true);
    const archived = await f.invoke(set(ids.thread, ["--archive"]), options(routes));
    expect([archived.code, archived.out, mutations(archived.keys)]).toEqual([0, `THREAD ${ids.thread}`, [patch]]);
    expect(bodyOf(archived)).toEqual({ archived: true });
    const reopened = await f.invoke(set(ids.thread, ["--unarchive"], second), options(routes));
    expect([reopened.code, reopened.out, mutations(reopened.keys)]).toEqual([0, `THREAD ${ids.thread}`, [patch]]);
    expect(bodyOf(reopened)).toEqual({ archived: false });
  });
}, 60_000);

test("--archive with --unarchive is refused before any request", async () => {
  await withDiscordCli(async (f) => {
    await register(f, lane, `discord:${ids.thread}`);
    const result = await f.invoke(set(ids.thread, ["--archive", "--unarchive"]), options(routes));
    expect([result.code, result.out, result.keys]).toEqual([1, "", []]);
    expect(receiptBytes(f)).toBeNull();
  });
});

test("a thread source may set only that thread itself", async () => {
  await withDiscordCli(async (f) => {
    const fromThread = `discord ${ids.thread} 45`;
    const scenario = options({
      ...routes,
      [`GET /channels/${ids.thread}/messages/45`]: { body: ownerMessage(ids.thread, "45") },
    });
    await register(f, lane, `discord:${ids.thread}`);
    const own = await f.invoke(set(ids.thread, renamed, fromThread), scenario);
    expect([own.code, own.out, mutations(own.keys)]).toEqual([0, `THREAD ${ids.thread}`, [patch]]);
    await register(f, "sibling-task", "discord:41");
    const sibling = await f.invoke(set("41", renamed, fromThread, "sibling-task"), scenario);
    expect([sibling.code, sibling.out, mutations(sibling.keys)]).toEqual([1, "", []]);
  });
}, 60_000);

const refusals: readonly [string, string, string | null, readonly string[]][] = [
  ["an unregistered lane", ids.thread, null, set(ids.thread, renamed)],
  ["a lane bound to another thread", ids.thread, "discord:41", set(ids.thread, renamed)],
  ["a lane bound without the discord: prefix", ids.thread, ids.thread, set(ids.thread, renamed)],
  ["a thread under another parent", "42", "discord:42", set("42", renamed)],
  ["a missing lane", ids.thread, `discord:${ids.thread}`, set(ids.thread, renamed, undefined, null)],
  ["the lead key", ids.thread, `discord:${ids.thread}`, set(ids.thread, renamed, undefined, "lead")],
  ["a malformed source", ids.thread, `discord:${ids.thread}`, set(ids.thread, renamed, "discord 30")],
  ["a target by name", ids.thread, `discord:${ids.thread}`, set("#task", renamed)],
];
for (const [label, target, thread, args] of refusals)
  test(`source-bound set refuses ${label} without a PATCH or receipt`, async () => {
    await withDiscordCli(async (f) => {
      if (thread !== null) await register(f, lane, thread);
      const result = await f.invoke(args, options(routes));
      expect([result.code, result.out, mutations(result.keys)]).toEqual([1, "", []]);
      expect(result.keys).not.toContain(`PATCH /channels/${target}`);
      expect(receiptBytes(f)).toBeNull();
    });
  });

test("a source-bound set rechecks the original message and scope on replay", async () => {
  await withDiscordCli(async (f) => {
    await register(f, lane, `discord:${ids.thread}`);
    expect((await f.invoke(set(ids.thread, renamed), options(routes))).code).toBe(0);
    const bytes = receiptBytes(f);
    const gone = { [`GET /channels/${ids.forum}/messages/35`]: { status: 404, body: {} } };
    const unwatched = { DORI_DISCORD_OWNER_ID: "7", DORI_DISCORD_CHANNEL_ID: ids.text };
    for (const scenario of [options({ ...routes, ...gone }), options(routes, unwatched)]) {
      const result = await f.invoke(set(ids.thread, renamed), scenario);
      expect([result.code, result.out, mutations(result.keys)]).toEqual([1, "", []]);
      expect(receiptBytes(f)).toBe(bytes);
    }
  });
}, 60_000);

for (const [label, answer] of [
  ["another thread ID", { body: { id: "41" } }],
  ["a numeric thread ID", { body: { id: 40 } }],
  ["no thread ID", { body: {} }],
] as const)
  test(`a PATCH answered with ${label} stays pending and is never sent again`, async () => {
    await withDiscordCli(async (f) => {
      await register(f, lane, `discord:${ids.thread}`);
      const first = await f.invoke(set(ids.thread, renamed), options({ ...routes, [patch]: answer }));
      expect([first.code, first.out, mutations(first.keys)]).toEqual([1, "", [patch]]);
      expect(first.err).not.toMatch(bypassAdvice);
      const retry = await f.invoke(set(ids.thread, renamed), options(routes));
      expect([retry.code, retry.out, mutations(retry.keys)]).toEqual([1, "", []]);
      expect(retry.err).not.toMatch(bypassAdvice);
    });
  }, 60_000);
