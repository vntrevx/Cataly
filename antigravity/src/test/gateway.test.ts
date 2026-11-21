import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveStateDir, updateConfig } from "../core/config.js";
import { clearChannelCache } from "../discord/channels.js";
import { DiscordClient, type DiscordHttpClient } from "../discord/client.js";
import { type MinimalWebSocket, waitForDiscordGateway } from "../discord/gateway.js";
import { clearThreadCache, DiscordInboundState } from "../discord/inbound.js";

const tempDirs: string[] = [];
function makeTempDir(prefix = "cataly-gw-"): string {
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

function createGatewayFixture(opts: { ownerId: string; channelId: string; reactDelayMs?: (url: string) => number }) {
  const reactedUrls: string[] = [];
  let typingCount = 0;

  const fakeHttp: DiscordHttpClient = async (req) => {
    if (req.url.endsWith("/gateway/bot")) {
      return { status: 200, body: JSON.stringify({ url: "wss://fake.gw" }) };
    }
    if (req.method === "GET" && req.url.includes(`/channels/${opts.channelId}/messages`)) {
      return {
        status: 200,
        body: JSON.stringify([
          {
            id: "900000000000000001",
            channel_id: opts.channelId,
            content: "seed",
            timestamp: "2026-01-01T00:00:00Z",
            author: { id: opts.ownerId, username: "owner" },
          },
        ]),
      };
    }
    if (req.method === "GET" && req.url.endsWith(`/channels/${opts.channelId}`)) {
      return { status: 200, body: JSON.stringify({ id: opts.channelId, type: 0, name: "cataly" }) };
    }
    if (req.method === "PUT" && req.url.includes("/reactions/")) {
      const delay = opts.reactDelayMs?.(req.url) ?? 0;
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
      reactedUrls.push(req.url);
      return { status: 204, body: "" };
    }
    if (req.method === "POST" && req.url.endsWith(`/channels/${opts.channelId}/typing`)) {
      typingCount++;
      return { status: 204, body: "" };
    }
    return { status: 404, body: "" };
  };

  const listeners = new Map<string, ((ev: unknown) => void)[]>();
  const emit = (type: string, ev: unknown) => {
    for (const fn of listeners.get(type) ?? []) fn(ev);
  };

  let onIdentify: (() => void) | null = null;
  const fakeWs: MinimalWebSocket = {
    readyState: 1,
    send(data: string) {
      const parsed = JSON.parse(data) as { op?: number };
      if (parsed.op === 2) {
        queueMicrotask(() => {
          emit("message", { data: JSON.stringify({ op: 0, t: "READY", s: 1, d: {} }) });
          onIdentify?.();
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

  const emitOwnerMessage = (seq: number, id: string, content: string) => {
    emit("message", {
      data: JSON.stringify({
        op: 0,
        t: "MESSAGE_CREATE",
        s: seq,
        d: {
          id,
          channel_id: opts.channelId,
          content,
          timestamp: "2026-01-01T00:01:00Z",
          author: { id: opts.ownerId, username: "owner" },
        },
      }),
    });
  };

  return {
    client: new DiscordClient("tok", { http: fakeHttp }),
    wsFactory: () => {
      queueMicrotask(() => {
        emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) });
      });
      return fakeWs;
    },
    setOnIdentify: (fn: () => void) => {
      onIdentify = fn;
    },
    emitOwnerMessage,
    reactedUrls,
    getTypingCount: () => typingCount,
  };
}

describe("Discord Gateway burst coalescing & flush semantics", () => {
  it("coalesces rapid multi-line owner bursts chronologically by Snowflake ID with autoAck on every message", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const ownerId = "100000000000000001";
    const channelId = "300000000000000003";
    updateConfig({ discord: { ownerId, channelIds: [channelId], followThreads: false } }, home);

    // Deliberately make the earlier message's ack slower so async resolution completes out-of-order
    const fixture = createGatewayFixture({
      ownerId,
      channelId,
      reactDelayMs: (url) => (url.includes("900000000000000010") ? 35 : 5),
    });

    fixture.setOnIdentify(() => {
      fixture.emitOwnerMessage(2, "900000000000000010", "first line of thought");
      setTimeout(() => {
        fixture.emitOwnerMessage(3, "900000000000000011", "second line of thought");
      }, 15);
    });

    const result = await waitForDiscordGateway({
      botToken: "tok",
      client: fixture.client,
      stateDir,
      catalyHome: home,
      timeoutMs: 3000,
      debounceMs: 90,
      maxDebounceMs: 400,
      autoAck: true,
      wsFactory: fixture.wsFactory,
    });

    assert.equal(result.kind, "messages");
    if (result.kind === "messages") {
      assert.equal(result.messages.length, 2);
      assert.equal(result.messages[0]?.messageId, "900000000000000010");
      assert.equal(result.messages[0]?.content, "first line of thought");
      assert.equal(result.messages[0]?.autoAcked, true);
      assert.equal(result.messages[1]?.messageId, "900000000000000011");
      assert.equal(result.messages[1]?.content, "second line of thought");
      assert.equal(result.messages[1]?.autoAcked, true);
    }
    assert.equal(fixture.reactedUrls.length, 2);
    assert.equal(fixture.getTypingCount(), 2);

    const pending = new DiscordInboundState(stateDir).pendingObligations();
    assert.equal(pending.length, 2);
    assert.equal(
      pending.every((o) => o.eyesReacted && !o.replied),
      true,
    );
  });

  it("caps burst coalescing at maxDebounceMs during a continuous stream of messages", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const ownerId = "100000000000000001";
    const channelId = "300000000000000003";
    updateConfig({ discord: { ownerId, channelIds: [channelId], followThreads: false } }, home);

    const fixture = createGatewayFixture({ ownerId, channelId });
    fixture.setOnIdentify(() => {
      fixture.emitOwnerMessage(2, "900000000000000020", "part 1");
      setTimeout(() => fixture.emitOwnerMessage(3, "900000000000000021", "part 2"), 45);
      setTimeout(() => fixture.emitOwnerMessage(4, "900000000000000022", "part 3"), 90);
    });

    const startedAt = Date.now();
    const result = await waitForDiscordGateway({
      botToken: "tok",
      client: fixture.client,
      stateDir,
      catalyHome: home,
      timeoutMs: 3000,
      debounceMs: 120,
      maxDebounceMs: 160,
      autoAck: true,
      wsFactory: fixture.wsFactory,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.kind, "messages");
    if (result.kind === "messages") {
      assert.equal(result.messages.length, 3);
      assert.deepEqual(
        result.messages.map((m) => m.messageId),
        ["900000000000000020", "900000000000000021", "900000000000000022"],
      );
    }
    assert.ok(elapsedMs < 500, `expected flush capped near maxDebounceMs, took ${elapsedMs}ms`);
  });

  it("flushes session-routed slash commands immediately without waiting for debounceMs", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const ownerId = "100000000000000001";
    const channelId = "300000000000000003";
    updateConfig({ discord: { ownerId, channelIds: [channelId], followThreads: false } }, home);

    const fixture = createGatewayFixture({ ownerId, channelId });
    fixture.setOnIdentify(() => {
      fixture.emitOwnerMessage(2, "900000000000000030", "/usage");
    });

    const startedAt = Date.now();
    const result = await waitForDiscordGateway({
      botToken: "tok",
      client: fixture.client,
      stateDir,
      catalyHome: home,
      timeoutMs: 8000,
      debounceMs: 5000,
      maxDebounceMs: 6000,
      autoAck: true,
      handleLocalCommands: true,
      wsFactory: fixture.wsFactory,
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.kind, "messages");
    if (result.kind === "messages") {
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0]?.parsedCommand?.name, "usage");
      assert.equal(result.messages[0]?.autoAcked, true);
    }
    assert.ok(elapsedMs < 1000, `expected immediate flush for /usage, took ${elapsedMs}ms`);
  });

  it("flushes buffered pending messages instead of timing out when timeoutMs expires mid-debounce", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const ownerId = "100000000000000001";
    const channelId = "300000000000000003";
    updateConfig({ discord: { ownerId, channelIds: [channelId], followThreads: false } }, home);

    const fixture = createGatewayFixture({ ownerId, channelId });
    fixture.setOnIdentify(() => {
      setTimeout(() => {
        fixture.emitOwnerMessage(2, "900000000000000040", "buffered before timeout");
      }, 20);
    });

    const result = await waitForDiscordGateway({
      botToken: "tok",
      client: fixture.client,
      stateDir,
      catalyHome: home,
      timeoutMs: 120,
      debounceMs: 5000,
      maxDebounceMs: 6000,
      autoAck: true,
      wsFactory: fixture.wsFactory,
    });

    assert.equal(result.kind, "messages");
    if (result.kind === "messages") {
      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0]?.messageId, "900000000000000040");
      assert.equal(result.messages[0]?.content, "buffered before timeout");
    }
  });

  it("loses zero messages when delayed arrivals race debounce flush and a third arrives mid-flush across consecutive waits", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const ownerId = "100000000000000001";
    const channelId = "300000000000000003";
    updateConfig({ discord: { ownerId, channelIds: [channelId], followThreads: false } }, home);

    // Track all messages that exist on the server for REST backfill
    const serverMessages: {
      id: string;
      channel_id: string;
      content: string;
      timestamp: string;
      author: { id: string; username: string };
    }[] = [
      {
        id: "900000000000000001",
        channel_id: channelId,
        content: "seed",
        timestamp: "2026-01-01T00:00:00Z",
        author: { id: ownerId, username: "owner" },
      },
    ];

    const fakeHttp: DiscordHttpClient = async (req) => {
      if (req.url.endsWith("/gateway/bot")) {
        return { status: 200, body: JSON.stringify({ url: "wss://fake.gw" }) };
      }
      if (req.method === "GET" && req.url.includes(`/channels/${channelId}/messages`)) {
        const after = new URL(req.url).searchParams.get("after");
        const filtered = after ? serverMessages.filter((m) => BigInt(m.id) > BigInt(after)) : serverMessages;
        return { status: 200, body: JSON.stringify(filtered) };
      }
      if (req.method === "GET" && req.url.endsWith(`/channels/${channelId}`)) {
        return { status: 200, body: JSON.stringify({ id: channelId, type: 0, name: "cataly" }) };
      }
      if (req.method === "PUT" && req.url.includes("/reactions/")) {
        if (req.url.includes("900000000000000051")) {
          await new Promise((r) => setTimeout(r, 45));
        }
        return { status: 204, body: "" };
      }
      if (req.method === "POST" && req.url.endsWith(`/channels/${channelId}/typing`)) {
        return { status: 204, body: "" };
      }
      return { status: 404, body: "" };
    };

    const client = new DiscordClient("tok", { http: fakeHttp });
    const listeners = new Map<string, ((ev: unknown) => void)[]>();
    const emit = (type: string, ev: unknown) => {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    };
    const pushAndEmit = (seq: number, id: string, content: string) => {
      const msg = {
        id,
        channel_id: channelId,
        content,
        timestamp: "2026-01-01T00:01:00Z",
        author: { id: ownerId, username: "owner" },
      };
      serverMessages.push(msg);
      emit("message", { data: JSON.stringify({ op: 0, t: "MESSAGE_CREATE", s: seq, d: msg }) });
    };

    const fakeWs: MinimalWebSocket = {
      readyState: 1,
      send(data: string) {
        const parsed = JSON.parse(data) as { op?: number };
        if (parsed.op === 2) {
          queueMicrotask(() => {
            emit("message", { data: JSON.stringify({ op: 0, t: "READY", s: 1, d: {} }) });
            // Message 1 starts a 60ms debounce window
            pushAndEmit(2, "900000000000000050", "msg 1");
            // Message 2 arrives 40ms later with a 45ms delayed react (still in-flight when debounce fires at ~60ms)
            setTimeout(() => pushAndEmit(3, "900000000000000051", "msg 2"), 40);
            // Message 3 arrives at 75ms while flushPending is already flushing -> must NOT be dropped or advance cursor
            setTimeout(() => pushAndEmit(4, "900000000000000052", "msg 3"), 75);
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

    const first = await waitForDiscordGateway({
      botToken: "tok",
      client,
      stateDir,
      catalyHome: home,
      timeoutMs: 3000,
      debounceMs: 60,
      maxDebounceMs: 300,
      autoAck: true,
      wsFactory: () => {
        queueMicrotask(() => emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) }));
        return fakeWs;
      },
    });

    assert.equal(first.kind, "messages");
    const delivered: string[] = [];
    if (first.kind === "messages") {
      delivered.push(...first.messages.map((m) => m.messageId));
      assert.deepEqual(delivered, ["900000000000000050", "900000000000000051"]);
    }

    // Wait briefly so Message 3 has definitely been pushed onto serverMessages, then run next waitForDiscordGateway
    await new Promise((r) => setTimeout(r, 30));
    const second = await waitForDiscordGateway({
      botToken: "tok",
      client,
      stateDir,
      catalyHome: home,
      timeoutMs: 1000,
      autoAck: true,
      wsFactory: () => fakeWs,
    });

    assert.equal(second.kind, "messages");
    if (second.kind === "messages") {
      delivered.push(...second.messages.map((m) => m.messageId));
    }
    assert.deepEqual(delivered, ["900000000000000050", "900000000000000051", "900000000000000052"]);
  });

  it("flushes buffered/in-flight messages on websocket close instead of losing them and guards failed local command sends", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const ownerId = "100000000000000001";
    const channelId = "300000000000000003";
    updateConfig({ discord: { ownerId, channelIds: [channelId], followThreads: false } }, home);

    const fakeHttp: DiscordHttpClient = async (req) => {
      if (req.url.endsWith("/gateway/bot")) return { status: 200, body: JSON.stringify({ url: "wss://fake.gw" }) };
      if (req.method === "GET" && req.url.includes(`/channels/${channelId}/messages`)) {
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
      if (req.method === "GET" && req.url.endsWith(`/channels/${channelId}`)) {
        return { status: 200, body: JSON.stringify({ id: channelId, type: 0, name: "cataly" }) };
      }
      if (req.method === "POST" && req.url.endsWith(`/channels/${channelId}/messages`)) {
        return { status: 400, body: "simulated send failure" };
      }
      if (req.method === "PUT" && req.url.includes("/reactions/")) return { status: 204, body: "" };
      if (req.method === "POST" && req.url.endsWith(`/channels/${channelId}/typing`)) return { status: 204, body: "" };
      return { status: 404, body: "" };
    };

    const client = new DiscordClient("tok", { http: fakeHttp });
    const listeners = new Map<string, ((ev: unknown) => void)[]>();
    const emit = (type: string, ev: unknown) => {
      for (const fn of listeners.get(type) ?? []) fn(ev);
    };
    const fakeWs: MinimalWebSocket = {
      readyState: 1,
      send(data: string) {
        const parsed = JSON.parse(data) as { op?: number };
        if (parsed.op === 2) {
          queueMicrotask(() => {
            emit("message", { data: JSON.stringify({ op: 0, t: "READY", s: 1, d: {} }) });
            // Failed local command must NOT advance cursor or mark replied
            emit("message", {
              data: JSON.stringify({
                op: 0,
                t: "MESSAGE_CREATE",
                s: 2,
                d: {
                  id: "900000000000000060",
                  channel_id: channelId,
                  content: "/status",
                  timestamp: "2026-01-01T00:01:00Z",
                  author: { id: ownerId, username: "owner" },
                },
              }),
            });
            // Normal message followed immediately by fatal close 4004 -> must flush message instead of failing
            setTimeout(() => {
              emit("message", {
                data: JSON.stringify({
                  op: 0,
                  t: "MESSAGE_CREATE",
                  s: 3,
                  d: {
                    id: "900000000000000061",
                    channel_id: channelId,
                    content: "survives close",
                    timestamp: "2026-01-01T00:01:05Z",
                    author: { id: ownerId, username: "owner" },
                  },
                }),
              });
              emit("close", { code: 4004 });
            }, 40);
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

    const statuses: string[] = [];
    const res = await waitForDiscordGateway({
      botToken: "tok",
      client,
      stateDir,
      catalyHome: home,
      timeoutMs: 3000,
      debounceMs: 5000,
      autoAck: true,
      handleLocalCommands: true,
      wsFactory: () => {
        queueMicrotask(() => emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) }));
        return fakeWs;
      },
      onStatus: (s) => statuses.push(s),
    });

    assert.ok(statuses.some((s) => s.startsWith("LOCAL_COMMAND_SEND_FAILED /status")));
    assert.equal(res.kind, "messages");
    if (res.kind === "messages") {
      assert.equal(res.messages.length, 1);
      assert.equal(res.messages[0]?.messageId, "900000000000000061");
      assert.equal(res.messages[0]?.content, "survives close");
    }
    const inboundState = new DiscordInboundState(stateDir);
    assert.equal(
      inboundState.readObligations().some((o) => o.messageId === "900000000000000060" && o.replied),
      false,
    );
  });
});
