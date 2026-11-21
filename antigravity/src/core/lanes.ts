import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { atomicWriteFile, withFileLock } from "./fs-utils.js";
import { LANE_KEY_PATTERN, Lessons, renderLessons } from "./lessons.js";
import { Reports } from "./reports.js";
import { checkDone, defaultRunner, doneSyntaxErrors, type Runner, type SignalCheck, type SignalIo } from "./signals.js";

export type LaneStatus = "working" | "paused" | "done-claimed" | "verified-done" | "not-done" | "closed";

export type LaneHistoryEntry = {
  readonly at: string;
  readonly status: LaneStatus;
  readonly note?: string;
};

export type LaneRecord = {
  readonly key: string;
  readonly title: string;
  readonly cwd: string;
  readonly done: string;
  readonly priority: number;
  readonly thread: string;
  readonly worklogId?: string;
  readonly conversationId?: string;
  readonly agentRole?: string;
  readonly worktreePath?: string;
  readonly status: LaneStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly version: number;
  readonly claim?: {
    readonly at: string;
    readonly evidence: string;
    readonly autoCloseAt: string;
  };
  readonly objection?: {
    readonly at: string;
    readonly reason: string;
  };
  readonly lastVerification?: {
    readonly at: string;
    readonly ok: boolean;
    readonly checks: readonly SignalCheck[];
    readonly gitIssues: readonly string[];
  };
  readonly closedAt?: string;
  readonly closeReason?: string;
  readonly history: readonly LaneHistoryEntry[];
};

export type CreateLaneInput = {
  readonly key: string;
  readonly title: string;
  readonly cwd: string;
  readonly done: string;
  readonly briefBody: string;
  readonly priority?: number;
  readonly thread?: string;
  readonly worklogId?: string;
  readonly conversationId?: string;
  readonly agentRole?: string;
  readonly worktreePath?: string;
};

export type CreateLaneResult = {
  readonly lane: LaneRecord;
  readonly briefPath: string;
  readonly renderedBrief: string;
  readonly omittedLessons: number;
};

export type VerifyCloseResult = {
  readonly lane: LaneRecord;
  readonly closed: boolean;
  readonly checks: readonly SignalCheck[];
  readonly gitIssues: readonly string[];
  readonly reasons: readonly string[];
};

export type SweepResult = {
  readonly closed: readonly string[];
  readonly rejected: readonly { readonly key: string; readonly reasons: readonly string[] }[];
  readonly pendingClaims: readonly { readonly key: string; readonly autoCloseAt: string }[];
  readonly staleLanes: readonly {
    readonly key: string;
    readonly minutesSinceActivity: number;
    readonly lastReport?: string;
  }[];
};

export class LaneError extends Error {}

const RESERVED_KEYS = new Set(["lead", "duty", "duty-loop", "hourly-loop", "reviewer"]);

export function validateLaneKey(key: string): void {
  if (!LANE_KEY_PATTERN.test(key) || RESERVED_KEYS.has(key)) {
    throw new LaneError(`invalid or reserved lane key: ${key}`);
  }
}

export async function checkGitCleanAndPushed(cwd: string, run: Runner = defaultRunner): Promise<string[]> {
  if (!existsSync(cwd)) return [];
  const res = await run(["git", "status", "--porcelain=v2", "--branch", "--untracked-files=no"], { cwd });
  if (res.code !== 0) {
    return [];
  }
  const issues: string[] = [];
  let hasDirtyTracked = false;
  let aheadCount = 0;

  for (const line of res.out.split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+)\s+-(\d+)/.exec(line);
      if (match?.[1]) {
        aheadCount = Number.parseInt(match[1], 10);
      }
      continue;
    }
    if (!line.startsWith("# ")) {
      hasDirtyTracked = true;
    }
  }

  if (hasDirtyTracked) {
    issues.push(`uncommitted tracked changes in ${cwd}`);
  }
  if (Number.isFinite(aheadCount) && aheadCount > 0) {
    issues.push(`${aheadCount} unpushed commit(s) in ${cwd}`);
  }
  return issues;
}

export class LaneRegistry {
  readonly lanesDir: string;
  readonly briefsDir: string;
  readonly lessons: Lessons;
  readonly reports: Reports;

  constructor(
    readonly stateDir: string,
    readonly catalyHome?: string,
  ) {
    this.lanesDir = join(stateDir, "lanes");
    this.briefsDir = join(stateDir, "briefs");
    this.lessons = new Lessons(stateDir);
    this.reports = new Reports(stateDir);
  }

  recordPath(key: string): string {
    validateLaneKey(key);
    return join(this.lanesDir, `${key}.json`);
  }

  briefPath(key: string): string {
    validateLaneKey(key);
    return join(this.briefsDir, `${key}.md`);
  }

  get(key: string): LaneRecord | null {
    const path = this.recordPath(key);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as LaneRecord;
  }

  require(key: string): LaneRecord {
    const lane = this.get(key);
    if (!lane) throw new LaneError(`lane not found: ${key}`);
    return lane;
  }

  list(includeClosed = false): LaneRecord[] {
    if (!existsSync(this.lanesDir)) return [];
    const lanes: LaneRecord[] = [];
    for (const entry of readdirSync(this.lanesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const lane = JSON.parse(readFileSync(join(this.lanesDir, entry.name), "utf8")) as LaneRecord;
        if (includeClosed || lane.status !== "closed") {
          lanes.push(lane);
        }
      } catch {
        // skip unreadable artifacts
      }
    }
    return lanes.sort((a, b) => a.priority - b.priority || Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  create(input: CreateLaneInput, now = Date.now()): CreateLaneResult {
    validateLaneKey(input.key);
    const syntaxErrors = doneSyntaxErrors(input.done);
    if (syntaxErrors.length > 0) {
      throw new LaneError(`invalid Done = line: ${syntaxErrors.join("; ")}`);
    }
    const priority = input.priority ?? 5;
    if (!Number.isInteger(priority) || priority < 1 || priority > 9) {
      throw new LaneError("priority must be an integer between 1 and 9");
    }
    const cwd = resolve(input.cwd);
    const path = this.recordPath(input.key);
    return withFileLock(`${path}.lock`, () => {
      const existing = this.get(input.key);
      if (existing && existing.status !== "closed") {
        throw new LaneError(`lane "${input.key}" already exists with status "${existing.status}"`);
      }

      const lessonRead = this.lessons.forRepo(cwd);
      const lessonsHeader = renderLessons(lessonRead.lessons);
      const footer = [
        "---",
        "## Cataly Lane Contract",
        `- **Lane Key**: \`${input.key}\``,
        `- **Thread**: \`${input.thread ?? "none"}\``,
        `- **Working Directory**: \`${cwd}\``,
        `- **Done =** ${input.done.replace(/^Done\s*=\s*/i, "").trim()}`,
        "",
        "### Done Protocol (Required)",
        "1. Record milestones, blockers, or questions with `cataly_report_add`.",
        "2. Record every completed step and external side effect once with `cataly_checkpoint_write`.",
        "3. Verify every `Done =` signal yourself before claiming done.",
        "4. Claim completion with `cataly_lane_claim_done` providing concrete live evidence (SHA, command output, file path, URL).",
        "5. Never mark done on speculation — the verifier re-runs every `Done =` signal live.",
      ].join("\n");

      const renderedBrief = [
        `# Lane: ${input.key} — ${input.title.trim()}`,
        "",
        lessonsHeader ? lessonsHeader.trimEnd() + "\n" : "",
        input.briefBody.trim(),
        "",
        footer,
        "",
      ]
        .filter((s, idx) => idx === 0 || s !== "")
        .join("\n");

      mkdirSync(this.briefsDir, { recursive: true });
      const bPath = this.briefPath(input.key);
      atomicWriteFile(bPath, renderedBrief);

      const iso = new Date(now).toISOString();
      const record: LaneRecord = {
        key: input.key,
        title: input.title.trim(),
        cwd,
        done: input.done.replace(/^Done\s*=\s*/i, "").trim(),
        priority,
        thread: input.thread?.trim() || "none",
        ...(input.worklogId ? { worklogId: input.worklogId } : {}),
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.agentRole ? { agentRole: input.agentRole } : {}),
        ...(input.worktreePath ? { worktreePath: resolve(input.worktreePath) } : {}),
        status: "working",
        createdAt: iso,
        updatedAt: iso,
        version: (existing?.version ?? 0) + 1,
        history: [{ at: iso, status: "working", note: "lane created" }],
      };
      atomicWriteFile(path, `${JSON.stringify(record, null, 2)}\n`);
      return {
        lane: record,
        briefPath: bPath,
        renderedBrief,
        omittedLessons: lessonRead.omitted.length,
      };
    });
  }

  attach(key: string, conversationId: string, agentRole?: string, now = Date.now()): LaneRecord {
    const path = this.recordPath(key);
    return withFileLock(`${path}.lock`, () => {
      const lane = this.require(key);
      const updated: LaneRecord = {
        ...lane,
        conversationId: conversationId.trim(),
        ...(agentRole ? { agentRole: agentRole.trim() } : {}),
        updatedAt: new Date(now).toISOString(),
        version: lane.version + 1,
      };
      atomicWriteFile(path, `${JSON.stringify(updated, null, 2)}\n`);
      return updated;
    });
  }

  pause(key: string, reason?: string, expectedVersion?: number, now = Date.now()): LaneRecord {
    return this.transition(
      key,
      (lane) => {
        if (lane.status === "closed") throw new LaneError(`lane "${key}" is closed`);
        if (lane.status === "paused") return lane;
        const at = new Date(now).toISOString();
        return {
          ...lane,
          status: "paused",
          updatedAt: at,
          version: lane.version + 1,
          history: [...lane.history, { at, status: "paused", ...(reason ? { note: reason } : {}) }],
        };
      },
      expectedVersion,
    );
  }

  resume(key: string, note?: string, expectedVersion?: number, now = Date.now()): LaneRecord {
    return this.transition(
      key,
      (lane) => {
        if (lane.status === "closed") throw new LaneError(`lane "${key}" is closed`);
        const at = new Date(now).toISOString();
        return {
          ...lane,
          status: "working",
          updatedAt: at,
          version: lane.version + 1,
          history: [...lane.history, { at, status: "working", note: note ?? "resumed" }],
        };
      },
      expectedVersion,
    );
  }

  claimDone(
    key: string,
    evidence: string,
    graceMinutes?: number,
    expectedVersion?: number,
    now = Date.now(),
  ): LaneRecord {
    const trimmed = evidence.trim();
    if (!trimmed) throw new LaneError("evidence is required when claiming done");
    const grace = graceMinutes ?? loadConfig(this.catalyHome).doneGraceMinutes;
    return this.transition(
      key,
      (lane) => {
        if (lane.status === "closed") throw new LaneError(`lane "${key}" is already closed`);
        const at = new Date(now).toISOString();
        const autoCloseAt = new Date(now + grace * 60_000).toISOString();
        return {
          ...lane,
          status: "done-claimed",
          updatedAt: at,
          version: lane.version + 1,
          claim: { at, evidence: trimmed, autoCloseAt },
          history: [...lane.history, { at, status: "done-claimed", note: trimmed }],
        };
      },
      expectedVersion,
    );
  }

  objectDone(key: string, reason: string, expectedVersion?: number, now = Date.now()): LaneRecord {
    const trimmed = reason.trim();
    if (!trimmed) throw new LaneError("reason is required when objecting to a done claim");
    return this.transition(
      key,
      (lane) => {
        if (lane.status === "closed") throw new LaneError(`lane "${key}" is already closed`);
        const at = new Date(now).toISOString();
        return {
          ...lane,
          status: "not-done",
          updatedAt: at,
          version: lane.version + 1,
          objection: { at, reason: trimmed },
          history: [...lane.history, { at, status: "not-done", note: trimmed }],
        };
      },
      expectedVersion,
    );
  }

  async verifyAndClose(
    key: string,
    opts: {
      readonly skipGitCheck?: boolean;
      readonly forceClose?: boolean;
      readonly expectedVersion?: number;
      readonly runner?: Runner;
      readonly signalIo?: SignalIo;
      readonly now?: number;
    } = {},
  ): Promise<VerifyCloseResult> {
    const lane = this.require(key);
    const expectedVersion = opts.expectedVersion ?? lane.version;
    if (opts.expectedVersion !== undefined && lane.version !== opts.expectedVersion) {
      return {
        lane,
        closed: false,
        checks: [],
        gitIssues: [],
        reasons: [
          `lane changed concurrently before verification (expected v${opts.expectedVersion}, actual v${lane.version}, status=${lane.status})`,
        ],
      };
    }
    if (lane.status === "paused" && !opts.forceClose) {
      return {
        lane,
        closed: false,
        checks: [],
        gitIssues: [],
        reasons: [`lane "${key}" is paused; resume it or pass forceClose to close`],
      };
    }
    const now = opts.now ?? Date.now();
    const runner = opts.runner ?? defaultRunner;
    const checks = await checkDone(lane.done, runner, { cwd: lane.cwd, ...opts.signalIo });
    const gitIssues = opts.skipGitCheck ? [] : await checkGitCleanAndPushed(lane.worktreePath ?? lane.cwd, runner);

    const failedSignals = checks.filter((c) => !c.ok).map((c) => `signal failed (${c.signal}): ${c.detail}`);
    const reasons = [...failedSignals, ...gitIssues];
    const allPassed = reasons.length === 0;
    const at = new Date(now).toISOString();

    let updated: LaneRecord;
    try {
      updated = this.transition(
        key,
        (current) => {
          if (current.status === "closed") return current;
          if (current.status === "paused" && !opts.forceClose) return current;
          const verification = { at, ok: allPassed, checks, gitIssues };
          if (allPassed || opts.forceClose) {
            const closeNote = allPassed ? "all Done signals verified live" : `force closed (${reasons.join("; ")})`;
            return {
              ...current,
              status: "closed",
              updatedAt: at,
              closedAt: at,
              closeReason: closeNote,
              lastVerification: verification,
              version: current.version + 1,
              history: [
                ...current.history,
                ...(allPassed ? [{ at, status: "verified-done" as const, note: "verified live" }] : []),
                { at, status: "closed" as const, note: closeNote },
              ],
            };
          }
          return {
            ...current,
            status: "not-done",
            updatedAt: at,
            lastVerification: verification,
            objection: { at, reason: reasons.join("; ") },
            version: current.version + 1,
            history: [...current.history, { at, status: "not-done", note: reasons.join("; ") }],
          };
        },
        expectedVersion,
      );
    } catch (err) {
      if (err instanceof LaneError && err.message.startsWith("LANE_CHANGED:")) {
        const latest = this.require(key);
        const conflictReason = `lane changed concurrently during verification (expected v${expectedVersion}, actual v${latest.version}, status=${latest.status})`;
        return {
          lane: latest,
          closed: false,
          checks,
          gitIssues,
          reasons: [conflictReason, ...reasons],
        };
      }
      throw err;
    }

    return {
      lane: updated,
      closed: updated.status === "closed",
      checks,
      gitIssues,
      reasons,
    };
  }

  async sweep(
    opts: {
      readonly skipGitCheck?: boolean;
      readonly runner?: Runner;
      readonly signalIo?: SignalIo;
      readonly now?: number;
    } = {},
  ): Promise<SweepResult> {
    const now = opts.now ?? Date.now();
    const config = loadConfig(this.catalyHome);
    const staleMs = config.staleMinutes * 60_000;
    const lanes = this.list(false);

    const closed: string[] = [];
    const rejected: { key: string; reasons: readonly string[] }[] = [];
    const pendingClaims: { key: string; autoCloseAt: string }[] = [];
    const staleLanes: { key: string; minutesSinceActivity: number; lastReport?: string }[] = [];

    for (const lane of lanes) {
      if (lane.status === "done-claimed" && lane.claim) {
        if (Date.parse(lane.claim.autoCloseAt) <= now) {
          const result = await this.verifyAndClose(lane.key, {
            skipGitCheck: opts.skipGitCheck,
            expectedVersion: lane.version,
            runner: opts.runner,
            signalIo: opts.signalIo,
            now,
          });
          if (result.closed) closed.push(lane.key);
          else rejected.push({ key: lane.key, reasons: result.reasons });
        } else {
          pendingClaims.push({ key: lane.key, autoCloseAt: lane.claim.autoCloseAt });
        }
      } else if (lane.status === "working" || lane.status === "not-done") {
        const progress = this.reports.readProgress(lane.key);
        if (progress?.state === "blocked" || progress?.state === "halted") continue;
        const lastAt = Date.parse(progress?.lastEvent.at ?? lane.updatedAt);
        const ageMs = now - lastAt;
        if (ageMs >= staleMs) {
          staleLanes.push({
            key: lane.key,
            minutesSinceActivity: Math.floor(ageMs / 60_000),
            ...(progress?.lastReport ? { lastReport: progress.lastReport.text } : {}),
          });
        }
      }
    }

    return { closed, rejected, pendingClaims, staleLanes };
  }

  private transition(key: string, fn: (lane: LaneRecord) => LaneRecord, expectedVersion?: number): LaneRecord {
    const path = this.recordPath(key);
    return withFileLock(`${path}.lock`, () => {
      const current = this.require(key);
      if (expectedVersion !== undefined && current.version !== expectedVersion) {
        throw new LaneError(`LANE_CHANGED: expected version ${expectedVersion}, actual ${current.version}`);
      }
      const next = fn(current);
      if (next !== current) {
        atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
      }
      return next;
    });
  }
}
