import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DiscordRoute, ids, withDiscordCli } from "./discord-fakes.ts";

const source = "discord 40 50";
const environment = { DORI_DISCORD_OWNER_ID: "7", DORI_DISCORD_SCOPE: "all" };
const routes: Record<string, DiscordRoute> = {
  "GET /users/@me": { body: { id: "70" } },
  "GET /channels/40": { body: { id: "40", type: 11, parent_id: "30", name: "same" } },
  "GET /channels/41": { body: { id: "41", type: 11, parent_id: "30", name: "same" } },
  "GET /channels/40/messages/50": {
    body: { id: "50", channel_id: "40", type: 0, author: { id: "7" }, content: "set the purpose" },
  },
};
const options = { environment, routes };
const set = (id: string, purpose: string, origin = source) => [
  "channel",
  "discord",
  "set",
  id,
  "--purpose",
  purpose,
  "--source",
  origin,
];
const clear = (id: string) => ["channel", "discord", "clear", id, "--source", source];
const saved = (tmp: string) => readFileSync(join(dirname(tmp), "discord-channels.json"), "utf8");

test("source-bound purpose retries preserve the original result without undoing later manual edits", async () => {
  await withDiscordCli(async (f) => {
    const first = await f.invoke(set(ids.forum, "original"), options);
    expect([first.code, first.err, first.out]).toEqual([0, "", 'PURPOSE 30 "original"']);
    expect(first.keys).toContain("GET /channels/40/messages/50");
    expect((await f.invoke(["channel", "discord", "set", ids.forum, "--purpose", "manual"])).code).toBe(0);
    const before = saved(f.tmp);
    const retry = await f.invoke(set(ids.forum, "original"), {
      environment,
      routes: { ...routes, "GET /channels/30": { body: { id: "30", type: 15, name: "renamed" } } },
    });
    expect([retry.code, retry.err, retry.out]).toEqual([0, "", first.out]);
    expect(saved(f.tmp)).toBe(before);
    expect((await f.invoke(["channel", "discord", "list"])).out).toContain('purpose="manual"');
  });
});

test("one source and destination cannot be reused for another purpose or a clear", async () => {
  await withDiscordCli(async (f) => {
    expect((await f.invoke(set(ids.forum, "original"), options)).code).toBe(0);
    const before = saved(f.tmp);
    for (const args of [set(ids.forum, "different"), clear(ids.forum)]) {
      const result = await f.invoke(args, options);
      expect(result.code).toBe(1);
      expect(result.err).toContain("source identity conflict");
      expect(result.out).toBe("");
      expect(saved(f.tmp)).toBe(before);
    }
    // The original thread is a distinct, permitted destination, not the parent receipt.
    expect((await f.invoke(set(ids.thread, "thread purpose"), options)).code).toBe(0);
  });
});

test("a source-bound clear replays its original receipt without deleting a later note", async () => {
  await withDiscordCli(async (f) => {
    expect((await f.invoke(["channel", "discord", "set", ids.forum, "--purpose", "before"])).code).toBe(0);
    const first = await f.invoke(clear(ids.forum), options);
    expect([first.code, first.out]).toEqual([0, "PURPOSE_CLEARED 30"]);
    expect((await f.invoke(["channel", "discord", "set", ids.forum, "--purpose", "later"])).code).toBe(0);
    const before = saved(f.tmp);
    const retry = await f.invoke(clear(ids.forum), options);
    expect([retry.code, retry.out]).toEqual([0, first.out]);
    expect(saved(f.tmp)).toBe(before);
  });
});

test("source-bound listing includes only the original thread and exact parent, never a same-name sibling", async () => {
  await withDiscordCli(async (f) => {
    for (const id of [ids.text, ids.forum, ids.thread, "41"])
      expect((await f.invoke(["channel", "discord", "set", id, "--purpose", id], options)).code).toBe(0);
    const before = saved(f.tmp);
    const result = await f.invoke(["channel", "discord", "list", "--source", source], options);
    expect([result.code, result.err]).toEqual([0, ""]);
    expect(result.out.split("\n").map((line) => line.split(" ")[1])).toEqual([ids.forum, ids.thread]);
    expect(saved(f.tmp)).toBe(before);
  });
});

for (const destination of [ids.text, "41"])
  test(`source binding refuses unrelated destination ${destination} even when it is otherwise allowed`, async () => {
    await withDiscordCli(async (f) => {
      expect((await f.invoke(["channel", "discord", "set", destination, "--purpose", "keep"], options)).code).toBe(0);
      const before = saved(f.tmp);
      for (const args of [set(destination, "wrong"), clear(destination)]) {
        const result = await f.invoke(args, options);
        expect([result.code, result.out]).toEqual([1, ""]);
        expect(result.err).toContain("original source");
        expect(saved(f.tmp)).toBe(before);
      }
    });
  });

for (const origin of ["", "discord 40", "discord 40 50 extra", "slack 40 50", "discord 0 50", "discord 40 5.0"])
  test(`invalid purpose source ${JSON.stringify(origin)} is refused before any request`, async () => {
    await withDiscordCli(async (f) => {
      const result = await f.invoke(set(ids.forum, "purpose", origin), options);
      expect([result.code, result.out, result.keys]).toEqual([1, "", []]);
      expect(result.err).toContain("--source");
    });
  });

test("source-bound destinations require IDs while the existing manual name lookup remains available", async () => {
  await withDiscordCli(async (f) => {
    const named = { ...options, environment: { ...environment, DORI_DISCORD_GUILD_ID: ids.guild } };
    const bound = await f.invoke(set("#tasks", "purpose"), named);
    expect([bound.code, bound.out, bound.keys]).toEqual([1, "", []]);
    expect((await f.invoke(["channel", "discord", "set", "#tasks", "--purpose", "manual"], named)).code).toBe(0);
  });
});

for (const [label, body] of [
  ["another author", { id: "50", channel_id: "40", type: 0, author: { id: "8" } }],
  ["another message", { id: "51", channel_id: "40", type: 0, author: { id: "7" } }],
  ["another channel", { id: "50", channel_id: "41", type: 0, author: { id: "7" } }],
  ["a bot", { id: "50", channel_id: "40", type: 0, author: { id: "7", bot: true } }],
  ["a system message", { id: "50", channel_id: "40", type: 7, author: { id: "7" } }],
  ["a webhook", { id: "50", channel_id: "40", type: 0, author: { id: "7" }, webhook_id: "80" }],
] as const)
  test(`a purpose source that is ${label} cannot change notes`, async () => {
    await withDiscordCli(async (f) => {
      expect((await f.invoke(["channel", "discord", "set", ids.forum, "--purpose", "keep"])).code).toBe(0);
      const before = saved(f.tmp);
      const result = await f.invoke(set(ids.forum, "wrong"), {
        environment,
        routes: { ...routes, "GET /channels/40/messages/50": { body } },
      });
      expect([result.code, result.out]).toEqual([1, ""]);
      expect(saved(f.tmp)).toBe(before);
    });
  });

test("a text channel's category is not a source conversation parent", async () => {
  await withDiscordCli(async (f) => {
    const result = await f.invoke(set(ids.forum, "wrong", "discord 20 50"), {
      environment,
      routes: {
        ...routes,
        "GET /channels/20": { body: { id: "20", type: 0, parent_id: "30" } },
        "GET /channels/20/messages/50": { body: { id: "50", channel_id: "20", type: 0, author: { id: "7" } } },
      },
    });
    expect([result.code, result.out]).toEqual([1, ""]);
    expect(result.err).toContain("original source");
  });
});

test("source commands retain watched-parent and explicit-thread admission, and recheck current scope on retry", async () => {
  await withDiscordCli(async (f) => {
    const watched = { DORI_DISCORD_OWNER_ID: "7", DORI_DISCORD_CHANNEL_ID: ids.forum };
    const disabled = { environment: { ...watched, DORI_DISCORD_THREADS: "off" }, routes };
    expect((await f.invoke(set(ids.thread, "purpose"), disabled)).code).toBe(1);
    const first = await f.invoke(set(ids.thread, "purpose"), { environment: watched, routes });
    expect([first.code, first.out]).toEqual([0, 'PURPOSE 40 "purpose"']);
    const before = saved(f.tmp);
    expect((await f.invoke(set(ids.thread, "purpose"), disabled)).code).toBe(1);
    expect(saved(f.tmp)).toBe(before);
    const explicit = { ...watched, DORI_DISCORD_CHANNEL_ID: ids.thread, DORI_DISCORD_THREADS: "off" };
    expect((await f.invoke(set(ids.thread, "purpose"), { environment: explicit, routes })).out).toBe(first.out);
    expect(saved(f.tmp)).toBe(before);
  });
});

const badMetadata: readonly [string, Record<string, DiscordRoute>][] = [
  ["a non-string bot ID", { "GET /users/@me": { body: { id: 70 } } }],
  ["another source channel", { "GET /channels/40": { body: { id: "41", type: 11, parent_id: "30" } } }],
  ["missing thread provenance", { "GET /channels/40": { body: { id: "40", type: 11 } } }],
  ["another destination", { "GET /channels/30": { body: { id: "20", type: 0 } } }],
  ["an invalid destination", { "GET /channels/30": { body: null } }],
  ["a denied parent", { "GET /channels/30": { status: 403, body: { message: "private-response-token" } } }],
  ["a denied source", { "GET /channels/40/messages/50": { status: 403, body: { message: "private-response-token" } } }],
];
for (const [label, override] of badMetadata)
  test(`source verification refuses ${label} without publishing a purpose receipt`, async () => {
    await withDiscordCli(async (f) => {
      expect((await f.invoke(["channel", "discord", "set", ids.forum, "--purpose", "keep"])).code).toBe(0);
      const before = saved(f.tmp);
      const result = await f.invoke(set(ids.forum, "wrong"), { environment, routes: { ...routes, ...override } });
      expect([result.code, result.out]).toEqual([1, ""]);
      expect(result.err).not.toContain("private-response-token");
      expect(saved(f.tmp)).toBe(before);
    });
  });

test("an earlier receipt does not bypass a now-unavailable original message", async () => {
  await withDiscordCli(async (f) => {
    expect((await f.invoke(set(ids.forum, "original"), options)).code).toBe(0);
    const before = saved(f.tmp);
    const result = await f.invoke(set(ids.forum, "original"), {
      environment,
      routes: { ...routes, "GET /channels/40/messages/50": { status: 404, body: {} } },
    });
    expect([result.code, result.out]).toEqual([1, ""]);
    expect(saved(f.tmp)).toBe(before);
  });
});
