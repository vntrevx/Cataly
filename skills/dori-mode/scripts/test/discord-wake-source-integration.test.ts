import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDiscordLaneInbox } from "../src/messenger/discord-lane-inbox.ts";
import { lifecycleFixture } from "./lifecycle-fixture.ts";

// The record preload's REST fixture: bot 99, owner 10, owner text 101 on channel 20 in the first poll.
const identity = { bot: "99", owner: "10" };

test("wake intake shares the merged channel set and context with the ASK receiver and lane monitor", async () => {
  const f = await lifecycleFixture();
  const { dir } = f.state;
  try {
    // Channel 30 arrives only through the plural setting; its lane holds an owed reply but no unread input,
    // so the lane monitor posts it without any native wake.
    await f.deps.registry.write({ ...f.lane, thread: "discord:30" });
    const inbox = openDiscordLaneInbox(dir);
    try {
      inbox.add(
        f.session,
        { channel: "30", message: "301", text: "question", reference: null, replyTo: null, attachments: [] },
        { reply: identity },
      );
      inbox.acknowledge(f.session, "30", "301");
      inbox.enqueueReply(f.session, "30", { id: "301", parts: ["answer"] });
    } finally {
      inbox.close();
    }
    writeFileSync(
      join(dir, "discord-channels.json"),
      JSON.stringify({
        "30": { purpose: "omp-dori development", name: "dev", updatedAt: "2026-11-17T00:00:00.000Z" },
        "20": { purpose: "one task", updatedAt: "2026-11-17T00:00:00.000Z" },
      }),
    );
    const config = join(dir, "config.json");
    writeFileSync(config, JSON.stringify({ stateDir: dir, runtime: "herdr", hooks: {} }));
    const probe = join(dir, "wake-source-probe.mjs");
    writeFileSync(
      probe,
      [
        `import { discordAskReceivers } from ${JSON.stringify(join(import.meta.dir, "../src/messenger/discord-ask-receiver.ts"))};`,
        "const posts = [];",
        "const recorded = globalThis.fetch;",
        "globalThis.fetch = async (input, init) => {",
        "  const url = new URL(String(input));",
        '  if (url.origin === "https://discord.com" && url.pathname === "/api/v10/channels/30/messages") {',
        '    if ((init?.method ?? "GET") === "GET") return new Response("[]", { status: 200 });',
        "    posts.push({ method: init.method, path: url.pathname, body: JSON.parse(String(init.body)) });",
        '    return new Response(JSON.stringify({ id: "401", channel_id: "30" }), { status: 200 });',
        "  }",
        "  return await recorded(input, init);",
        "};",
        "const recordedSleep = Bun.sleep;",
        'Object.defineProperty(Bun, "sleep", { value: async (ms) => {',
        "  const scopes = discordAskReceivers(process.env.DORI_STATE_DIR, process.env.DORI_DISCORD_TOKEN);",
        '  console.log("DISCORD_WAKE_SOURCE_QA " + JSON.stringify({ scopes, posts }));',
        "  await recordedSleep(ms);",
        "} });",
      ].join("\n"),
    );
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        join(import.meta.dir, "record-discord-inbound.ts"),
        "--preload",
        probe,
        join(import.meta.dir, "../src/cli.ts"),
        "inbound",
        "discord",
        "--wake-lanes",
        "--context",
        "--loop",
        "0.05",
      ],
      {
        env: {
          HOME: dir,
          PATH: "/usr/bin:/bin",
          DORI_CONFIG: config,
          DORI_STATE_DIR: dir,
          DORI_TEST_DISCORD_CASE: "context",
          DORI_DISCORD_TOKEN: "synthetic-inbound-token",
          DORI_DISCORD_OWNER_ID: "10",
          DORI_DISCORD_CHANNEL_ID: " 20,20 ",
          DORI_DISCORD_CHANNEL_IDS: "30, 20, 30",
          DORI_DISCORD_THREADS: "off",
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10_000,
      },
    );
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(out).not.toMatch(/synthetic-inbound-token|private|Authorization/);
    const lines = out.trim().split("\n");
    expect(lines.filter((line) => line.startsWith("WARN") || line.startsWith("DISCORD_LANE_"))).toEqual([]);
    const where = JSON.stringify({
      channel: { id: "30", name: "dev", topic: "editable topic", purpose: "omp-dori development" },
      thread: { id: "20", name: "task thread", purpose: "one task" },
    });
    expect(lines.filter((line) => line.startsWith("INBOUND"))).toEqual([
      "INBOUND_READY discord owner=10 channel=20,30 bot=99",
      'INBOUND discord 20 101 from=owner ref=- "first owner text"',
      `INBOUND_CONTEXT discord 20 101 ${where}`,
      'INBOUND discord 20 103 from=owner ref=101 "owner reply"',
      `INBOUND_CONTEXT discord 20 103 ${where}`,
    ]);
    const prefix = "DISCORD_WAKE_SOURCE_QA ";
    const receipts = lines
      .filter((line) => line.startsWith(prefix))
      .map((line) => JSON.parse(line.slice(prefix.length)));
    const posted = {
      method: "POST",
      path: "/api/v10/channels/30/messages",
      body: {
        content: "answer",
        allowed_mentions: { parse: [], replied_user: false },
        nonce: expect.stringMatching(/^[a-f0-9]{24}$/),
        enforce_nonce: true,
        message_reference: { message_id: "301", fail_if_not_exists: true },
      },
    };
    const receiver = [{ owner: "10", explicit: ["20", "30"], watched: ["20", "30"] }];
    // Both ticks: the receiver publishes the merged set, and the plural-only channel's reply is posted exactly once.
    expect(receipts).toEqual([
      { scopes: receiver, posts: [posted] },
      { scopes: receiver, posts: [posted] },
    ]);
    const after = openDiscordLaneInbox(dir);
    try {
      expect(after.nextReply(f.session, "30", identity)).toBeNull();
    } finally {
      after.close();
    }
  } finally {
    f.state.done();
  }
});
