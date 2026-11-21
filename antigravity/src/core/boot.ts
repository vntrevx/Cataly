import { DiscordInboundState, type ObligationRecord } from "../discord/inbound.js";
import { Backlog } from "./backlog.js";
import { SharedBoard } from "./board.js";
import { loadConfig, loadDiscordBotToken, resolveCatalyHome, resolveStateDir } from "./config.js";
import { Decisions } from "./decisions.js";
import { LaneRegistry } from "./lanes.js";
import { Lessons } from "./lessons.js";
import { SharedLocks } from "./locks.js";
import { PrTracker } from "./pr.js";
import { Reports } from "./reports.js";
import { Worklog } from "./worklog.js";

export type BootSummary = {
  readonly catalyHome: string;
  readonly agentName: string;
  readonly ownerName?: string;
  readonly onboardingStatus: string;
  readonly discordConfigured: boolean;
  readonly openWorklog: readonly {
    readonly id: string;
    readonly title: string;
    readonly next?: string;
    readonly source: string;
  }[];
  readonly openDecisions: readonly {
    readonly id: string;
    readonly question: string;
    readonly lane?: string;
    readonly message?: string;
    readonly options: readonly string[];
    readonly recommend?: number;
  }[];
  readonly activeLanes: readonly {
    readonly key: string;
    readonly title: string;
    readonly status: string;
    readonly priority: number;
    readonly conversationId?: string;
    readonly lastReport?: string;
    readonly autoCloseAt?: string;
  }[];
  readonly pendingDiscordObligations: readonly ObligationRecord[];
  readonly backlogOpenCount: number;
  readonly backlogBlockedCount: number;
  readonly trackedPrCount: number;
  readonly activeLocks: readonly { readonly name: string; readonly lane: string; readonly pid: number }[];
  readonly lessonCount: number;
  readonly boardHead: number;
  readonly warnings: readonly string[];
};

export function collectBootSummary(catalyHome?: string): BootSummary {
  const home = resolveCatalyHome(catalyHome);
  const stateDir = resolveStateDir(home);
  const config = loadConfig(home);
  const worklog = new Worklog(stateDir);
  const decisions = new Decisions(stateDir);
  const lanes = new LaneRegistry(stateDir, home);
  const reports = new Reports(stateDir);
  const backlog = new Backlog(stateDir);
  const prs = new PrTracker(stateDir);
  const locks = new SharedLocks(stateDir);
  const lessons = new Lessons(stateDir);
  const board = new SharedBoard(stateDir);
  const inboundState = new DiscordInboundState(stateDir);

  const wlRead = worklog.read();
  const decRead = decisions.read();
  const lessonRead = lessons.read();
  const boardRead = board.read({ limit: 5 });
  const openBacklog = backlog.list("open");
  const activeLaneRecords = lanes.list(false);
  const pendingDiscordObligations = inboundState.pendingObligations();
  const warnings = [
    ...wlRead.problems,
    ...wlRead.warnings,
    ...decRead.problems,
    ...lessonRead.problems,
    ...boardRead.problems,
  ];

  return {
    catalyHome: home,
    agentName: config.agentName,
    ...(config.ownerName ? { ownerName: config.ownerName } : {}),
    onboardingStatus: config.onboarding.status,
    discordConfigured: Boolean(loadDiscordBotToken(home) && config.discord.ownerId),
    openWorklog: wlRead.items
      .filter((i) => i.closedAt === undefined)
      .map((i) => ({ id: i.id, title: i.title, source: i.source, ...(i.next ? { next: i.next } : {}) })),
    openDecisions: decRead.items
      .filter((d) => d.answeredAt === undefined && d.withdrawnAt === undefined)
      .map((d) => ({
        id: d.id,
        question: d.question,
        options: d.options,
        ...(d.lane ? { lane: d.lane } : {}),
        ...(d.message ? { message: d.message } : {}),
        ...(d.recommend !== undefined ? { recommend: d.recommend } : {}),
      })),
    activeLanes: activeLaneRecords.map((l) => {
      const progress = reports.readProgress(l.key);
      return {
        key: l.key,
        title: l.title,
        status: l.status,
        priority: l.priority,
        ...(l.conversationId ? { conversationId: l.conversationId } : {}),
        ...(progress?.lastReport ? { lastReport: `[${progress.lastReport.kind}] ${progress.lastReport.text}` } : {}),
        ...(l.claim ? { autoCloseAt: l.claim.autoCloseAt } : {}),
      };
    }),
    pendingDiscordObligations,
    backlogOpenCount: openBacklog.filter((b) => !b.decision).length,
    backlogBlockedCount: openBacklog.filter((b) => Boolean(b.decision)).length,
    trackedPrCount: prs.list().length,
    activeLocks: locks.list().map((lk) => ({ name: lk.name, lane: lk.lane, pid: lk.pid })),
    lessonCount: lessonRead.lessons.filter((l) => l.outcome === "pending" || l.outcome === "helped").length,
    boardHead: boardRead.head,
    warnings,
  };
}

export function formatBootMarkdown(summary: BootSummary): string {
  const lines: string[] = [
    `[CATALY BOOT] ${summary.agentName} | home=${summary.catalyHome} | onboarding=${summary.onboardingStatus} | discord=${summary.discordConfigured ? "ready" : "unconfigured"}`,
  ];
  if (summary.openWorklog.length > 0) {
    lines.push(`Open Worklog (${summary.openWorklog.length}):`);
    for (const w of summary.openWorklog) {
      lines.push(`  - [${w.id}] ${w.title} | Next: ${w.next ?? "(none)"}`);
    }
  }
  if (summary.openDecisions.length > 0) {
    lines.push(`Waiting Decisions (${summary.openDecisions.length}):`);
    for (const d of summary.openDecisions) {
      lines.push(`  - [${d.id}] ${d.question}${d.lane ? ` (lane:${d.lane})` : ""}`);
    }
  }
  if (summary.activeLanes.length > 0) {
    lines.push(`Active Lanes (${summary.activeLanes.length}):`);
    for (const l of summary.activeLanes) {
      lines.push(
        `  - ${l.key} [${l.status}, p${l.priority}] ${l.title}${l.lastReport ? ` | ${l.lastReport}` : ""}${l.autoCloseAt ? ` | auto-close ${l.autoCloseAt}` : ""}`,
      );
    }
  }
  if (summary.pendingDiscordObligations.length > 0) {
    lines.push(`Pending Discord Obligations (${summary.pendingDiscordObligations.length}):`);
    for (const o of summary.pendingDiscordObligations.slice(-5)) {
      lines.push(`  - ch:${o.channelId} msg:${o.messageId} (eyes=${o.eyesReacted}, replied=${o.replied})`);
    }
  }
  if (summary.backlogOpenCount > 0 || summary.backlogBlockedCount > 0) {
    lines.push(`Backlog: ${summary.backlogOpenCount} ready, ${summary.backlogBlockedCount} waiting on decision`);
  }
  if (summary.trackedPrCount > 0) {
    lines.push(`Tracked PRs: ${summary.trackedPrCount}`);
  }
  if (summary.boardHead > 0) {
    lines.push(`Shared Board: ${summary.boardHead} post(s)`);
  }
  if (summary.activeLocks.length > 0) {
    lines.push(`Active Locks: ${summary.activeLocks.map((l) => `${l.name}(${l.lane})`).join(", ")}`);
  }
  if (summary.warnings.length > 0) {
    lines.push(`Warnings: ${summary.warnings.slice(0, 5).join("; ")}`);
  }
  return lines.join("\n");
}
