import type { Checkpoints } from "./checkpoints.ts";
import { confirmMarks, type WindowRead } from "./evidence-window.ts";
import { type Evidenced, novelEvidence } from "./evidence.ts";
import type { Reports } from "./reports.ts";
import type { Clock } from "./run.ts";
import {
  type Observation,
  observeBudget,
  selectedEvidence,
  type SupervisedLane,
  type SupervisionOptions,
  type SupervisionResult,
  type UsageSnapshot,
  type WorkingTimer,
  writeObservation,
} from "./supervision-observe.ts";

/** The journals a verdict reads, and writes only under the delivery lock; the clock and thresholds it judges by. */
type VerdictDeps = {
  readonly reports: Reports;
  readonly checkpoints: Checkpoints;
  readonly options: SupervisionOptions;
  readonly clock: Pick<Clock, "now">;
};
/** One sweep once its window is read: everything its verdict needs besides the journals. */
type SweepRead = WindowRead & {
  readonly lane: SupervisedLane;
  readonly now: number;
  readonly timer: WorkingTimer | null;
  readonly usage: UsageSnapshot;
  readonly previous: Observation | null;
};

const HUNG = "Working/Running timer exceeded threshold without fresh evidence (selected or changed file bytes)";

// The lane's progress in its generation, and its evidence in the source-grouped merge: reports, then checkpoints.
const journals = (deps: VerdictDeps, lane: SupervisedLane) => {
  const progress = deps.reports.read(lane.key, { generation: lane.lifecycleEpoch });
  const records: readonly Evidenced[] = [...(progress?.evidenced ?? []), ...deps.checkpoints.read(lane.key)];
  return { progress, records };
};

// What the evidence says against the previous observation. `quiet` holds every condition of a new hung verdict but the
// recheck of the marks; novel file evidence or another selected evidence disqualifies the cycle.
const assess = (deps: VerdictDeps, read: SweepRead, records: readonly Evidenced[], novel: boolean) => {
  const { previous: last, timer, now } = read;
  const evidence = selectedEvidence(records);
  const advanced = last?.files !== undefined && evidence.signature !== last.activity;
  const coverage = read.coverage && { ...read.coverage, changed: read.coverage.changed || novel || advanced };
  const complete = !(coverage?.pending.length || coverage?.deferred.length) && read.evidenceError === undefined;
  const activeAt = !last || advanced ? deps.clock.now() : last.activeAt;
  const quiet =
    coverage?.changed === false &&
    complete &&
    last !== null &&
    last.evidenceError === undefined &&
    timer !== null &&
    last.timer !== null &&
    timer.kind === last.timerKind &&
    timer.seconds > last.timer &&
    // A changed timer origin means a new call, even if its duration is larger. Rounding to the shown unit moves the
    // computed origin by up to one unit, plus sweep jitter.
    Math.abs(now - timer.seconds * 1000 - (last.at - last.timer * 1000)) <= timer.step * 1000 + 2000 &&
    timer.seconds >= (deps.options.hungAfterMinutes ?? 20) * 60 &&
    now - activeAt >= (deps.options.staleAfterMinutes ?? 20) * 60_000;
  return { evidence, advanced, coverage, complete, activeAt, quiet };
};

/**
 * Outside the delivery lock, after the window read: only a sweep that may prove a new hung verdict re-stats every known
 * candidate, including this window (confirmMarks). False is unknown, never evidence. Undefined means no recheck was
 * due; a commit that finds one due after all withholds the new verdict until the next sweep.
 */
export const recheckQuiet = (deps: VerdictDeps, read: SweepRead): boolean | undefined => {
  const { records } = journals(deps, read.lane);
  const { quiet } = assess(deps, read, records, novelEvidence(records, read.observed).length > 0);
  return quiet && read.previous?.hung !== true ? confirmMarks(read.files).quiet : undefined;
};

/**
 * Under the delivery lock, in the prepared generation: record new file evidence, judge the sweep and reconcile the
 * journal. `settle`, also under the lock, folds what the lane recorded while alerts were delivered, reconciles again
 * and saves the observation. Every journal write awaits its receipt, so the shared evidence sequence is taken in order.
 */
export const judgeSweep = async (deps: VerdictDeps, read: SweepRead, recheck: boolean | undefined) => {
  const { lane, previous, now } = read;
  const tag = lane.lifecycleEpoch === undefined ? {} : { generation: lane.lifecycleEpoch };
  let { progress, records } = journals(deps, lane);
  const evidenceRefs = novelEvidence(records, read.observed);
  if (evidenceRefs.length) {
    await deps.reports.append({
      type: "activity",
      key: lane.key,
      ...tag,
      at: new Date(deps.clock.now()).toISOString(),
      state: progress?.state === "stalled" ? "stalled" : "running",
      text: "Observed filesystem evidence",
      evidenceRefs,
    });
    // A writer may have accepted the same evidence while append waited for its sequence; fold that record too.
    ({ progress, records } = journals(deps, lane));
  }
  const assessed = assess(deps, read, records, evidenceRefs.length > 0);
  const { evidence, coverage, complete } = assessed;
  let { advanced, activeAt } = assessed;
  const provedHung = assessed.quiet && (previous?.hung === true || recheck === true);
  const { violations, unavailable } = observeBudget(deps.options, lane, now, read.usage);
  let terminal = progress?.state === "done" || progress?.state === "halted";
  let hung = !terminal && progress?.state !== "blocked" && (provedHung || (!advanced && previous?.hung === true));
  const alerts = () => (terminal ? [] : [...(violations.length ? violations : hung ? [HUNG] : []), ...unavailable]);
  const freshAlerts = alerts().filter((message) => !previous?.alerts.includes(message));
  const reconcile = async () => {
    // A question also reads as blocked; only this same ceiling blocker as the latest report makes a repeat.
    const blocker = violations.join("; ");
    const reported = progress?.lastReport?.kind === "blocker" && progress.lastReport.text === blocker;
    const at = deps.clock.now();
    if (!terminal && violations.length && !reported) {
      await deps.reports.report(lane.key, "blocker", blocker, at, lane.lifecycleEpoch);
    } else if (!terminal && hung && (!progress || progress.state === "running")) {
      await deps.reports.append({
        type: "activity",
        key: lane.key,
        ...tag,
        at: new Date(at).toISOString(),
        state: "stalled",
        text: HUNG,
      });
    } else if (!violations.length && progress?.state === "stalled" && advanced) {
      await deps.reports.append({
        type: "activity",
        key: lane.key,
        ...tag,
        at: new Date(at).toISOString(),
        state: "running",
        text: "Fresh evidence observed (selected or changed file bytes)",
      });
    } else return;
    progress = journals(deps, lane).progress;
  };
  await reconcile();
  const settle = async (undelivered: ReadonlyMap<string, string>, path: string): Promise<SupervisionResult> => {
    const journal = journals(deps, lane);
    progress = journal.progress;
    const current = freshAlerts.length ? selectedEvidence(journal.records) : evidence;
    if (current.signature !== evidence.signature) {
      advanced = true;
      activeAt = deps.clock.now();
      hung = false;
    }
    terminal = progress?.state === "done" || progress?.state === "halted";
    hung &&= !terminal && progress?.state !== "blocked";
    await reconcile();
    const lastReportAt = progress?.lastReport?.at ?? null;
    const uncertainty = read.evidenceError === undefined ? {} : { evidenceError: read.evidenceError };
    const observation: Observation = {
      openedAt: lane.openedAt,
      ...tag,
      at: now,
      timer: read.timer?.seconds ?? null,
      timerKind: read.timer?.kind ?? null,
      hung: progress?.state === "stalled" && hung,
      activity: current.signature,
      files: read.files,
      ...(coverage === undefined ? {} : { coverage: { ...coverage, changed: coverage.changed || advanced } }),
      activeAt,
      lastReportAt,
      lastEvidenceAt: current.lastEvidenceAt,
      ...uncertainty,
      alerts: alerts().filter((message) => !undelivered.has(message)),
    };
    writeObservation(path, observation);
    return {
      enabled: true,
      state: progress?.state ?? "running",
      alerts: freshAlerts,
      usage: read.usage,
      hung: provedHung && observation.hung === true,
      heldHung: observation.hung === true,
      coverageComplete: complete,
      lastReportAt,
      lastEvidenceAt: current.lastEvidenceAt,
      ...uncertainty,
    };
  };
  return { freshAlerts, settle };
};
