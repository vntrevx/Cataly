import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SharedBoard } from "../core/board.js";
import { collectBootSummary, formatBootMarkdown } from "../core/boot.js";
import { resolveStateDir, updateConfig } from "../core/config.js";
import { LaneRegistry } from "../core/lanes.js";
import { clearChannelCache } from "../discord/channels.js";
import { DiscordClient, type DiscordHttpClient } from "../discord/client.js";
import { parseDiscordCommand, runLocalDiscordCommand } from "../discord/commands.js";
import { type MinimalWebSocket, waitForDiscordGateway } from "../discord/gateway.js";
import { clearThreadCache } from "../discord/inbound.js";

const tempDirs: string[] = [];
function makeTempDir(prefix = "cataly-bc-"): string {
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

describe("SharedBoard", () => {
  it("appends numbered informational posts, filters by topic/lane/since, and renders board.md", () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const board = new SharedBoard(stateDir);

    const p1 = board.post({ author: "lead", topic: "arch", text: "Using Gateway v10 WebSocket" });
    const p2 = board.post({ author: "lane-a", lane: "fix-auth", topic: "auth", text: "Found token expiry edge case" });
    assert.equal(p1.seq, 1);
    assert.equal(p2.seq, 2);
    assert.equal(existsSync(board.markdownPath), true);
    assert.match(readFileSync(board.markdownPath, "utf8"), /Shared Board/);

    assert.equal(board.read({ since: 1 }).posts.length, 1);
    assert.equal(board.read({ topic: "auth" }).posts[0]?.seq, 2);
    assert.equal(board.read({ lane: "fix-auth" }).posts[0]?.author, "lane-a");

    const boot = collectBootSummary(home);
    assert.equal(boot.boardHead, 2);
    assert.match(formatBootMarkdown(boot), /Shared Board: 2 post/);
  });
});

describe("Discord shortcut commands (zero-token local + session-routed)", () => {
  it("parses slash/bang commands and executes /help, /status, /board, /stop, /resume locally", () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const lanes = new LaneRegistry(stateDir, home);
    lanes.create({ key: "work-1", title: "Demo lane", cwd: home, done: "file ok.txt", briefBody: "work" });

    assert.equal(parseDiscordCommand("hello world"), null);
    assert.equal(parseDiscordCommand("/unknown"), null);

    const usageCmd = parseDiscordCommand("/usage");
    assert.equal(usageCmd?.name, "usage");
    assert.equal(usageCmd?.localZeroToken, false);

    const modelCmd = parseDiscordCommand("!model pro high");
    assert.equal(modelCmd?.name, "model");
    assert.equal(modelCmd?.args, "pro high");
    assert.equal(modelCmd?.localZeroToken, false);

    const helpRes = runLocalDiscordCommand(parseDiscordCommand("/help")!, stateDir, home);
    assert.equal(helpRes.handled, true);
    assert.match(helpRes.reply ?? "", /\/status/);

    const postRes = runLocalDiscordCommand(parseDiscordCommand("/board Run pre-release verification")!, stateDir, home);
    assert.equal(postRes.handled, true);
    assert.match(postRes.reply ?? "", /#1/);

    const statusRes = runLocalDiscordCommand(parseDiscordCommand("/status")!, stateDir, home);
    assert.equal(statusRes.handled, true);
    assert.match(statusRes.reply ?? "", /Status Summary/);
    assert.match(statusRes.reply ?? "", /work-1/);
    assert.match(statusRes.reply ?? "", /Run pre-release verification/);

    const stopRes = runLocalDiscordCommand(parseDiscordCommand("/stop")!, stateDir, home);
    assert.equal(stopRes.handled, true);
    assert.equal(lanes.require("work-1").status, "paused");

    const resumeRes = runLocalDiscordCommand(parseDiscordCommand("/resume work-1")!, stateDir, home);
    assert.equal(resumeRes.handled, true);
    assert.equal(lanes.require("work-1").status, "working");
  });

  it("handles /status locally inside Gateway without exiting, then wakes session on /usage", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const ownerId = "100000000000000001";
    const channelId = "300000000000000003";

    updateConfig({ discord: { ownerId, channelIds: [channelId], followThreads: false } }, home);

    const sentReplies: string[] = [];
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
      if (req.url.endsWith(`/channels/${channelId}`) && req.method === "GET") {
        return { status: 200, body: JSON.stringify({ id: channelId, type: 0, name: "cataly" }) };
      }
      if (req.method === "POST" && req.url.endsWith(`/channels/${channelId}/messages`)) {
        const body = JSON.parse(req.body ?? "{}") as { content?: string };
        if (body.content) sentReplies.push(body.content);
        return { status: 200, body: JSON.stringify({ id: "999999999999999999" }) };
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
            // 1) Local zero-token command: /status -> replied locally, Gateway stays open
            emit("message", {
              data: JSON.stringify({
                op: 0,
                t: "MESSAGE_CREATE",
                s: 2,
                d: {
                  id: "900000000000000002",
                  channel_id: channelId,
                  content: "/status",
                  timestamp: "2026-01-01T00:01:00Z",
                  author: { id: ownerId, username: "owner" },
                },
              }),
            });
            // 2) Session-routed command: /usage -> wakes session with parsedCommand
            setTimeout(() => {
              emit("message", {
                data: JSON.stringify({
                  op: 0,
                  t: "MESSAGE_CREATE",
                  s: 3,
                  d: {
                    id: "900000000000000003",
                    channel_id: channelId,
                    content: "/usage",
                    timestamp: "2026-01-01T00:02:00Z",
                    author: { id: ownerId, username: "owner" },
                  },
                }),
              });
            }, 30);
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
      timeoutMs: 5000,
      autoAck: true,
      handleLocalCommands: true,
      wsFactory: () => {
        queueMicrotask(() => emit("message", { data: JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }) }));
        return fakeWs;
      },
      onStatus: (s) => statuses.push(s),
    });

    assert.ok(statuses.includes("LOCAL_COMMAND_HANDLED /status"));
    assert.equal(sentReplies.length, 1);
    assert.match(sentReplies[0] ?? "", /Status Summary/);
    assert.equal(res.kind, "messages");
    if (res.kind === "messages") {
      assert.equal(res.messages.length, 1);
      assert.equal(res.messages[0]?.parsedCommand?.name, "usage");
    }
  });
});
