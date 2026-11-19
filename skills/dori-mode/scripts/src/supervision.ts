import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Checkpoints } from "./checkpoints.ts";
import { fill } from "./config.ts";
import { Reports } from "./reports.ts";
import {
  budgetViolations,
  laneEvidence,
  type Observation,
  type ObservationState,
  type SupervisedLane,
  type SupervisionDeps,
  type SupervisionOptions,
  type SupervisionResult,
  type Usage,
  type UsageSnapshot,
  workingTimer,
  writeObservation,
} from "./supervision-observe.ts";

export class Supervision {
  readonly reports: Reports;
  readonly checkpoints: Checkpoints;
  constructor(
    readonly deps: SupervisionDeps,
    readonly options: SupervisionOptions = {},
  ) {
    this.reports = deps.reports ?? new Reports(deps.stateDir);
    this.checkpoints = new Checkpoints(deps.stateDir);
  }

  private enabled(lane: SupervisedLane): boolean {
    return lane.reportProtocol === "jsonl-v1" || existsSync(this.reports.path(lane.key));
  }

  private async usage(
    lane: SupervisedLane,
    now: number,
    persist = Boolean(this.options.usageArgv?.length),
  ): Promise<UsageSnapshot> {
    let usage: Usage = { tokens: null, costUsd: null };
    if (this.options.usageArgv?.length) {
      const result = await this.deps.run(
        fill(this.options.usageArgv, { key: lane.key, session: lane.session ?? "", cwd: lane.cwd ?? "" }),
        { ...(lane.cwd !== undefined ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 },
      );
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
    const snapshot = { key: lane.key, at: new Date(now).toISOString(), ...usage };
    // Without a usage hook every sweep would append the same unknown reading; close still records its final one.
    if (persist) this.record(snapshot);
    return snapshot;
  }

  private costPath(key: string): string {
    return join(dirname(this.reports.path(key)), "cost.jsonl");
  }

  private record(snapshot: UsageSnapshot): void {
    const path = this.costPath(snapshot.key);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  }

  async sweep(lane: SupervisedLane, screen: string): Promise<SupervisionResult> {
    if (!this.enabled(lane))
      return {
        enabled: false,
        state: null,
        alerts: [],
        usage: null,
        hung: false,
        heldHung: false,
        coverageComplete: false,
        lastReportAt: null,
        lastEvidenceAt: null,
      };
    const now = this.deps.clock.now();
    const path = join(dirname(this.reports.path(lane.key)), "supervision.json");
    const stored = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as ObservationState) : null;
    const previous = stored && "at" in stored ? stored : null;
    const evidence = await laneEvidence(
      this.deps,
      this.options,
      this.reports,
      this.checkpoints,
      lane,
      stored,
      (coverage) => writeObservation(path, { ...previous, coverage }),
    );
    const timer = workingTimer(screen);
    const advanced = previous?.files !== undefined && evidence.signature !== previous.activity;
    const coverage = evidence.coverage && { ...evidence.coverage, changed: evidence.coverage.changed || advanced };
    const complete = !(coverage?.pending.length || coverage?.deferred.length) && evidence.evidenceError === undefined;
    const activeAt = !previous || advanced ? now : previous.activeAt;
    const usage = await this.usage(lane, now);
    const limits = {
      wallMinutes: null,
      tokens: null,
      costUsd: null,
      ...this.options.defaults,
      ...this.options.lanes?.[lane.key],
      ...lane.budget,
    };
    const violations = budgetViolations(limits, usage, (now - Date.parse(lane.openedAt)) / 60_000);
    const provedHung =
      coverage?.changed === false &&
      complete &&
      previous !== null &&
      previous.evidenceError === undefined &&
      timer !== null &&
      previous.timer !== null &&
      timer.kind === previous.timerKind &&
      timer.seconds > previous.timer &&
      // A changed timer origin means a new call, even if its duration is larger. Rounding to the shown unit moves the
      // computed origin by up to one unit, plus sweep jitter.
      Math.abs(now - timer.seconds * 1000 - (previous.at - previous.timer * 1000)) <= timer.step * 1000 + 2000 &&
      timer.seconds >= (this.options.hungAfterMinutes ?? 20) * 60 &&
      now - activeAt >= (this.options.staleAfterMinutes ?? 20) * 60_000 &&
      (previous.hung === true || evidence.confirmQuiet());
    const progress = this.reports.read(lane.key);
    const terminal = progress?.state === "done" || progress?.state === "halted";
    const hung = provedHung || (!advanced && previous?.hung === true && !terminal && progress?.state !== "blocked");
    const unavailable = (["tokens", "costUsd"] as const)
      .filter((name) => typeof limits[name] === "number" && usage[name] === null)
      .map((name) => `${name} ceiling cannot be checked: usage unavailable`);
    const hungMessage =
      "Working/Running timer exceeded threshold without fresh evidence (selected or changed file bytes)";
    const alerts = terminal ? [] : [...(violations.length ? violations : hung ? [hungMessage] : []), ...unavailable];
    const freshAlerts = alerts.filter((message) => !previous?.alerts.includes(message));
    // A question also reads as blocked; only this same ceiling blocker as the latest report makes a new one a repeat.
    const blocker = violations.join("; ");
    const reported = progress?.lastReport?.kind === "blocker" && progress.lastReport.text === blocker;
    if (!terminal && violations.length && !reported) {
      this.reports.report(lane.key, "blocker", blocker, now);
    } else if (!terminal && hung && (!progress || progress.state === "running")) {
      this.reports.append({
        type: "activity",
        key: lane.key,
        at: new Date(now).toISOString(),
        state: "stalled",
        text: hungMessage,
      });
    } else if (!violations.length && progress?.state === "stalled" && advanced) {
      this.reports.append({
        type: "activity",
        key: lane.key,
        at: new Date(now).toISOString(),
        state: "running",
        text: "Fresh evidence observed (selected or changed file bytes)",
      });
    }
    // Deliver before saving, so only alerts that reached the callback count as sent; a failed one is sent again next sweep.
    const undelivered = new Map<string, string>();
    for (const message of freshAlerts) {
      try {
        await this.deps.alert?.(lane, message);
      } catch (error) {
        undelivered.set(message, error instanceof Error ? error.message : String(error));
      }
    }
    const current = this.reports.read(lane.key);
    const lastReportAt = current?.lastReport?.at ?? null;
    const uncertainty = evidence.evidenceError === undefined ? {} : { evidenceError: evidence.evidenceError };
    const observation: Observation = {
      at: now,
      timer: timer?.seconds ?? null,
      timerKind: timer?.kind ?? null,
      hung: current?.state === "stalled" && hung,
      activity: evidence.signature,
      files: evidence.files,
      ...(coverage === undefined ? {} : { coverage }),
      activeAt,
      lastReportAt,
      lastEvidenceAt: evidence.lastEvidenceAt,
      ...uncertainty,
      alerts: alerts.filter((message) => !undelivered.has(message)),
    };
    writeObservation(path, observation);
    if (undelivered.size)
      throw new Error(
        `alert delivery failed for ${lane.key}: ${[...undelivered].map(([message, why]) => `${message} (${why})`).join("; ")}`,
      );
    return {
      enabled: true,
      state: current?.state ?? "running",
      alerts: freshAlerts,
      usage,
      hung: provedHung,
      heldHung: observation.hung === true,
      coverageComplete: complete,
      lastReportAt,
      lastEvidenceAt: evidence.lastEvidenceAt,
      ...uncertainty,
    };
  }

  async close(lane: SupervisedLane): Promise<UsageSnapshot | null> {
    if (!this.enabled(lane)) return null;
    // A close that already recorded its final reading (a retried or second close) returns it and runs no hook, so a
    // cost ledger gets each lane once. {closeKey} is the same on every attempt, for a ledger that dedupes on it.
    const path = this.costPath(lane.key);
    const recorded = existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as UsageSnapshot)
          .findLast((entry) => entry.final === true)
      : undefined;
    if (recorded) return recorded;
    const snapshot = await this.usage(lane, this.deps.clock.now(), false);
    if (this.options.recordCostArgv?.length && (snapshot.tokens !== null || snapshot.costUsd !== null)) {
      const result = await this.deps.run(
        fill(this.options.recordCostArgv, {
          key: lane.key,
          session: lane.session ?? "",
          tokens: snapshot.tokens === null ? "null" : String(snapshot.tokens),
          costUsd: snapshot.costUsd === null ? "null" : String(snapshot.costUsd),
          at: snapshot.at,
          closeKey: `${lane.key}@${lane.openedAt}`,
        }),
        { ...(lane.cwd !== undefined ? { cwd: lane.cwd } : {}), timeoutMs: 10_000 },
      );
      if (result.code !== 0) {
        // Kept as a plain reading, so the next close takes a new one and runs the hook again.
        this.record(snapshot);
        throw new Error(`recordCost failed for ${lane.key}: ${result.err}`);
      }
    }
    const final: UsageSnapshot = { ...snapshot, final: true };
    this.record(final);
    return final;
  }
}
