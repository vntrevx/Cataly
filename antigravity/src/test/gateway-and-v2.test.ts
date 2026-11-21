import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { loadConfig, resolveStateDir, updateConfig } from "../core/config.js";
import { Decisions } from "../core/decisions.js";
import { detectImageExtension, downloadDiscordAttachment } from "../discord/attachments.js";
import { clearChannelCache } from "../discord/channels.js";
import { DiscordClient, type DiscordHttpClient } from "../discord/client.js";
import { CATALY_GATEWAY_INTENTS, type MinimalWebSocket, waitForDiscordGateway } from "../discord/gateway.js";
import { clearThreadCache, DiscordInboundState } from "../discord/inbound.js";

const tempDirs: string[] = [];
function makeTempDir(prefix = "cataly-v2-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  clearChannelCache();
  clearThreadCache();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("Discord Gateway v10 WebSocket client", () => {
  it("sends online IDENTIFY, ignores non-owner messages, and resolves immediately on owner MESSAGE_CREATE", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const ownerId = "100000000000000001";
    const otherId = "200000000000000002";
    const channelId = "300000000000000003";
    const questionMsgId = "777777777777777777";

    updateConfig({ discord: { ownerId, channelIds: [channelId], followThreads: true } }, home);
    const dec = new Decisions(stateDir).ask({
      question: "Use Gateway?",
      source: "discord",
      options: ["Yes", "No"],
      recommend: 1,
      message: questionMsgId,
    });

    const fakeHttp: DiscordHttpClient = async (req) => {
      if (req.url.endsWith("/gateway/bot")) return { status: 200, body: JSON.stringify({ url: "wss://fake.gw" }) };
      if (req.url.includes(`/channels/${channelId}/messages`)) {
        return {
          status: 200,
          body: JSON.stringify([
            {
              id: "900000000000000001",
              channel_id: channelId,
              content: "seed",
              timestamp: "2026-01-01T00:00:00Z",
              author: { id: ownerId, username: "owner" },
            },
          ]),
        };
      }
      if (req.url.endsWith(`/channels/${channelId}`)) {
        return { status: 200, body: JSON.stringify({ id: channelId, type: 0, name: "cataly" }) };
      }
      return { status: 404, body: "" };
    };

    const client = new DiscordClient("bot-tok", { http: fakeHttp });
    const sentFrames: Record<string, unknown>[] = [];
    const listeners = new Map<string, ((ev: unknown) => void)[]>();
    const emit = (type: string, ev: unknown) => {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    };

    const fakeWs: MinimalWebSocket = {
      readyState: 1,
      send(data: string) {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        sentFrames.push(parsed);
        if (parsed["op"] === 2) {
          // Reply READY, then a non-owner message, then an owner reply matching the open decision
          queueMicrotask(() => {
            emit("message", { data: JSON.stringify({ op: 0, t: "READY", s: 1, d: {} }) });
            emit("message", {
              data: JSON.stringify({
                op: 0,
                t: "MESSAGE_CREATE",
                s: 2,
                d: {
                  id: "900000000000000002",
                  channel_id: channelId,
                  content: "stranger",
                  timestamp: "2026-01-01T00:01:00Z",
                  author: { id: otherId, username: "stranger" },
                },
              }),
            });
            emit("message", {
              data: JSON.stringify({
                op: 0,
                t: "MESSAGE_CREATE",
                s: 3,
                d: {
                  id: "900000000000000003",
                  channel_id: channelId,
                  content: "1",
                  timestamp: "2026-01-01T00:02:00Z",
                  author: { id: ownerId, username: "owner" },
                  message_reference: { message_id: questionMsgId },
                },
              }),
            });
          });
        }
      },
      close() {
        this.readyState = 3;
      },
      addEventListener(type, fn) {
        listeners.set(type, [...(listeners.get(type) ?? []), fn]);
      },
    };

    let sawOnline = false;
    const resultPromise = waitForDiscordGateway({
      botToken: "bot-tok",
      client,
      stateDir,
      catalyHome: home,
      timeoutMs: 5000,
      wsFactory: () => {
        queueMicrotask(() => {
          emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) });
        });
        return fakeWs;
      },
      onStatus: (s) => {
        if (s === "GATEWAY_ONLINE") sawOnline = true;
      },
    });

    const result = await resultPromise;
    assert.equal(sawOnline, true);
    assert.equal(result.kind, "messages");
    if (result.kind === "messages") {
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0]?.messageId, "900000000000000003");
      assert.equal(result.messages[0]?.matchedDecisionId, dec.id);
    }

    const identify = sentFrames.find((f) => f["op"] === 2) as {
      d?: { intents?: number; presence?: { status?: string } };
    };
    assert.equal(identify?.d?.intents, CATALY_GATEWAY_INTENTS);
    assert.equal(identify?.d?.presence?.status, "online");
    assert.equal(new DiscordInboundState(stateDir).pendingObligations().length, 1);
  });
});

describe("Discord attachments, profile update, and mtime config cache", () => {
  it("downloads Discord CDN images, corrects WebP extension, and rejects non-Discord hosts", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);

    await assert.rejects(
      () => downloadDiscordAttachment("https://evil.example.com/a.png", stateDir),
      /outside Discord CDN/,
    );

    const webpBytes = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38,
    ]);
    assert.equal(detectImageExtension(webpBytes)?.ext, ".webp");

    const saved = await downloadDiscordAttachment("https://cdn.discordapp.com/attachments/1/2/image.png", stateDir, {
      messageId: "12345",
      filename: "image.png",
      fetchImpl: (async () =>
        new Response(webpBytes, { status: 200, headers: { "content-type": "image/webp" } })) as typeof fetch,
    });
    assert.equal(saved.filename, "image.webp");
    assert.equal(saved.detectedType, "image/webp");
    assert.equal(existsSync(saved.savedPath), true);
    assert.equal(readFileSync(saved.savedPath).length, webpBytes.length);
  });

  it("updates bot profile and invalidates mtime config cache on write", async () => {
    const home = makeTempDir();
    updateConfig({ agentName: "Alpha" }, home);
    assert.equal(loadConfig(home).agentName, "Alpha");
    updateConfig({ agentName: "Cataly" }, home);
    assert.equal(loadConfig(home).agentName, "Cataly");

    const calls: string[] = [];
    const client = new DiscordClient("tok", {
      http: async (req) => {
        calls.push(`${req.method} ${new URL(req.url).pathname}`);
        return { status: 200, body: JSON.stringify({ id: "1", username: "Cataly", nick: "Cataly" }) };
      },
    });
    const res = await client.updateProfile({
      username: "Cataly",
      nick: "Cataly",
      description: "Autonomous teammate",
      guildId: "555",
    });
    assert.equal(res.user?.username, "Cataly");
    assert.equal(res.guildNick, "Cataly");
    assert.deepEqual(calls, [
      "PATCH /api/v10/users/@me",
      "PATCH /api/v10/applications/@me",
      "PATCH /api/v10/guilds/555/members/@me",
    ]);
  });
});
