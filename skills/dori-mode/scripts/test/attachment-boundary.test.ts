import { expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type DiscordResult, type DiscordRoute, withDiscordCli } from "./discord-fakes.ts";

// F54 identity and CDN boundary: every refusal happens before the CDN unless the CDN response itself is wrong.
const secret = "hm=signed-secret";
const pdf = Buffer.from("%PDF-1.7\nboundary").toString("base64");
const environment = {
  DORI_DISCORD_TOKEN: "synthetic-ops-token",
  DORI_DISCORD_OWNER_ID: "10",
  DORI_DISCORD_CHANNEL_ID: "20",
  DORI_DISCORD_CHANNEL_IDS: undefined,
  DORI_DISCORD_SCOPE: undefined,
  DORI_DISCORD_THREADS: undefined,
};
type Setup = {
  readonly ref?: string;
  readonly me?: unknown;
  readonly channel?: unknown;
  readonly channelId?: string;
  readonly message?: Record<string, unknown>;
  readonly attachments?: readonly unknown[];
  readonly url?: string;
  readonly cdn?: DiscordRoute;
  readonly extra?: Record<string, DiscordRoute>;
  readonly env?: Record<string, string | undefined>;
};
const cdn = (channel = "20", file = "500", host = "cdn.discordapp.com") =>
  `https://${host}/attachments/${channel}/${file}/report.pdf?ex=1&${secret}`;
const cdnKey = (channel = "20") => `GET /attachments/${channel}/500/report.pdf?ex=1&${secret}`;
const run = async (setup: Setup = {}) => {
  let result: DiscordResult | undefined;
  let leftovers: string[] = [];
  let written = false;
  await withDiscordCli(async (f) => {
    const channel = setup.channelId ?? "20";
    const out = join(dirname(f.tmp), "out.pdf");
    const url = setup.url ?? cdn(channel);
    result = await f.invoke(["download", setup.ref ?? `discord-file:99:10:${channel}:101:500`, "--out", out], {
      environment: { ...environment, ...setup.env },
      routes: {
        "GET /users/@me": { body: setup.me ?? { id: "99", bot: true } },
        ...(setup.channel === undefined ? {} : { [`GET /channels/${channel}`]: { body: setup.channel } }),
        [`GET /channels/${channel}/messages/101`]: {
          body: {
            id: "101",
            channel_id: channel,
            type: 0,
            author: { id: "10", bot: false },
            attachments: setup.attachments ?? [{ id: "500", filename: "report.pdf", size: 17, url }],
            ...setup.message,
          },
        },
        [`GET ${new URL(url).pathname}${new URL(url).search}`]: { base64: pdf, ...setup.cdn },
        ...setup.extra,
      },
    });
    leftovers = readdirSync(f.tmp);
    written = existsSync(out);
  });
  const r = result!;
  for (const leaked of [secret, "synthetic-ops-token", "/attachments/", "Unknown", "synthetic transport failure"]) {
    expect(r.err).not.toContain(leaked);
  }
  return { ...r, leftovers, written };
};
const refused = (r: DiscordResult & { written: boolean; leftovers: string[] }, cdnCalls = 0): void => {
  expect([r.code, r.out, r.written, r.leftovers]).toEqual([1, "", false, []]);
  expect(r.network.filter((call) => !call.authorization)).toHaveLength(cdnCalls);
};

test.each<[string, unknown]>([
  ["GET /users/@me", { id: "99", bot: true }],
  ["GET /channels/40", { id: "40", type: 11, parent_id: "30" }],
  ["GET /channels/30", { id: "30", type: 15 }],
  [
    "GET /channels/40/messages/101",
    {
      id: "101",
      channel_id: "40",
      type: 0,
      author: { id: "10" },
      attachments: [{ id: "500", filename: "report.pdf", size: 17, url: cdn("40") }],
    },
  ],
])("metadata retries preserve the existing REST policy for %s", async (key, body) => {
  const r = await run({
    channelId: "40",
    env: { DORI_DISCORD_CHANNEL_ID: "30" },
    extra: { [key]: { sequence: [{ status: 429, body: { retry_after: 0 } }, { body }] } },
  });
  expect([r.code, r.err, r.written]).toEqual([0, "", true]);
  expect(r.keys.filter((value) => value === key)).toHaveLength(2);
  expect(r.keys.filter((value) => value === cdnKey("40"))).toHaveLength(1);
});

test("the default channel ref downloads with the exact REST order", async () => {
  const r = await run();
  expect([r.code, r.err, r.written]).toEqual([0, "", true]);
  expect(r.keys).toEqual(["GET /users/@me", "GET /channels/20", "GET /channels/20/messages/101", cdnKey()]);
});

test.each<[string, Setup]>([
  ["a non-bot identity", { me: { id: "99", bot: false } }],
  ["another bot", { me: { id: "98", bot: true } }],
  ["another bot in the ref", { ref: "discord-file:98:10:20:101:500" }],
  ["another owner in the ref", { ref: "discord-file:99:11:20:101:500" }],
  ["a channel outside the watch scope", { channelId: "77", channel: { id: "77", type: 0 } }],
  ["channel metadata for another id", { channel: { id: "21", type: 0 } }],
  ["message metadata for another id", { message: { id: "102" } }],
  ["message metadata for another channel", { message: { channel_id: "21" } }],
  ["a non-owner author", { message: { author: { id: "11", bot: false } } }],
  ["a bot author", { message: { author: { id: "10", bot: true } } }],
  ["a webhook message", { message: { webhook_id: "123" } }],
  ["a system message type", { message: { type: 7 } }],
  [
    "a missing attachment id",
    { attachments: [{ id: "501", filename: "report.pdf", size: 17, url: cdn("20", "501") }] },
  ],
  [
    "a duplicate attachment id",
    {
      attachments: [
        { id: "500", filename: "report.pdf", size: 17, url: cdn() },
        { id: "500", filename: "report.pdf", size: 17, url: cdn() },
      ],
    },
  ],
  ["a negative size", { attachments: [{ id: "500", filename: "report.pdf", size: -1, url: cdn() }] }],
  ["a non-integer size", { attachments: [{ id: "500", filename: "report.pdf", size: 1.5, url: cdn() }] }],
  ["a missing filename", { attachments: [{ id: "500", size: 17, url: cdn() }] }],
  ["a REST 404 for the message", { extra: { "GET /channels/20/messages/101": { status: 404 } } }],
  ["a REST transport failure", { extra: { "GET /users/@me": { failure: "fetch" } } }],
])("%s is refused before the CDN", async (_name, setup) => {
  refused(await run(setup));
});

test.each<[string, Setup]>([
  ["another CDN origin", { url: `https://cdn.example/attachments/20/500/report.pdf?${secret}` }],
  ["plain HTTP", { url: `http://cdn.discordapp.com/attachments/20/500/report.pdf?${secret}` }],
  ["userinfo", { url: `https://u:p@cdn.discordapp.com/attachments/20/500/report.pdf?${secret}` }],
  ["a non-standard port", { url: `https://cdn.discordapp.com:8443/attachments/20/500/report.pdf?${secret}` }],
  ["a fragment", { url: `https://cdn.discordapp.com/attachments/20/500/report.pdf?${secret}#x` }],
  ["another channel path", { url: cdn("21") }],
  ["another attachment path", { url: cdn("20", "501") }],
  ["a non-attachment path", { url: `https://cdn.discordapp.com/emojis/20/500/report.pdf?${secret}` }],
  ["encoded traversal", { url: `https://cdn.discordapp.com/attachments/20/500/%2e%2e%2freport.pdf?${secret}` }],
  ["an encoded slash", { url: `https://cdn.discordapp.com/attachments/20/500/a%2Freport.pdf?${secret}` }],
  ["an encoded backslash", { url: `https://cdn.discordapp.com/attachments/20/500/a%5Creport.pdf?${secret}` }],
  [
    "malformed UTF-8 masking a separator",
    { url: `https://cdn.discordapp.com/attachments/20/500/%2e%2e%2fother%FF?${secret}` },
  ],
  [
    "broken escape masking a separator",
    { url: `https://cdn.discordapp.com/attachments/20/500/%252e%252e%252fother%GG?${secret}` },
  ],
  ["encoded NUL", { url: `https://cdn.discordapp.com/attachments/20/500/a%00report.pdf?${secret}` }],
  ["encoded newline", { url: `https://cdn.discordapp.com/attachments/20/500/a%0Areport.pdf?${secret}` }],
  ["encoded DEL", { url: `https://cdn.discordapp.com/attachments/20/500/a%7Freport.pdf?${secret}` }],
  [
    "nested encoded traversal",
    { url: `https://cdn.discordapp.com/attachments/20/500/%252e%252e%252freport.pdf?${secret}` },
  ],
  ["raw traversal", { url: `https://cdn.discordapp.com/attachments/20/500/../500/report.pdf?${secret}` }],
  ["a raw backslash", { url: `https://cdn.discordapp.com/attachments/20/500/a\\report.pdf?${secret}` }],
])("%s CDN URL is refused before any CDN request", async (_name, setup) => {
  refused(await run(setup));
});

test("a literal percent filename keeps its original SDK URL", async () => {
  const url = `https://cdn.discordapp.com/attachments/20/500/100%25.pdf?${secret}`;
  const r = await run({ url });
  expect([r.code, r.err, r.written]).toEqual([0, "", true]);
  expect(r.network.at(-1)?.href).toBe(url);
});

test("media.discordapp.net is an accepted CDN origin", async () => {
  const r = await run({ url: cdn("20", "500", "media.discordapp.net") });
  expect([r.code, r.err, r.written]).toEqual([0, "", true]);
});

test.each<[string, DiscordRoute]>([
  ["an external redirect", { status: 302, location: "https://evil.example/x" }],
  ["a same-host redirect", { status: 301, location: `/attachments/20/500/report.pdf?ex=2&${secret}` }],
  ["a redirected response", { redirected: true }],
  ["a substituted response URL", { url: "https://evil.example/report.pdf" }],
  ["a CDN transport failure", { failure: "fetch" }],
  ["a CDN HTTP error", { status: 403 }],
])("%s from the CDN is refused after exactly one CDN request", async (_name, route) => {
  const r = await run({ cdn: route });
  refused(r, 1);
  const call = r.network.at(-1)!;
  expect([call.redirect, call.credentials, call.authorization]).toEqual(["error", "omit", false]);
  expect(r.err).not.toContain("evil.example");
});

const thread = { id: "40", type: 11, parent_id: "20" };
test.each([11, 12, 10])("a type %i thread under the watched channel is accepted", async (type) => {
  const r = await run({ channelId: "40", channel: { ...thread, type } });
  expect([r.code, r.err, r.written]).toEqual([0, "", true]);
  expect(r.keys).toContain("GET /channels/40");
  expect(r.keys).toContain("GET /channels/20");
  expect(r.keys.at(-1)).toBe(cdnKey("40"));
});

test.each<[string, Setup]>([
  ["a thread with THREADS=off", { env: { DORI_DISCORD_THREADS: "off" } }],
  ["a thread under another parent", { channel: { ...thread, parent_id: "21" } }],
  ["a non-thread child type", { channel: { ...thread, type: 0 } }],
])("%s is refused before the CDN", async (_name, setup) => {
  refused(await run({ channelId: "40", channel: thread, ...setup }));
});

test("SCOPE=all accepts a readable owner route outside the configured channel", async () => {
  const r = await run({ channelId: "77", channel: { id: "77", type: 0 }, env: { DORI_DISCORD_SCOPE: "all" } });
  expect([r.code, r.err, r.written]).toEqual([0, "", true]);
});

test("CHANNEL_IDS scopes the watched set", async () => {
  const env = { DORI_DISCORD_CHANNEL_ID: undefined, DORI_DISCORD_CHANNEL_IDS: "20,77" };
  const r = await run({ channelId: "77", channel: { id: "77", type: 0 }, env });
  expect([r.code, r.err, r.written]).toEqual([0, "", true]);
});
