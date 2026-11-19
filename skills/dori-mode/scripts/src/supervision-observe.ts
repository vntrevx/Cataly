import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { fill } from "./config.ts";
import {
  type Discovery,
  type FileCoverage,
  fileWindow,
  missedWindow,
  readWindow,
  type WindowRead,
} from "./evidence-window.ts";
import { type Evidenced, evidenceClock, type PathMark } from "./evidence.ts";
import type { Lane, Registry } from "./registry.ts";
import type { Reports } from "./reports.ts";
import type { Clock, Runner } from "./run.ts";

export type SupervisionDeps = {
  readonly stateDir: string;
  readonly run: Runner;
  readonly reports?: Reports;
  readonly alert?: (lane: SupervisedLane, message: string) => void | Promise<void>;
} & (
  | { readonly registry: Registry; readonly clock: Clock }
  | { readonly registry?: undefined; readonly clock: Pick<Clock, "now"> }
);
export type SupervisionResult = {
  readonly enabled: boolean;
  readonly state: "running" | "stalled" | "blocked" | "halted" | "done" | null;
  readonly alerts: readonly string[];
  readonly usage: UsageSnapshot | null;
  readonly hung: boolean;
  /** A previous proven hung stall still held, even when this sweep cannot prove a new one. */
  readonly heldHung: boolean;
  readonly coverageComplete: boolean;
  /** The two clocks of the lane's evidence: the last report, and the last change of the evidence the lane selected. */
  readonly lastReportAt: string | null;
  readonly lastEvidenceAt: string | null;
  /** This sweep's observation failure, else a path read failure that no later read has resolved; never a raced read. */
  readonly evidenceError?: string;
};
export type Observation = {
  /** The lane generation the record belongs to; absent only in records from before generations were kept. */
  readonly openedAt?: string;
  readonly generation?: string;
  readonly at: number;
  readonly timer: number | null;
  readonly timerKind: string | null;
  /** The selected evidence signature. A record without `files` is from before evidence fingerprints: not comparable. */
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
export type UsageSnapshot = Usage & {
  readonly key: string;
  readonly at: string;
  readonly openedAt?: string;
  readonly final?: true;
};

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
  return { key: lane.key, openedAt: lane.openedAt, at: new Date(now).toISOString(), ...usage };
};

/** Independent of evidence availability: a failed observation must never hide a reached ceiling. */
export const observeBudget = (options: SupervisionOptions, lane: SupervisedLane, now: number, usage: Usage) => {
  const limits = {
    wallMinutes: null,
    tokens: null,
    costUsd: null,
    ...options.defaults,
    ...options.lanes?.[lane.key],
    ...lane.budget,
  };
  const actual = { ...usage, wallMinutes: (now - Date.parse(lane.openedAt)) / 60_000 };
  const violations = (["wallMinutes", "tokens", "costUsd"] as const).flatMap((name) => {
    const ceiling = limits[name];
    const value = actual[name];
    return typeof ceiling === "number" && Number.isFinite(ceiling) && ceiling >= 0 && value !== null && value >= ceiling
      ? [`${name} ceiling reached (${ceiling})`]
      : [];
  });
  const unavailable = (["tokens", "costUsd"] as const)
    .filter((name) => typeof limits[name] === "number" && usage[name] === null)
    .map((name) => `${name} ceiling cannot be checked: usage unavailable`);
  return { violations, unavailable };
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
export type WorkingTimer = { readonly kind: string; readonly seconds: number; readonly step: number };
// Match only an explicit duration on a visible Working/Running line. step is the smallest unit shown, in seconds:
// "25m" is rounded to the minute, so two readings can place the same call's start up to a minute apart.
export const workingTimer = (screen: string): WorkingTimer | null => {
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

/** Changes only with evidence: a newly selected fingerprint in the journals, or new bytes at a watched path. */
export const selectedEvidence = (
  records: Iterable<Evidenced>,
): { readonly signature: string; readonly lastEvidenceAt: string | null } => {
  const selected = evidenceClock(records);
  return {
    signature: createHash("sha256").update(JSON.stringify(selected)).digest("hex"),
    lastEvidenceAt: selected.lastEvidenceAt,
  };
};

/** Before the first completed sweep of a generation, only its prepared candidate schedule exists. */
type ObservationState =
  | Observation
  | { readonly openedAt: string; readonly generation?: string; readonly coverage: FileCoverage };

/** Replaces the state atomically and returns the exact text: the basis a later commit of this sweep must still find. */
export const writeObservation = (path: string, observation: ObservationState): string => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const text = JSON.stringify(observation);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  renameSync(temporary, path);
  return text;
};

export const observationText = (path: string): string | null => (existsSync(path) ? readFileSync(path, "utf8") : null);

// State is kept per lane generation (openedAt and lifecycle epoch). A record from before generations were kept belongs
// to the current one only if it was taken after the lane opened, as for a final cost reading.
const sameGeneration = (state: ObservationState, lane: SupervisedLane): boolean =>
  state.generation === lane.lifecycleEpoch &&
  (state.openedAt === undefined
    ? "at" in state && state.at >= Date.parse(lane.openedAt)
    : state.openedAt === lane.openedAt);

/** The stored text a sweep planned over, its generation's last observation, and the window read to run unlocked. */
type Prepared = {
  readonly basis: string | null;
  readonly previous: Observation | null;
  readonly observe: () => WindowRead;
};

/**
 * Under the delivery lock, in the lane's checked generation: the candidate plan replaces this generation's state before
 * any watched file is read, so a crash keeps the plan and its discoveries. Another generation's state is never carried
 * over. A failed discovery plans and writes nothing; `observe` then keeps the trusted marks and schedule.
 */
export const prepareWindow = (path: string, lane: SupervisedLane, discovery: Discovery): Prepared => {
  const basis = observationText(path);
  const stored = basis === null ? null : (JSON.parse(basis) as ObservationState);
  const own = stored !== null && sameGeneration(stored, lane) ? stored : null;
  const previous = own !== null && "at" in own ? own : null;
  const files = previous?.files ?? {};
  if ("error" in discovery) {
    const { error } = discovery;
    return { basis, previous, observe: () => missedWindow(files, own?.coverage, error) };
  }
  const coverage = fileWindow(discovery.paths, Object.keys(files), own?.coverage);
  const generation = lane.lifecycleEpoch === undefined ? {} : { generation: lane.lifecycleEpoch };
  const planned = writeObservation(path, { ...previous, openedAt: lane.openedAt, ...generation, coverage });
  return { basis: planned, previous, observe: () => readWindow(discovery, files, coverage) };
};
