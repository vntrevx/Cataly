import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { Checkpoints } from "./checkpoints.ts";
import { fill } from "./config.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { discoverFiles } from "./evidence-window.ts";
import { sameLaneGeneration } from "./registry.ts";
import { Reports } from "./reports.ts";
import {
  observationText,
  prepareWindow,
  readUsage,
  type SupervisedLane,
  type SupervisionDeps,
  type SupervisionOptions,
  type SupervisionResult,
  type UsageSnapshot,
  workingTimer,
} from "./supervision-observe.ts";
import { judgeSweep, recheckQuiet } from "./supervision-verdict.ts";

const NOT_OBSERVED: SupervisionResult = {
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

  private costPath(key: string): string {
    return join(dirname(this.reports.path(key)), "cost.jsonl");
  }

  private statePath(key: string): string {
    return join(dirname(this.reports.path(key)), "supervision.json");
  }

  private record(snapshot: UsageSnapshot): void {
    const path = this.costPath(snapshot.key);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
  }

  /**
   * Runs `fn` under the lane's delivery lock while the registry still holds this generation of the lane and, given a
   * basis, the stored state is still the text this sweep prepared over; else null, and the sweep's candidate is
   * dropped whole for the next sweep to redo. Without a registry there is no lock and no generation to check.
   */
  private async locked<T>(
    lane: SupervisedLane,
    basis: string | null | undefined,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const guarded = () => (basis === undefined || observationText(this.statePath(lane.key)) === basis ? fn() : null);
    const deps = this.deps;
    if (deps.registry === undefined) return guarded();
    const held = await withDeliveryLock(deps, lane.key, async () => {
      const current = await deps.registry.read(lane.key);
      return current && !current.nativeCloseIntent && sameLaneGeneration(lane, current) ? guarded() : null;
    });
    return held.ok ? held.value : null;
  }

  /**
   * Prepare, observe, commit. Observation commands and watched-file stats and hashes never run under the delivery lock;
   * the plan and every record are written under it, each in the generation the sweep began with. A sweep whose
   * generation or prepared state changed before its commit records nothing, usage included.
   */
  async sweep(lane: SupervisedLane, screen: string): Promise<SupervisionResult> {
    if (!this.enabled(lane)) return NOT_OBSERVED;
    const now = this.deps.clock.now();
    const path = this.statePath(lane.key);
    // Finish external usage before discovering files, so its await cannot hide new candidates from this sweep.
    const usage = await readUsage(this.deps.run, this.options.usageArgv, lane, now);
    const discovery = await discoverFiles(this.deps.run, this.options, this.reports.stateDir, lane);
    const prepared = await this.locked(lane, undefined, async () => prepareWindow(path, lane, discovery));
    if (!prepared) return NOT_OBSERVED;
    const read = { lane, now, timer: workingTimer(screen), usage, previous: prepared.previous, ...prepared.observe() };
    const judging = {
      reports: this.reports,
      checkpoints: this.checkpoints,
      options: this.options,
      clock: this.deps.clock,
    };
    const recheck = recheckQuiet(judging, read);
    const settled = await this.locked(lane, prepared.basis, async () => {
      // Without a hook, only close records the final unknown reading.
      if (this.options.usageArgv?.length) this.record(usage);
      const verdict = await judgeSweep(judging, read, recheck);
      // Preserve delivery serialization with park/reopen: only observation I/O moved outside this lock. Deliver before
      // saving so a failed callback is retried next sweep rather than recorded as sent.
      const undelivered = new Map<string, string>();
      for (const message of verdict.freshAlerts) {
        try {
          await this.deps.alert?.(lane, message);
        } catch (error) {
          undelivered.set(message, error instanceof Error ? error.message : String(error));
        }
      }
      const result = await verdict.settle(undelivered, path);
      if (undelivered.size)
        throw new Error(
          `alert delivery failed for ${lane.key}: ${[...undelivered].map(([message, why]) => `${message} (${why})`).join("; ")}`,
        );
      return result;
    });
    return settled ?? NOT_OBSERVED;
  }

  async close(lane: SupervisedLane): Promise<UsageSnapshot | null> {
    if (!this.enabled(lane)) return null;
    // Record each openedAt generation once; retries reuse the final reading and stable {closeKey}.
    const path = this.costPath(lane.key);
    const recorded = existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => JSON.parse(line) as UsageSnapshot)
          .findLast(
            (entry) =>
              entry.final === true &&
              (entry.openedAt === lane.openedAt ||
                (entry.openedAt === undefined && Date.parse(entry.at) >= Date.parse(lane.openedAt))),
          )
      : undefined;
    if (recorded) return recorded;
    const snapshot = await readUsage(this.deps.run, this.options.usageArgv, lane, this.deps.clock.now());
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
