#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Backlog } from "./core/backlog.js";
import { SharedBoard } from "./core/board.js";
import { collectBootSummary, formatBootMarkdown } from "./core/boot.js";
import { Checkpoints } from "./core/checkpoints.js";
import { loadConfig, loadDiscordBotToken, resolveCatalyHome, resolveStateDir, updateConfig } from "./core/config.js";
import { Decisions } from "./core/decisions.js";
import { LaneRegistry } from "./core/lanes.js";
import { Lessons } from "./core/lessons.js";
import { SharedLocks } from "./core/locks.js";
import { PrTracker, verifyPrLive } from "./core/pr.js";
import { formatReportLine, Reports } from "./core/reports.js";
import { checkDone } from "./core/signals.js";
import { Worklog } from "./core/worklog.js";
import { detectImageExtension, downloadDiscordAttachment } from "./discord/attachments.js";
import { DiscordChannels } from "./discord/channels.js";
import { DiscordClient } from "./discord/client.js";
import { DiscordInboundState, pollDiscordInbound } from "./discord/inbound.js";

const catalyHome = resolveCatalyHome();
const stateDir = resolveStateDir(catalyHome);

const worklog = new Worklog(stateDir);
const decisions = new Decisions(stateDir);
const lessons = new Lessons(stateDir);
const checkpoints = new Checkpoints(stateDir);
const reports = new Reports(stateDir);
const lanes = new LaneRegistry(stateDir, catalyHome);
const backlog = new Backlog(stateDir);
const locks = new SharedLocks(stateDir);
const prTracker = new PrTracker(stateDir);
const board = new SharedBoard(stateDir);
const discordChannels = new DiscordChannels(stateDir);
const discordInboundState = new DiscordInboundState(stateDir);

function okJson(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function okText(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function errText(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: `Error: ${msg}` }],
  };
}

function requireDiscordClient(): DiscordClient {
  const token = loadDiscordBotToken(catalyHome);
  if (!token) {
    throw new Error(
      `Discord bot token not found. Save the token to ~/.cataly/secrets/discord.token (or set CATALY_DISCORD_TOKEN / config.discord.tokenFile).`,
    );
  }
  const cfg = loadConfig(catalyHome).discord;
  return new DiscordClient(token, { apiBase: cfg.apiBase });
}

const server = new McpServer({
  name: "cataly-core",
  version: "1.0.0",
});

// ============================================================================
// 1. BOOT, CONFIG & MEMORY
// ============================================================================

server.tool(
  "cataly_boot",
  "Read-only recovery summary after restart or compaction: open worklog items, pending owner decisions, active/claimed lanes, backlog counts, tracked PRs, active locks, and onboarding/Discord status.",
  {},
  async () => {
    try {
      const summary = collectBootSummary(catalyHome);
      return okJson({
        markdown: formatBootMarkdown(summary),
        summary,
      });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool("cataly_config_get", "Read Cataly configuration (never exposes bot tokens or secrets).", {}, async () => {
  try {
    const cfg = loadConfig(catalyHome);
    return okJson({
      catalyHome,
      config: cfg,
      discordTokenPresent: Boolean(loadDiscordBotToken(catalyHome)),
    });
  } catch (e) {
    return errText(e);
  }
});

server.tool(
  "cataly_config_set",
  "Update Cataly settings (agentName, ownerName, doneGraceMinutes, staleMinutes, maxLanes, repoIdentities, discord settings, or onboarding memory).",
  {
    agentName: z.string().min(1).max(64).optional(),
    ownerName: z.string().min(1).max(64).optional(),
    doneGraceMinutes: z.number().int().min(0).max(120).optional(),
    staleMinutes: z.number().int().min(1).max(240).optional(),
    maxLanes: z.number().int().min(1).max(20).optional(),
    repoIdentity: z
      .object({
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
        name: z.string().min(1),
        email: z.string().email(),
      })
      .optional(),
    discord: z
      .object({
        ownerId: z.string().optional(),
        tokenFile: z.string().optional(),
        channelIds: z.array(z.string()).optional(),
        guildId: z.string().optional(),
        followThreads: z.boolean().optional(),
      })
      .optional(),
    onboarding: z
      .object({
        status: z.enum(["not_started", "completed", "declined"]).optional(),
        allowedTools: z.array(z.string()).optional(),
        declinedTools: z.array(z.string()).optional(),
        work: z.string().optional(),
        persona: z.string().optional(),
        company: z.string().optional(),
        notes: z.string().optional(),
      })
      .optional(),
  },
  async (args) => {
    try {
      const updated = updateConfig(
        {
          agentName: args.agentName,
          ownerName: args.ownerName,
          doneGraceMinutes: args.doneGraceMinutes,
          staleMinutes: args.staleMinutes,
          maxLanes: args.maxLanes,
          ...(args.repoIdentity
            ? {
                repoIdentities: {
                  [args.repoIdentity.repo]: {
                    name: args.repoIdentity.name,
                    email: args.repoIdentity.email,
                  },
                },
              }
            : {}),
          ...(args.discord ? { discord: args.discord } : {}),
          ...(args.onboarding ? { onboarding: args.onboarding } : {}),
        },
        catalyHome,
      );
      return okJson({ config: updated });
    } catch (e) {
      return errText(e);
    }
  },
);

// ============================================================================
// 2. LANES & VERIFIABLE DONE PROTOCOL
// ============================================================================

server.tool(
  "cataly_done_check",
  'Live-verify a Cataly "Done =" signal line (semicolon-separated: merged, closed, published, command, file, url). Never trusts claims; executes checks live.',
  {
    done: z.string().min(1).describe('e.g. command ["npm","test"] stdout~"0 fail"; file dist/index.js'),
    cwd: z.string().optional().describe("Working directory for relative file paths and commands"),
  },
  async ({ done, cwd }) => {
    try {
      const checks = await checkDone(done, undefined, { cwd });
      return okJson({
        ok: checks.every((c) => c.ok),
        checks,
      });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lane_create",
  "Create a tracked work lane with a verifiable Done = contract, inject active global+repo lessons, write its brief file, and return the rendered brief to hand to a cataly-lane subagent.",
  {
    key: z.string().min(1).max(64).describe("Lowercase kebab-case lane key (e.g. fix-login)"),
    title: z.string().min(1).max(200),
    cwd: z.string().min(1).describe("Absolute path to the workspace or worktree"),
    done: z.string().min(1).describe('Verifiable Done = signals joined by ";"'),
    briefBody: z.string().min(1).describe("Goal, context, ideal end state, and constraints"),
    priority: z.number().int().min(1).max(9).optional(),
    thread: z.string().optional().describe('Thread link such as "discord:<channelId>" or "none"'),
    worklogId: z.string().optional(),
    worktreePath: z.string().optional(),
  },
  async (args) => {
    try {
      const result = lanes.create(args);
      return okJson(result);
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lane_attach",
  "Bind an Antigravity subagent conversationId to an existing lane so messages and hooks stay linked.",
  {
    key: z.string().min(1),
    conversationId: z.string().min(1),
    agentRole: z.string().optional(),
  },
  async ({ key, conversationId, agentRole }) => {
    try {
      return okJson(lanes.attach(key, conversationId, agentRole));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lane_list",
  "List tracked Cataly lanes (active by default, or all including closed).",
  {
    includeClosed: z.boolean().optional(),
  },
  async ({ includeClosed }) => {
    try {
      return okJson({ lanes: lanes.list(Boolean(includeClosed)) });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lane_get",
  "Get full state, recent reports, and checkpoints for a single lane.",
  {
    key: z.string().min(1),
  },
  async ({ key }) => {
    try {
      const lane = lanes.require(key);
      const laneReports = reports.list(key, 20);
      const laneCheckpoints = checkpoints.read(key);
      return okJson({ lane, reports: laneReports, checkpoints: laneCheckpoints });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lane_claim_done",
  "Claim a lane is done with concrete live evidence. Starts the review grace window; never auto-trusts without live verification.",
  {
    key: z.string().min(1),
    evidence: z.string().min(1),
    graceMinutes: z.number().int().min(0).max(60).optional(),
    expectedVersion: z.number().int().optional(),
  },
  async ({ key, evidence, graceMinutes, expectedVersion }) => {
    try {
      const updated = lanes.claimDone(key, evidence, graceMinutes, expectedVersion);
      reports.report(key, "done", `Claimed done: ${evidence}`);
      return okJson(updated);
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lane_object_done",
  "Reject a lane's done claim and return it to not-done with concrete reasons.",
  {
    key: z.string().min(1),
    reason: z.string().min(1),
    expectedVersion: z.number().int().optional(),
  },
  async ({ key, reason, expectedVersion }) => {
    try {
      const updated = lanes.objectDone(key, reason, expectedVersion);
      return okJson(updated);
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lane_verify_close",
  "Live-verify every Done = signal and git clean/pushed status for a lane. Closes it only if all checks pass (or returns it to not-done with exact reasons).",
  {
    key: z.string().min(1),
    skipGitCheck: z.boolean().optional(),
    forceClose: z.boolean().optional(),
    expectedVersion: z.number().int().min(1).optional(),
  },
  async ({ key, skipGitCheck, forceClose, expectedVersion }) => {
    try {
      const res = await lanes.verifyAndClose(key, { skipGitCheck, forceClose, expectedVersion });
      return okJson(res);
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lane_pause",
  "Pause a working lane immediately (e.g. when the owner says wait/stop/hold on).",
  {
    key: z.string().min(1),
    reason: z.string().optional(),
    expectedVersion: z.number().int().optional(),
  },
  async ({ key, reason, expectedVersion }) => {
    try {
      return okJson(lanes.pause(key, reason, expectedVersion));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lane_resume",
  "Resume a paused lane when the owner gives the go-ahead.",
  {
    key: z.string().min(1),
    note: z.string().optional(),
    expectedVersion: z.number().int().optional(),
  },
  async ({ key, note, expectedVersion }) => {
    try {
      return okJson(lanes.resume(key, note, expectedVersion));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lane_sweep",
  "Run a watch + freshness sweep: auto-verify/close done-claimed lanes past their grace window and flag stale silent lanes.",
  {
    skipGitCheck: z.boolean().optional(),
  },
  async ({ skipGitCheck }) => {
    try {
      return okJson(await lanes.sweep({ skipGitCheck }));
    } catch (e) {
      return errText(e);
    }
  },
);

// ============================================================================
// 3. WORKLOG
// ============================================================================

server.tool(
  "cataly_worklog_add",
  "Record a new owner request in the persistent worklog immediately upon arrival.",
  {
    title: z.string().min(1).max(200),
    source: z.string().min(1).max(400).describe('e.g. "antigravity" or "discord:<channel>/<msgId>"'),
  },
  async ({ title, source }) => {
    try {
      return okJson(worklog.add(title, source));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_worklog_next",
  "Update the immediate Next step of an open worklog item (survives compaction).",
  {
    id: z.string().length(8),
    text: z.string().min(1).max(1000),
  },
  async ({ id, text }) => {
    try {
      return okJson(worklog.next(id, text));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_worklog_note",
  "Append a factual note to an open worklog item.",
  {
    id: z.string().length(8),
    text: z.string().min(1).max(1000),
  },
  async ({ id, text }) => {
    try {
      return okJson(worklog.note(id, text));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_worklog_close",
  "Close a worklog item with the verified final result.",
  {
    id: z.string().length(8),
    result: z.string().min(1).max(1000),
  },
  async ({ id, result }) => {
    try {
      return okJson(worklog.close(id, result));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_worklog_list",
  "List worklog items (open only by default).",
  {
    includeClosed: z.boolean().optional(),
  },
  async ({ includeClosed }) => {
    try {
      const read = worklog.read();
      const items = includeClosed ? read.items : read.items.filter((i) => i.closedAt === undefined);
      return okJson({ items, problems: read.problems, warnings: read.warnings });
    } catch (e) {
      return errText(e);
    }
  },
);

// ============================================================================
// 4. DECISIONS
// ============================================================================

server.tool(
  "cataly_decision_ask",
  "Record a product/architecture choice put to the owner with numbered options and a recommendation.",
  {
    question: z.string().min(1).max(1000),
    source: z.string().min(1).max(400),
    options: z.array(z.string().min(1).max(200)).min(1).max(9).optional(),
    recommend: z.number().int().min(1).max(9).optional(),
    lane: z.string().optional(),
    thread: z.string().optional(),
    worklog: z.string().length(8).optional(),
    message: z.string().optional(),
  },
  async (args) => {
    try {
      return okJson(decisions.ask(args));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_decision_posted",
  "Bind an open decision to the posted Discord/messenger message ID so replies can be matched unambiguously.",
  {
    id: z.string().length(8),
    message: z.string().min(1).max(400),
  },
  async ({ id, message }) => {
    try {
      return okJson(decisions.posted(id, message));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_decision_match",
  "Match a replied-to message ID against open owner decisions.",
  {
    messageRef: z.string().min(1),
  },
  async ({ messageRef }) => {
    try {
      return okJson({ match: decisions.match(messageRef) });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_decision_answer",
  "Record the owner's explicit answer to an open decision (silence is never an answer).",
  {
    id: z.string().length(8),
    answer: z.string().min(1).max(1000),
    source: z.string().min(1).max(400),
    option: z.number().int().min(1).max(9).optional(),
  },
  async ({ id, answer, source, option }) => {
    try {
      return okJson(decisions.answer(id, answer, source, option));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_decision_withdraw",
  "Withdraw an open decision that is no longer needed.",
  {
    id: z.string().length(8),
    reason: z.string().min(1).max(1000),
  },
  async ({ id, reason }) => {
    try {
      return okJson(decisions.withdraw(id, reason));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_decision_list",
  "List decisions (open by default) along with a ready-to-paste digest.",
  {
    includeSettled: z.boolean().optional(),
  },
  async ({ includeSettled }) => {
    try {
      const read = decisions.read();
      const items = includeSettled
        ? read.items
        : read.items.filter((d) => d.answeredAt === undefined && d.withdrawnAt === undefined);
      return okJson({ items, digest: decisions.digest(), problems: read.problems });
    } catch (e) {
      return errText(e);
    }
  },
);

// ============================================================================
// 5. LESSONS, CHECKPOINTS & REPORTS
// ============================================================================

server.tool(
  "cataly_lesson_add",
  "Record a reusable lesson for a repository (cwd) or globally for every lane (scope='global'). Automatically injected into future lane briefs.",
  {
    lane: z.string().min(1),
    rule: z.string().min(1).max(400),
    evidence: z.string().min(1).max(2000),
    cwd: z.string().optional(),
    global: z.boolean().optional(),
  },
  async ({ lane, rule, evidence, cwd, global: isGlobal }) => {
    try {
      if (isGlobal) {
        return okJson(lessons.add({ lane, rule, evidence, scope: "global" }));
      }
      if (!cwd) throw new Error("Either global=true or cwd must be provided");
      return okJson(lessons.add({ lane, rule, evidence, cwd }));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lesson_mark",
  "Update a lesson's outcome (pending, helped, no-effect, harmful, encoded).",
  {
    id: z.string().min(1),
    outcome: z.enum(["pending", "helped", "no-effect", "harmful", "encoded"]),
  },
  async ({ id, outcome }) => {
    try {
      return okJson(lessons.mark(id, outcome));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lesson_list",
  "List active lessons (optionally scoped to a repository cwd).",
  {
    cwd: z.string().optional(),
  },
  async ({ cwd }) => {
    try {
      return okJson(cwd ? lessons.forRepo(cwd) : lessons.read());
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_checkpoint_write",
  "Record a completed lane step and its remote side-effect receipts idempotently so restarts never replay remote effects.",
  {
    key: z.string().min(1),
    step: z.string().min(1),
    result: z.string().min(1),
    evidence: z.array(z.string()),
    remoteEffects: z.array(z.string()),
  },
  async ({ key, step, result, evidence, remoteEffects }) => {
    try {
      return okJson(checkpoints.write(key, { step, result, evidence, remoteEffects }));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_checkpoint_list",
  "Read recorded checkpoints for a lane before resuming work.",
  {
    key: z.string().min(1),
  },
  async ({ key }) => {
    try {
      return okJson({ checkpoints: checkpoints.read(key) });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_report_add",
  "Record a lane milestone, blocker, question, halted, or done report.",
  {
    key: z.string().min(1),
    kind: z.enum(["milestone", "blocker", "question", "halted", "done"]),
    text: z.string().min(1),
  },
  async ({ key, kind, text }) => {
    try {
      const report = reports.report(key, kind, text);
      return okJson({ report, line: formatReportLine(report) });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_report_list",
  "List recent reports and current progress state for a lane.",
  {
    key: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
  },
  async ({ key, limit }) => {
    try {
      return okJson({
        progress: reports.readProgress(key),
        events: reports.list(key, limit ?? 30),
      });
    } catch (e) {
      return errText(e);
    }
  },
);

// ============================================================================
// 6. BACKLOG & SHARED LOCKS
// ============================================================================

server.tool(
  "cataly_backlog_add",
  "Add a prioritized work item with a verifiable Done = contract to the local backlog.",
  {
    id: z.string().min(1).max(64),
    title: z.string().min(1).max(200),
    cwd: z.string().min(1),
    done: z.string().min(1),
    brief: z.string().min(1),
    priority: z.number().int().min(1).max(9).optional(),
    decision: z.string().optional(),
    source: z.string().optional(),
  },
  async (args) => {
    try {
      return okJson(backlog.add(args));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_backlog_list",
  "List backlog items (optionally filtered by status) and next eligible items ready to launch.",
  {
    status: z.enum(["open", "running", "done", "dropped"]).optional(),
  },
  async ({ status }) => {
    try {
      return okJson({
        items: backlog.list(status),
        nextEligible: backlog.nextEligible(5),
      });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_backlog_decide",
  "Record the owner's decision for a blocked backlog item, appending the answer to its brief and making it eligible to run.",
  {
    id: z.string().min(1),
    answer: z.string().min(1),
  },
  async ({ id, answer }) => {
    try {
      return okJson(backlog.decide(id, answer));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_backlog_drop",
  "Retire/drop a backlog item.",
  {
    id: z.string().min(1),
  },
  async ({ id }) => {
    try {
      return okJson(backlog.drop(id));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_backlog_import_github",
  "Import open GitHub issues with a given label into the local backlog (via gh CLI).",
  {
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    label: z.string().min(1),
    cwd: z.string().min(1),
    priority: z.number().int().min(1).max(9).optional(),
  },
  async ({ repo, label, cwd, priority }) => {
    try {
      return okJson(await backlog.importGithubIssues(repo, label, cwd, priority ?? 5));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_lock_manage",
  "Inspect, acquire, or release a local shared resource lock (auto-reclaims dead PIDs).",
  {
    action: z.enum(["list", "acquire", "release"]),
    name: z.string().optional(),
    lane: z.string().optional(),
    priority: z.number().int().min(1).max(9).optional(),
    note: z.string().optional(),
  },
  async ({ action, name, lane, priority, note }) => {
    try {
      if (action === "list") return okJson({ locks: locks.list() });
      if (!name) throw new Error("name is required for acquire/release");
      if (action === "acquire") {
        if (!lane) throw new Error("lane is required for acquire");
        return okJson(locks.acquire(name, lane, priority ?? 5, note));
      }
      return okJson({ released: locks.release(name, lane) });
    } catch (e) {
      return errText(e);
    }
  },
);

// ============================================================================
// 7. PR VERIFICATION & WATCH
// ============================================================================

server.tool(
  "cataly_pr_verify",
  "Verify a GitHub PR before calling it done: checks author/committer identity, tests for fix commits (or explicit 'No test: <reason>'), and flags async UI tests.",
  {
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    number: z.number().int().min(1),
  },
  async ({ repo, number }) => {
    try {
      return okJson(await verifyPrLive(repo, number, { catalyHome }));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_pr_track",
  "Track or untrack a PR for ongoing review, comment, CI failure, and merge/close monitoring.",
  {
    action: z.enum(["track", "untrack", "list"]),
    repo: z.string().optional(),
    number: z.number().int().min(1).optional(),
    lane: z.string().optional(),
    thread: z.string().optional(),
  },
  async ({ action, repo, number, lane, thread }) => {
    try {
      if (action === "list") return okJson({ prs: prTracker.list() });
      if (!repo || !number) throw new Error("repo and number are required");
      if (action === "track") return okJson(prTracker.track(repo, number, lane, thread));
      return okJson({ removed: prTracker.untrack(repo, number) });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_pr_watch_check",
  "Poll all tracked PRs via gh CLI and report new reviews, comments, CI failures, commits, merges, or closes.",
  {},
  async () => {
    try {
      return okJson(await prTracker.checkUpdates());
    } catch (e) {
      return errText(e);
    }
  },
);

// ============================================================================
// 8. DISCORD INTEGRATION
// ============================================================================

server.tool(
  "cataly_discord_poll",
  "Poll configured Discord channels and active threads for new owner-only messages using durable cursors, returning reply refs, attachments, and optional channel/thread purpose context.",
  {
    channelIds: z.array(z.string()).optional(),
    includeContext: z.boolean().optional(),
    includeHistoryOnFirstPoll: z.boolean().optional(),
  },
  async ({ channelIds, includeContext, includeHistoryOnFirstPoll }) => {
    try {
      const client = requireDiscordClient();
      const result = await pollDiscordInbound(client, stateDir, {
        channelIds,
        includeContext: includeContext ?? true,
        includeHistoryOnFirstPoll: includeHistoryOnFirstPoll ?? false,
        catalyHome,
      });
      return okJson({
        ...result,
        pendingObligations: discordInboundState.pendingObligations(),
      });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_discord_send",
  "Send a message to a Discord channel or thread (auto-splits >2000 chars preserving code blocks, suppresses unwanted pings, records message/channel reply receipt).",
  {
    channelId: z.string().min(1),
    text: z.string().min(1),
    replyTo: z.string().optional(),
    typingFirst: z.boolean().optional(),
  },
  async ({ channelId, text, replyTo, typingFirst }) => {
    try {
      const client = requireDiscordClient();
      if (typingFirst) {
        await client.typing(channelId).catch(() => {});
      }
      const messageIds = await client.send(channelId, text, { replyTo });
      if (replyTo) {
        discordInboundState.markMessageReplied(replyTo);
      } else {
        discordInboundState.markChannelReplied(channelId);
      }
      return okJson({ channelId, messageIds });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_discord_edit",
  "Edit an existing Discord message in place (for evolving single status replies).",
  {
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    text: z.string().min(1),
  },
  async ({ channelId, messageId, text }) => {
    try {
      const client = requireDiscordClient();
      await client.edit(channelId, messageId, text);
      return okText(`Edited message ${messageId} in ${channelId}`);
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_discord_react",
  "Add or remove a bot reaction on a Discord message (defaults to 👀 eyes read-receipt and records obligation receipt).",
  {
    channelId: z.string().min(1),
    messageId: z.string().min(1),
    emoji: z.string().optional(),
    remove: z.boolean().optional(),
  },
  async ({ channelId, messageId, emoji, remove }) => {
    try {
      const client = requireDiscordClient();
      const targetEmoji = emoji ?? "👀";
      await client.react(channelId, messageId, targetEmoji, Boolean(remove));
      if (!remove && targetEmoji === "👀") {
        discordInboundState.markEyesReacted(messageId);
      }
      return okJson({ channelId, messageId, emoji: targetEmoji, removed: Boolean(remove) });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_discord_thread",
  "Create or update (rename/archive) a Discord thread (supports text channels, forum channels, and message threads).",
  {
    action: z.enum(["create", "update"]),
    channelId: z.string().min(1).describe("Parent channel ID for create, or thread ID for update"),
    name: z.string().optional().describe('e.g. "[working] Fix login redirect" or "[done] Fix login redirect"'),
    messageId: z.string().optional().describe("Anchor message ID when creating a thread on a message"),
    text: z.string().optional().describe("Initial message to post inside the created thread"),
    archived: z.boolean().optional().describe("Archive/unarchive when action='update'"),
  },
  async ({ action, channelId, name, messageId, text, archived }) => {
    try {
      const client = requireDiscordClient();
      if (action === "create") {
        if (!name) throw new Error("name is required to create a thread");
        return okJson(await client.createThread(channelId, name, { messageId, text }));
      }
      return okJson(await client.updateThread(channelId, { name, archived }));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_discord_channel_purpose",
  "Set, clear, or list local operator purpose notes for Discord channels/threads (shown as context on inbound polls, never treated as instructions).",
  {
    action: z.enum(["list", "set", "clear"]),
    channelId: z.string().optional(),
    purpose: z.string().optional(),
    name: z.string().optional(),
  },
  async ({ action, channelId, purpose, name }) => {
    try {
      if (action === "list") return okJson({ purposes: discordChannels.read() });
      if (!channelId) throw new Error("channelId is required");
      if (action === "set") {
        if (!purpose) throw new Error("purpose is required");
        return okJson(discordChannels.set(channelId, purpose, name));
      }
      return okJson({ cleared: discordChannels.clear(channelId) });
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_discord_download",
  "Download a Discord CDN attachment safely to ~/.cataly/state/attachments/ with automatic image magic-byte extension detection for read_file inspection.",
  {
    url: z.string().url(),
    messageId: z.string().optional(),
    filename: z.string().optional(),
  },
  async ({ url, messageId, filename }) => {
    try {
      const saved = await downloadDiscordAttachment(url, stateDir, { messageId, filename });
      return okJson(saved);
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_discord_profile",
  "Update the Discord bot's username, avatar, profile banner, app description, or guild nickname/banner using local image files (never prints tokens).",
  {
    username: z.string().min(2).max(32).optional(),
    nick: z.string().max(32).optional(),
    description: z.string().max(400).optional(),
    avatarPath: z.string().optional(),
    bannerPath: z.string().optional(),
    guildId: z.string().optional(),
  },
  async ({ username, nick, description, avatarPath, bannerPath, guildId }) => {
    try {
      const client = requireDiscordClient();
      const cfg = loadConfig(catalyHome).discord;
      const toDataUri = (filePath: string): string => {
        const buf = readFileSync(filePath);
        const detected = detectImageExtension(buf);
        const ext = extname(filePath).toLowerCase();
        const mime = detected?.mime ?? (ext === ".png" ? "image/png" : ext === ".gif" ? "image/gif" : "image/jpeg");
        return `data:${mime};base64,${buf.toString("base64")}`;
      };
      const result = await client.updateProfile({
        username,
        nick,
        description,
        avatarDataUri: avatarPath ? toDataUri(avatarPath) : undefined,
        bannerDataUri: bannerPath ? toDataUri(bannerPath) : undefined,
        guildId: guildId ?? cfg.guildId,
      });
      return okJson(result);
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_board_post",
  "Post an informational note to the shared Head/Lane Board (context sharing only — never an instruction or approval bus).",
  {
    author: z.string().min(1).max(80).describe('e.g. "lead", "owner", or lane key'),
    text: z.string().min(1).max(2000),
    topic: z.string().max(80).optional(),
    lane: z.string().max(80).optional(),
  },
  async ({ author, text, topic, lane }) => {
    try {
      return okJson(board.post({ author, text, topic, lane }));
    } catch (e) {
      return errText(e);
    }
  },
);

server.tool(
  "cataly_board_read",
  "Read recent informational posts from the shared Head/Lane Board (optionally filtered by since seq, topic, or lane).",
  {
    since: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    topic: z.string().optional(),
    lane: z.string().optional(),
  },
  async ({ since, limit, topic, lane }) => {
    try {
      return okJson(board.read({ since, limit, topic, lane }));
    } catch (e) {
      return errText(e);
    }
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `cataly-core MCP fatal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
