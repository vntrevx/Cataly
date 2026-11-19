import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Checkpoints } from "./checkpoints.ts";
import { fill } from "./config.ts";
import { confirmMarks, type FileCoverage, observeFiles } from "./evidence-window.ts";
import { type Evidenced, evidenceClock, novelEvidence, type PathMark } from "./evidence.ts";
import type { Lane } from "./registry.ts";
import type { Activity, Reports } from "./reports.ts";
import type { Clock, Runner } from "./run.ts";

export type SupervisionDeps = {
  readonly stateDir: string;
  readonly run: Runner;
  readonly clock: Pick<Clock, "now">;
  readonly reports?: Reports;
  readonly alert?: (lane: SupervisedLane, message: string) => void | Promise<void>;
};
export type SupervisionResult = {
  readonly enabled: boolean;
  readonly state: "running" | "stalled" | "blocked" | "halted" | "done" | null;
  readonly alerts: readonly string[];
  readonly usage: UsageSnapshot | null;
  readonly hung: boolean;
  /** A previous proven hung stall still held, even when this sweep cannot prove a new one. */
  readonly heldHung: boolean;
  readonly coverageComplete: boolean;
  /** The two clocks of laneEvidence: the last report, and the last change of the evidence the lane selected. */
  readonly lastReportAt: string | null;
  readonly lastEvidenceAt: string | null;
  /** This sweep's observation failure, else a path read failure that no later read has resolved; never a raced read. */
  readonly evidenceError?: string;
};
export type Observation = {
  readonly at: number;
  readonly timer: number | null;
  readonly timerKind: string | null;
  /** LaneEvidence.signature. A record without `files` is from before evidence fingerprints: not comparable. */
  readonly activity: string;
  readonly files?: Readonly<Record<string, PathMark>>;
  /** Unfinished windows and cycle changes survive monitor restarts; partial coverage is not a read failure. */
  readonly coverage?: FileCoverage;
  /** A confirmed stall survives incomplete windows so its alert is deduplicated or retried, not lost. */
  readonly hung?: boolean;
  /** When evidence last changed, or when supervision began watching: the hung check's quiet clock. */
  readonly activeAt: number;
  readonly lastReportAt?: string | null;
  readonly lastEvidenceAt?: string | null;
  readonly evidenceError?: string;
  readonly alerts: readonly string[];
};

export type BudgetLimits = {
  readonly wallMinutes?: number | null | undefined;
  readonly tokens?: number | null | undefined;
  readonly costUsd?: number | null | undefined;
};
export type Usage = { readonly tokens: number | null; readonly costUsd: number | null };
export type UsageSnapshot = Usage & { readonly key: string; readonly at: string; readonly final?: true };

export const readUsage = async (
  run: Runner,
  argv: readonly string[] | undefined,
  lane: SupervisedLane,
  now: number,
): Promise<UsageSnapshot> => {
  let usage: Usage = { tokens: null, costUsd: null };
  if (argv?.length) {
    const result = await run(fill(argv, { key: lane.key, session: lane.session ?? "", cwd: lane.cwd ?? "" }), {
      ...(lane.cwd !== undefined ? { cwd: lane.cwd } : {}),
      timeoutMs: 10_000,
    });
    if (result.code === 0) {
      try {
        const value: unknown = JSON.parse(result.out);
        const metric = (name: "tokens" | "costUsd"): number | null => {
          const n =
            typeof value === "object" && value !== null && name in value
              ? (value as Record<string, unknown>)[name]
              : null;
          return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
        };
        usage = { tokens: metric("tokens"), costUsd: metric("costUsd") };
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        // Malformed external JSON remains unknown, never zero.
      }
    }
  }
  return { key: lane.key, at: new Date(now).toISOString(), ...usage };
};

/** Independent of evidence availability: a failed observation must never hide a reached ceiling. */
export const budgetViolations = (limits: BudgetLimits, usage: Usage, wallMinutes: number): string[] => {
  const actual = { ...usage, wallMinutes };
  return (["wallMinutes", "tokens", "costUsd"] as const).flatMap((name) => {
    const ceiling = limits[name];
    const value = actual[name];
    return typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling >= 0 && value !== null && value >= ceiling
      ? [`${name} ceiling reached (${ceiling})`]
      : [];
  });
};
export type SupervisedLane = Lane & { readonly activityPaths?: readonly string[]; readonly budget?: BudgetLimits };
export type SupervisionOptions = {
  readonly hungAfterMinutes?: number;
  readonly staleAfterMinutes?: number;
  readonly defaults?: BudgetLimits;
  readonly lanes?: Readonly<Record<string, BudgetLimits>>;
  readonly usageArgv?: readonly string[];
  readonly recordCostArgv?: readonly string[];
  readonly activityPaths?: readonly string[];
  readonly gitActivity?: boolean;
};
// Match only an explicit duration on a visible Working/Running line. step is the smallest unit shown, in seconds:
// "25m" is rounded to the minute, so two readings can place the same call's start up to a minute apart.
export const workingTimer = (screen: string): { kind: string; seconds: number; step: number } | null => {
  for (const line of Bun.stripANSI(screen).split("\n")) {
    const kind = /^\s*[^\w\n]*(Working|Running)\b/i.exec(line)?.[1]?.toLowerCase();
    if (!kind) continue;
    const clock = /\b(\d+):(\d{2})(?::(\d{2}))?\b/.exec(line);
    if (clock) {
      const seconds =
        clock[3] === undefined
          ? Number(clock[1]) * 60 + Number(clock[2])
          : Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3]);
      return { kind, seconds, step: 1 };
    }
    const parts = [...line.matchAll(/(\d+(?:\.\d+)?)\s*(h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)\b/gi)];
    const unit = (name = ""): number => (/^h/i.test(name) ? 3600 : /^m/i.test(name) ? 60 : 1);
    if (parts.length)
      return {
        kind,
        seconds: parts.reduce((sum, match) => sum + Number(match[1]) * unit(match[2]), 0),
        step: Math.min(...parts.map((match) => unit(match[2]))),
      };
  }
  return null;
};

export type LaneEvidence = {
  /** Changes only with evidence: a newly selected fingerprint in the journals, or new bytes at a watched path. */
  readonly signature: string;
  /** The watched paths' marks; settled unchanged stats avoid rereading their bytes. */
  readonly files: Readonly<Record<string, PathMark>>;
  readonly coverage?: FileCoverage;
  /** The report clock: when the lane last reported, whatever it said. Freshness nudges and posts on this one. */
  readonly lastReportAt: string | null;
  /** The selected-evidence clock: when a report or checkpoint last carried a fingerprint not seen before. */
  readonly lastEvidenceAt: string | null;
  readonly evidenceError?: string;
  /**
   * Called only for a new hung verdict: re-stats every known candidate, including this sweep (confirmMarks). False is
   * unknown, never evidence, and leaves the marks and windows as they are. Discovery and stats are not atomic:
   * paths created after Git discovery enter the next sweep, not this known-candidate recheck.
   */
  readonly confirmQuiet: () => boolean;
};

export const selectedEvidence = (records: Iterable<Evidenced>): Pick<LaneEvidence, "signature" | "lastEvidenceAt"> => {
  const selected = evidenceClock(records);
  return {
    signature: createHash("sha256").update(JSON.stringify(selected)).digest("hex"),
    lastEvidenceAt: selected.lastEvidenceAt,
  };
};

/** Before the first completed sweep, only the prepared candidate schedule exists. */
export type ObservationState = Observation | { readonly coverage: FileCoverage };

export const writeObservation = (path: string, observation: ObservationState): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(observation), { mode: 0o600 });
  renameSync(temporary, path);
};

/**
 * What counts as the lane's progress: evidence it selected in its reports and checkpoints, and the content of the
 * files it changed (git status plus activityPaths). A report's text or time, an unchanged re-report and a touched file
 * are not progress. Dori's own lane state (`<stateDir>/lanes`) is never the lane's evidence.
 */
export const laneEvidence = async (
  deps: Pick<SupervisionDeps, "run" | "clock">,
  options: SupervisionOptions,
  reports: Reports,
  checkpoints: Checkpoints,
  lane: SupervisedLane,
  previous: Pick<Observation, "files" | "coverage"> | null,
  persist: (coverage: FileCoverage) => void,
): Promise<LaneEvidence> => {
  const { run, clock } = deps;
  const { files, coverage, observed, evidenceError } = await observeFiles(
    run,
    options,
    reports.stateDir,
    lane,
    previous,
    persist,
  );
  let progress = reports.read(lane.key);
  let records = [...(progress?.evidenced ?? []), ...checkpoints.read(lane.key)];
  const evidenceRefs = novelEvidence(records, observed);
  if (evidenceRefs.length) {
    const event: Activity = {
      type: "activity",
      key: lane.key,
      at: new Date(clock.now()).toISOString(),
      state: progress?.state === "stalled" ? "stalled" : "running",
      text: "Observed filesystem evidence",
      evidenceRefs,
    };
    await reports.append(event);
    // A writer may have accepted the same evidence while append waited for its sequence; fold that record too.
    progress = reports.read(lane.key);
    records = [...(progress?.evidenced ?? []), ...checkpoints.read(lane.key)];
  }
  return {
    ...selectedEvidence(records),
    files,
    ...(coverage === undefined
      ? {}
      : { coverage: { ...coverage, changed: coverage.changed || evidenceRefs.length > 0 } }),
    lastReportAt: progress?.lastReport?.at ?? null,
    ...(evidenceError === undefined ? {} : { evidenceError }),
    confirmQuiet: () => confirmMarks(files).quiet,
  };
};
