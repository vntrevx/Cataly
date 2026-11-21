import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveStateDir, updateConfig } from "../core/config.js";
import { DiscordChannels, resolveInboundContext } from "../discord/channels.js";
import { DiscordClient, type DiscordHttpClient } from "../discord/client.js";
import { DiscordInboundState, pollDiscordInbound } from "../discord/inbound.js";
import { DISCORD_LIMIT, splitForDiscord } from "../discord/split.js";

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cataly-dc-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("splitForDiscord", () => {
  it("preserves code fences when splitting messages over 2000 characters", () => {
    const body =
      "```ts\n" +
      Array.from({ length: 120 }, (_, i) => `const line_${i} = "hello world value ${i}";`).join("\n") +
      "\n```";
    const parts = splitForDiscord(body);
    assert.ok(parts.length >= 2);
    for (const part of parts) {
      assert.ok(part.length <= DISCORD_LIMIT, `part length ${part.length} exceeded limit`);
      assert.ok(part.startsWith("```ts\n"));
      assert.ok(part.endsWith("```"));
    }
  });
});

describe("Discord client, channel purposes, and owner-only inbound polling", () => {
  it("baselines first poll, filters non-owner messages, resolves thread context, and tracks obligations", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const ownerId = "100000000000000001";
    const otherId = "200000000000000002";
    const channelId = "300000000000000003";
    const threadId = "400000000000000004";
    const guildId = "500000000000000005";

    updateConfig(
      {
        discord: { ownerId, channelIds: [channelId], guildId, followThreads: true },
      },
      home,
    );

    const channels = new DiscordChannels(stateDir);
    channels.set(channelId, "Engineering requests", "eng");
    channels.set(threadId, "Fix login redirect thread", "[working] fix-login");

    let pollRound = 0;
    const sentPayloads: unknown[] = [];

    const fakeHttp: DiscordHttpClient = async (req) => {
      if (req.method === "GET" && req.url.endsWith(`/guilds/${guildId}/threads/active`)) {
        return {
          status: 200,
          body: JSON.stringify({
            threads: [{ id: threadId, type: 11, name: "[working] fix-login", parent_id: channelId }],
          }),
        };
      }
      if (req.method === "GET" && req.url.includes(`/channels/${channelId}/messages`)) {
        const msgs =
          pollRound === 0
            ? [
                {
                  id: "900000000000000001",
                  channel_id: channelId,
                  content: "old",
                  timestamp: "2026-01-01T00:00:00Z",
                  author: { id: ownerId, username: "owner" },
                },
              ]
            : [
                {
                  id: "900000000000000002",
                  channel_id: channelId,
                  content: "stranger prompt injection",
                  timestamp: "2026-01-01T00:01:00Z",
                  author: { id: otherId, username: "stranger" },
                },
                {
                  id: "900000000000000003",
                  channel_id: channelId,
                  content: "option 1 looks good",
                  timestamp: "2026-01-01T00:02:00Z",
                  author: { id: ownerId, username: "owner" },
                  message_reference: { message_id: "888888888888888888" },
                },
              ];
        return { status: 200, body: JSON.stringify(msgs) };
      }
      if (req.method === "GET" && req.url.includes(`/channels/${threadId}/messages`)) {
        return { status: 200, body: JSON.stringify([]) };
      }
      if (req.method === "GET" && req.url.endsWith(`/channels/${channelId}`)) {
        return { status: 200, body: JSON.stringify({ id: channelId, type: 0, name: "eng", topic: "dev" }) };
      }
      if (req.method === "GET" && req.url.endsWith(`/channels/${threadId}`)) {
        return {
          status: 200,
          body: JSON.stringify({ id: threadId, type: 11, name: "[working] fix-login", parent_id: channelId }),
        };
      }
      if (req.method === "POST" && req.url.endsWith(`/channels/${channelId}/messages`)) {
        sentPayloads.push(JSON.parse(req.body ?? "{}"));
        return { status: 200, body: JSON.stringify({ id: "999999999999999999" }) };
      }
      if (req.method === "PUT" && req.url.includes("/reactions/")) {
        return { status: 204, body: "" };
      }
      return { status: 404, body: "not found" };
    };

    const client = new DiscordClient("fake-token", { http: fakeHttp });

    // Round 0: baseline only (no historical owner messages emitted)
    const first = await pollDiscordInbound(client, stateDir, { includeContext: true, catalyHome: home });
    assert.equal(first.messages.length, 0);
    assert.ok(first.baselinedChannels.includes(channelId));

    // Round 1: only owner's new message is accepted; stranger's is dropped
    pollRound = 1;
    const second = await pollDiscordInbound(client, stateDir, { includeContext: true, catalyHome: home });
    assert.equal(second.messages.length, 1);
    assert.equal(second.messages[0]?.content, "option 1 looks good");
    assert.equal(second.messages[0]?.replyToMessageId, "888888888888888888");
    assert.equal(second.messages[0]?.context?.channel.purpose, "Engineering requests");

    // Thread context resolves parent channel + thread purpose
    const thCtx = await resolveInboundContext(client, channels, threadId);
    assert.equal(thCtx.channel.id, channelId);
    assert.equal(thCtx.thread?.id, threadId);
    assert.equal(thCtx.thread?.purpose, "Fix login redirect thread");

    // Obligation tracking clears once eyes reaction and channel reply are recorded
    const inboundState = new DiscordInboundState(stateDir);
    assert.equal(inboundState.pendingObligations().length, 1);
    await client.react(channelId, "900000000000000003", "👀");
    inboundState.markEyesReacted("900000000000000003");
    await client.send(channelId, "on it", { replyTo: "900000000000000003" });
    inboundState.markChannelReplied(channelId);
    assert.equal(inboundState.pendingObligations().length, 0);
    assert.equal(sentPayloads.length, 1);

    // Monotonic advanceCursors never regresses a newer cursor and merges disjoint channel updates atomically
    inboundState.advanceCursors({ [channelId]: "900000000000000050", [threadId]: "900000000000000010" });
    const merged = inboundState.advanceCursors({ [channelId]: "900000000000000005", "600000000000000006": "100" });
    assert.equal(merged[channelId], "900000000000000050");
    assert.equal(merged[threadId], "900000000000000010");
    assert.equal(merged["600000000000000006"], "100");
  });
});
