import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { collectBootSummary, formatBootMarkdown } from "../core/boot.js";
import { resolveStateDir, updateConfig } from "../core/config.js";
import { Decisions } from "../core/decisions.js";
import { checkGitCleanAndPushed, LaneRegistry } from "../core/lanes.js";
import { clearChannelCache, DiscordChannels, resolveInboundContext } from "../discord/channels.js";
import { DiscordClient, type DiscordHttpClient } from "../discord/client.js";
import { clearThreadCache, DiscordInboundState, pollDiscordInbound } from "../discord/inbound.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "..");

const tempDirs: string[] = [];
function makeTempDir(prefix = "cataly-opt-"): string {
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

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(distDir, "cli.js"), ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code: code ?? 1, out, err }));
  });
}

describe("single-call git clean/pushed check", () => {
  it("parses porcelain=v2 branch + dirty tracked files in one git invocation", async () => {
    const dir = makeTempDir();
    let calls = 0;

    const clean = await checkGitCleanAndPushed(dir, async (argv) => {
      calls++;
      assert.deepEqual(argv, ["git", "status", "--porcelain=v2", "--branch", "--untracked-files=no"]);
      return {
        code: 0,
        out: "# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +0 -0\n",
        err: "",
      };
    });
    assert.deepEqual(clean, []);
    assert.equal(calls, 1);

    const dirtyAndAhead = await checkGitCleanAndPushed(dir, async () => ({
      code: 0,
      out: "# branch.head main\n# branch.ab +2 -0\n1 .M N... 100644 100644 100644 aaa bbb src/app.ts\n",
      err: "",
    }));
    assert.equal(dirtyAndAhead.length, 2);
    assert.match(dirtyAndAhead[0] ?? "", /uncommitted tracked changes/);
    assert.match(dirtyAndAhead[1] ?? "", /2 unpushed commit/);

    const nonGit = await checkGitCleanAndPushed(dir, async () => ({ code: 128, out: "", err: "not a git repo" }));
    assert.deepEqual(nonGit, []);
  });
});

describe("Discord caching, decision auto-match, and boot obligations", () => {
  it("caches channel lookups, caches active guild threads, auto-matches decisions, and surfaces obligations in boot", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const ownerId = "100000000000000001";
    const channelId = "300000000000000003";
    const guildId = "500000000000000005";
    const questionMsgId = "888888888888888888";

    updateConfig({ discord: { ownerId, channelIds: [channelId], guildId, followThreads: true } }, home);

    const decisions = new Decisions(stateDir);
    const dec = decisions.ask({
      question: "Ship optimization?",
      source: "discord",
      options: ["Yes", "Later"],
      recommend: 1,
      message: questionMsgId,
    });

    let channelCalls = 0;
    let threadListCalls = 0;
    let pollRound = 0;

    const fakeHttp: DiscordHttpClient = async (req) => {
      if (req.url.endsWith(`/guilds/${guildId}/threads/active`)) {
        threadListCalls++;
        return { status: 200, body: JSON.stringify({ threads: [] }) };
      }
      if (req.url.endsWith(`/channels/${channelId}`)) {
        channelCalls++;
        return { status: 200, body: JSON.stringify({ id: channelId, type: 0, name: "eng" }) };
      }
      if (req.url.includes(`/channels/${channelId}/messages`)) {
        const msgs =
          pollRound === 0
            ? [
                {
                  id: "900000000000000001",
                  channel_id: channelId,
                  content: "seed",
                  timestamp: "2026-01-01T00:00:00Z",
                  author: { id: ownerId, username: "owner" },
                },
              ]
            : [
                {
                  id: "900000000000000002",
                  channel_id: channelId,
                  content: "1",
                  timestamp: "2026-01-01T00:01:00Z",
                  author: { id: ownerId, username: "owner" },
                  message_reference: { message_id: questionMsgId },
                },
              ];
        return { status: 200, body: JSON.stringify(msgs) };
      }
      return { status: 404, body: "" };
    };

    const client = new DiscordClient("tok", { http: fakeHttp });
    const channels = new DiscordChannels(stateDir);

    // Channel metadata cache: 2 calls -> 1 HTTP request
    await resolveInboundContext(client, channels, channelId);
    await resolveInboundContext(client, channels, channelId);
    assert.equal(channelCalls, 1);

    // Consecutive polls reuse activeGuildThreads cache (1 HTTP call across 2 polls)
    await pollDiscordInbound(client, stateDir, { includeContext: true, catalyHome: home, threadCacheTtlMs: 30_000 });
    pollRound = 1;
    const second = await pollDiscordInbound(client, stateDir, {
      includeContext: true,
      catalyHome: home,
      threadCacheTtlMs: 30_000,
    });
    assert.equal(threadListCalls, 1);
    assert.equal(second.messages.length, 1);
    assert.equal(second.messages[0]?.matchedDecisionId, dec.id);

    // Boot summary includes pending Discord obligation
    const summary = collectBootSummary(home);
    assert.equal(summary.pendingDiscordObligations.length, 1);
    assert.match(formatBootMarkdown(summary), /Pending Discord Obligations/);
    assert.equal(new DiscordInboundState(stateDir).pendingObligations().length, 1);
  });
});

describe("CLI worker fallback subcommands", () => {
  it("supports report, checkpoint, and claim-done via cli.js", async () => {
    const home = makeTempDir();
    const stateDir = resolveStateDir(home);
    const lanes = new LaneRegistry(stateDir, home);
    lanes.create({
      key: "cli-lane",
      title: "CLI test lane",
      cwd: home,
      done: "file done.txt",
      briefBody: "test",
    });

    const rep = await runCli(["report", "cli-lane", "milestone", "step", "1", "ok"], { CATALY_HOME: home });
    assert.equal(rep.code, 0, rep.err);
    assert.match(rep.out, /\[REPORT\] cli-lane \| milestone \| step 1 ok/);

    const cp = await runCli(
      [
        "checkpoint",
        "cli-lane",
        "--step",
        "build",
        "--result",
        "passed",
        "--evidence",
        "tsc ok",
        "--effect",
        "build:1",
      ],
      { CATALY_HOME: home },
    );
    assert.equal(cp.code, 0, cp.err);

    const claim = await runCli(["claim-done", "cli-lane", "--evidence", "all checks green"], { CATALY_HOME: home });
    assert.equal(claim.code, 0, claim.err);
    assert.equal(lanes.require("cli-lane").status, "done-claimed");
  });
});
