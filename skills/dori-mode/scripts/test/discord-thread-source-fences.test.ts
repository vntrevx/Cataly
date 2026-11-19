import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { type DiscordRoute, ids, withDiscordCli } from "./discord-fakes.ts";
import {
  bot,
  bypassAdvice,
  create,
  createIn,
  created,
  environment,
  forumCreated,
  lane,
  mutations,
  options,
  origin,
  ownerMessage,
  receiptBytes,
  receiptPath,
  register,
  type SourceScenario,
  set,
} from "./discord-thread-source-fakes.ts";

const posted = `THREAD ${ids.thread} mid=${ids.starter}`;
const forumPost = `POST /channels/${ids.forum}/threads`;
const posts = (keys: readonly string[]) => keys.filter((key) => key === forumPost).length;

test("without --source the manual create keeps its requests, output and absent receipt", async () => {
  await withDiscordCli(async (f) => {
    const manual = await f.invoke(["thread", "discord", "create", "--to", ids.forum, "--title", "task"]);
    expect([manual.code, manual.out, manual.keys]).toEqual([0, posted, [`GET /channels/${ids.forum}`, forumPost]]);
    expect(existsSync(receiptPath(f))).toBe(false);
  });
});

test("a denied create is a confirmed refusal: the same input succeeds once after access is fixed", async () => {
  await withDiscordCli(async (f) => {
    const forbidden = { [forumPost]: { status: 403, body: { message: "Missing Access" } } };
    const denied = await f.invoke(create(), options(forbidden));
    expect([denied.code, denied.out, posts(denied.keys)]).toEqual([1, "", 1]);
    expect(denied.err).toContain("403");
    expect(denied.err).not.toMatch(/unsupported/i);
    expect(denied.err).not.toMatch(bypassAdvice);
    const fixed = await f.invoke(create(), options());
    expect([fixed.code, fixed.out, posts(fixed.keys)]).toEqual([0, posted, 1]);
    const replay = await f.invoke(create(), options());
    expect([replay.code, replay.out, mutations(replay.keys)]).toEqual([0, posted, []]);
  });
}, 60_000);

const uncertain: readonly [string, DiscordRoute][] = [
  ["a 408 timeout", { status: 408, body: { message: "timeout" } }],
  ["a 503 outage", { status: 503, body: { message: "unavailable" } }],
  ["a transport failure", { failure: "fetch" }],
  ["an unreadable answer", { failure: "body" }],
  ["a missing thread ID", { body: { ...forumCreated, id: undefined } }],
  ["a numeric thread ID", { body: { ...forumCreated, id: 40 } }],
  ["the parent channel ID", { body: { ...forumCreated, id: ids.forum } }],
  ["another parent", { body: { ...forumCreated, parent_id: ids.media } }],
  ["another owner", { body: { ...forumCreated, owner_id: "98" } }],
  ["a non-thread type", { body: { ...forumCreated, type: 0 } }],
];
for (const [label, answer] of uncertain)
  test(`a create answered with ${label} stays pending: neither a retry nor another key posts again`, async () => {
    await withDiscordCli(async (f) => {
      const first = await f.invoke(create(), options({ [forumPost]: answer }));
      expect([first.code, first.out, posts(first.keys)]).toEqual([1, "", 1]);
      expect(first.err).not.toMatch(bypassAdvice);
      for (const key of [lane, "other-task"]) {
        const retry = await f.invoke(create([], undefined, key), options());
        expect([retry.code, retry.out, mutations(retry.keys)]).toEqual([1, "", []]);
        expect(retry.err).not.toMatch(bypassAdvice);
      }
    });
  }, 60_000);

const textScenario = (messages: DiscordRoute): SourceScenario => ({
  environment: { ...environment, DORI_DISCORD_CHANNEL_ID: ids.text },
  routes: {
    "GET /users/@me": { body: { id: bot } },
    [`GET /channels/${ids.text}`]: { body: { id: ids.text, type: 0, name: "chat" } },
    [`GET /channels/${ids.text}/messages/${origin}`]: { body: ownerMessage(ids.text) },
    [`POST /channels/${ids.text}/threads`]: { body: created(ids.text) },
    [`POST /channels/${ids.thread}/messages`]: messages,
  },
});
const forumScenario = (messages: DiscordRoute): SourceScenario =>
  options({ [`POST /channels/${ids.thread}/messages`]: messages });
type FailedStarter = readonly [string, readonly string[], (messages: DiscordRoute) => SourceScenario, string];
const failedStarters: readonly FailedStarter[] = [
  [
    "a text thread's starter",
    createIn(ids.text, ["--text", "starter"]),
    textScenario,
    `POST /channels/${ids.text}/threads`,
  ],
  ["a long forum post's continuation", create(["--text", "x".repeat(2500)]), forumScenario, forumPost],
];
for (const [label, args, scenario, creation] of failedStarters)
  test(`a failed follow-up after ${label} reports the created thread and never creates it again`, async () => {
    await withDiscordCli(async (f) => {
      const failed = await f.invoke(args, scenario({ status: 503, body: { message: "unavailable" } }));
      expect([failed.code, failed.out]).toEqual([1, ""]);
      expect(failed.keys.filter((key) => key === creation)).toHaveLength(1);
      expect(failed.err).toContain(ids.thread);
      expect(failed.err).not.toMatch(bypassAdvice);
      // The thread ID is durable before any follow-up message is sent.
      expect(receiptBytes(f)).not.toBeNull();
      const retry = await f.invoke(args, scenario({ body: { id: ids.message } }));
      expect([retry.code, retry.out]).toEqual([1, ""]);
      expect(retry.keys).not.toContain(creation);
      expect(retry.err).not.toMatch(bypassAdvice);
    });
  }, 60_000);

test("a confirmed create rechecks the original message and current scope before replaying", async () => {
  await withDiscordCli(async (f) => {
    expect((await f.invoke(create(), options())).out).toBe(posted);
    const bytes = receiptBytes(f);
    const gone = { [`GET /channels/${ids.forum}/messages/${origin}`]: { status: 404, body: {} } };
    for (const scenario of [options(gone), options({}, { ...environment, DORI_DISCORD_CHANNEL_ID: ids.text })]) {
      const result = await f.invoke(create(), scenario);
      expect([result.code, result.out, mutations(result.keys)]).toEqual([1, "", []]);
      expect(receiptBytes(f)).toBe(bytes);
    }
  });
}, 60_000);

for (const damaged of ["{", "not json"])
  test(`a damaged receipt file ${JSON.stringify(damaged)} blocks every source-bound mutation and is kept`, async () => {
    await withDiscordCli(async (f) => {
      await register(f, "set-task", `discord:${ids.thread}`);
      writeFileSync(receiptPath(f), damaged, { mode: 0o600 });
      for (const args of [create(), set(ids.thread, ["--title", "renamed"], undefined, "set-task")]) {
        const result = await f.invoke(args, options());
        expect([result.code, result.out, mutations(result.keys)]).toEqual([1, "", []]);
        expect(receiptBytes(f)).toBe(damaged);
      }
    });
  }, 60_000);

for (const status of [200, 503])
  test(`a ${status} create receipt fences the same physical source even after the bot identity changes`, async () => {
    await withDiscordCli(async (f) => {
      const first = await f.invoke(create(), options({ [forumPost]: { status, body: forumCreated } }));
      expect(first.code).toBe(status === 200 ? 0 : 1);
      const bytes = receiptBytes(f);
      const changed = options({
        "GET /users/@me": { body: { id: "100" } },
        [forumPost]: { body: { ...forumCreated, owner_id: "100" } },
      });
      const replay = await f.invoke(create([], undefined, "other-task"), changed);
      expect([replay.code, replay.out, mutations(replay.keys)]).toEqual([1, "", []]);
      expect(receiptBytes(f)).toBe(bytes);
    });
  });

test("a missing forum starter acknowledgement keeps the known thread without reporting complete success", async () => {
  await withDiscordCli(async (f) => {
    const first = await f.invoke(create(), options({ [forumPost]: { body: { ...forumCreated, message: {} } } }));
    expect([first.code, first.out, posts(first.keys)]).toEqual([1, "", 1]);
    expect(first.err).toContain("thread 40 exists");
    const bytes = receiptBytes(f);
    const replay = await f.invoke(create(), options());
    expect([replay.code, replay.out, mutations(replay.keys)]).toEqual([1, "", []]);
    expect(receiptBytes(f)).toBe(bytes);
  });
});
