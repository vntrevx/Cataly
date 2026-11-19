import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { openDiscordAskMailbox } from "../src/messenger/discord-ask-mailbox.ts";
import { discordInbound, formatDiscordInbound } from "../src/messenger/discord-inbound.ts";
import { toInbound } from "../src/messenger/discord-inbound-api.ts";
import { fileDiscordInboundStore } from "../src/messenger/discord-inbound-state.ts";
import { withDiscordCli } from "./discord-fakes.ts";
import { discordRestWorld, memoryDiscordCursor, ownerMessage } from "./discord-inbound-fakes.ts";

const url = "https://cdn.discordapp.com/attachments/20/500/file.pdf?ex=1&hm=signed-secret";
const attachment = { id: "500", filename: "file.pdf", size: 7, url };
const owner = (attachments: unknown = [attachment]) => ownerMessage("101", { content: "read this", attachments });
const record = (group: string): Record<string, unknown> => {
  const line = group.split("\n").find((value) => value.startsWith("INBOUND_ATTACHMENT discord 20 101 "));
  if (!line) throw new Error("attachment output is missing");
  return JSON.parse(line.slice("INBOUND_ATTACHMENT discord 20 101 ".length)) as Record<string, unknown>;
};

test("default consumers keep the exact signed URL and gain an additive original-route reference", () => {
  const inbound = toInbound(owner(), "99");
  // Existing consumers read attachments[].url or the same field in the JSON record.
  expect(inbound.attachments[0]?.url).toBe(url);
  expect(record(formatDiscordInbound(inbound))).toEqual({
    filename: "file.pdf",
    size: 7,
    url,
    id: "500",
    ref: "discord-file:99:10:20:101:500",
  });
  const privateRecord = record(formatDiscordInbound(inbound, true));
  expect(privateRecord).toEqual({ filename: "file.pdf", size: 7, id: "500", ref: "discord-file:99:10:20:101:500" });
  expect(formatDiscordInbound(inbound, true)).not.toContain("signed-secret");
  expect(inbound.attachments[0]?.url).toBe(url); // Formatting never mutates the shared admitted payload.
});

test.each([undefined, "invalid", "0500"])("legacy attachment id %p keeps its original default URL record", (id) => {
  const inbound = toInbound(owner([{ ...attachment, id }]), "99");
  expect(record(formatDiscordInbound(inbound))).toEqual({ filename: "file.pdf", size: 7, url });
  expect(() => formatDiscordInbound(inbound, true)).toThrow("no unique file reference");
});

test("duplicate resource IDs retain legacy URLs but cannot become ambiguous reference-only records", () => {
  const inbound = toInbound(owner([attachment, { ...attachment, filename: "second.pdf" }]), "99");
  expect(inbound.attachments.map((value) => value.url)).toEqual([url, url]);
  expect(inbound.attachments.every((value) => value.ref === undefined)).toBe(true);
  expect(() => formatDiscordInbound(inbound, true)).toThrow("no unique file reference");
});

test("a reference-only refusal keeps the cursor before the owner, and default output can still deliver it", async () => {
  const world = discordRestWorld([owner([{ filename: "file.pdf", size: 7, url }])]);
  const cursor = memoryDiscordCursor("100");
  const intake = await discordInbound(world.discord, () => cursor.store, { ownerId: "10", channelIds: ["20"] });
  const groups: string[] = [];
  await expect(intake.poll((message) => groups.push(formatDiscordInbound(message, true)))).rejects.toThrow(
    "no unique file reference",
  );
  expect([groups, cursor.saved, cursor.store.load()]).toEqual([[], [], "100"]);
  await intake.poll((message) => groups.push(formatDiscordInbound(message)));
  expect([groups.length, cursor.saved, cursor.store.load()]).toEqual([1, ["101"], "101"]);
  expect(record(groups[0]!)["url"]).toBe(url);
});

test.each<[string, boolean, unknown[], boolean]>([
  ["legacy default", false, [{ filename: "file.pdf", size: 7, url }], false],
  ["missing attachment ID", true, [{ filename: "file.pdf", size: 7, url }], true],
  ["invalid attachment ID", true, [{ ...attachment, id: "invalid" }], true],
  ["duplicate attachment ID", true, [attachment, attachment], true],
  ["valid reference", true, [attachment], false],
])("reference-only ASK policy preserves the mailbox and cursor: %s", async (_name, refs, attachments, refused) => {
  await withDiscordCli(async (f) => {
    const state = dirname(f.tmp);
    const cursor = fileDiscordInboundStore(state, "20");
    cursor.save("100");
    const mailbox = openDiscordAskMailbox(state, "20", "99", "10");
    const message = { ...owner(attachments), type: 19, message_reference: { message_id: "99" } };
    const r = await f.invoke(["inbound", "discord", "--loop", "0", ...(refs ? ["--attachment-refs"] : [])], {
      environment: { DORI_DISCORD_OWNER_ID: "10", DORI_DISCORD_CHANNEL_ID: "20", DORI_DISCORD_THREADS: "off" },
      routes: {
        "GET /users/@me": { body: { id: "99", bot: true } },
        "GET /applications/@me": { body: { flags: 1 << 18 } },
        "GET /channels/20/messages?limit=1": { body: [message] },
        "GET /channels/20/messages?limit=100": { body: [message] },
        "GET /channels/20/messages?limit=100&before=101": { body: [] },
      },
    });
    // The existing one-shot poll reports callback failures as WARN, not a process exit error.
    expect([r.code, r.err]).toEqual([0, ""]);
    expect({
      warning: r.out.includes("WARN Discord attachment has no unique file reference"),
      replies: mailbox.replies(new Set()),
      cursor: cursor.load(),
    }).toEqual({
      warning: refused,
      replies: refused ? [] : [{ id: "101", text: "read this" }],
      cursor: refused ? "100" : "101",
    });
    expect(r.out).not.toContain("INBOUND discord ");
    expect(r.out).not.toContain("signed-secret");
  });
});

test.each([false, true])(
  "actual inbound CLI attachment-refs=%s is explicitly selected and keeps one owner commit",
  async (refs) => {
    await withDiscordCli(async (f) => {
      const state = dirname(f.tmp);
      fileDiscordInboundStore(state, "20").save("100");
      const r = await f.invoke(["inbound", "discord", "--loop", "0", ...(refs ? ["--attachment-refs"] : [])], {
        environment: {
          DORI_DISCORD_OWNER_ID: "10",
          DORI_DISCORD_CHANNEL_ID: "20",
          DORI_DISCORD_THREADS: "off",
        },
        routes: {
          "GET /users/@me": { body: { id: "99", bot: true } },
          "GET /applications/@me": { body: { flags: 1 << 18 } },
          "GET /channels/20/messages?limit=1": { body: [owner()] },
          "GET /channels/20/messages?limit=100": { body: [owner()] },
          "GET /channels/20/messages?limit=100&before=101": { body: [] },
        },
      });
      expect([r.code, r.err]).toEqual([0, ""]);
      const value = record(r.out);
      expect(value["ref"]).toBe("discord-file:99:10:20:101:500");
      expect(value["url"]).toBe(refs ? undefined : url);
      expect(r.out.split("\n").filter((line) => line.startsWith("INBOUND discord "))).toHaveLength(1);
      expect(fileDiscordInboundStore(state, "20").load()).toBe("101");
      expect(r.network.every((call) => new URL(call.href).hostname === "discord.com")).toBe(true);
    });
  },
);

test("the Discord-only opt in is rejected before starting another platform", async () => {
  await withDiscordCli(async (f) => {
    for (const platform of ["telegram", "slack"]) {
      const r = await f.invoke(["inbound", platform, "--loop", "0", "--attachment-refs"]);
      expect([r.code, r.err, r.keys]).toEqual([1, "--attachment-refs is supported for discord only", []]);
    }
  });
});
