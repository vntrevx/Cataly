import { existsSync } from "node:fs";

import { fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { anchoredReportLine } from "./freshness-report.ts";
import { checkPausedLane } from "./pause.ts";
import { runtimesOf } from "./run.ts";
import { readScreen } from "./sessions.ts";
import { tellLane } from "./tell.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";
import { type Progress, ReportError, reportLine, Reports } from "./reports.ts";
import { Supervision, type SupervisionResult } from "./supervision.ts";

export const scrubForThread = (line: string, home: string): string =>
  line
    .replace(/^\[REPORT\]\s*[^|]*\|\s*[^|]*\|\s*/, "")
    .split(home)
    .join("~")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .replace(/\bw\w+:p\w+\b/g, "(pane)")
    .replace(/`/g, "'")
    .trim();

export type SweepAct = {
  readonly kind:
    | "nudged"
    | "held"
    | "delivery-error"
    | "posted"
    | "no-report"
    | "post-failed"
    | "pending-report"
    | "stale-report"
    | "working-while-paused"
    | "stalled"
    | "journal-error"
    | "blocked"
    | "warning"
    | "supervision-error";
  readonly lane: string;
  readonly detail: string;
};

// A broken delivery store cannot reliably persist notification bookkeeping. Reset this cache with the sweep process.
const deliveryErrors = new WeakMap<FlowDeps, Map<string, string>>();

const lastHeard = (lane: Lane): number => lane.lastReplyAt ?? Date.parse(lane.openedAt);

/** Records the sweep's own fields on the lane as stored now, so a claim, objection or pause written meanwhile stays. */
const remember = (deps: FlowDeps, key: string, patch: Partial<Lane>) =>
  deps.registry.update(key, (current) => current && { ...current, ...patch });

export const freshnessTick = async (deps: FlowDeps, home: string): Promise<SweepAct[]> => {
  const acts: SweepAct[] = [];
  const errors = deliveryErrors.get(deps) ?? new Map<string, string>();
  deliveryErrors.set(deps, errors);
  const now = deps.clock.now();
  const reports = new Reports(deps.config.stateDir);
  const supervision = new Supervision({ ...deps, stateDir: deps.config.stateDir, reports }, deps.config.supervision);
  for (const lane of await deps.registry.open()) {
    if (statusOf(lane) === "paused") {
      const checked = await checkPausedLane(deps, lane);
      // Reported once per working stretch (the note clears when the lane goes idle), so the lead can ask; it stays paused.
      if (
        checked &&
        checked.lane.lastFreshnessNote !== "working-while-paused" &&
        (await deps.registry.transition(checked.lane, (current) => ({
          ...current,
          lastFreshnessNote: "working-while-paused",
        })))
      ) {
        acts.push({
          kind: "working-while-paused",
          lane: lane.key,
          detail: "paused lane is working on two ticks; left paused (resume is dori resume only)",
        });
      }
      continue;
    }
    const ref = sessionOf(lane);
    if (statusOf(lane) !== "working" || !ref) continue;
    // Only launched lanes report through the journal; an adopted lane keeps the screen path even if a record exists.
    let previous: Progress | null = null;
    let progress: Progress | null = null;
    let supervisedHung = false;
    if (lane.reportProtocol === "jsonl-v1") {
      try {
        previous = reports.read(lane.key);
        const screen = await readScreen(runtimesOf(deps), ref);
        let supervised: SupervisionResult | null = null;
        try {
          // A launched lane is supervised once its journal exists; without one there is no progress to judge.
          if (existsSync(reports.path(lane.key))) supervised = await supervision.sweep(lane, screen);
        } catch (error) {
          // Supervision is advisory: its failure is printed once per reason, and the lane's reports still flow.
          const detail = error instanceof Error ? error.message : String(error);
          if (detail !== lane.lastSupervisionError) {
            acts.push({ kind: "supervision-error", lane: lane.key, detail });
            await remember(deps, lane.key, { lastSupervisionError: detail });
          }
        }
        if (supervised && lane.lastSupervisionError)
          await remember(deps, lane.key, { lastSupervisionError: undefined });
        for (const detail of supervised?.alerts ?? []) {
          acts.push({
            kind: supervised?.state === "blocked" ? "blocked" : supervised?.state === "stalled" ? "stalled" : "warning",
            lane: lane.key,
            detail,
          });
        }
        // Only supervision's own hung result replaces the stall line below; a usage warning is not a stall.
        supervisedHung = supervised?.hung ?? false;
        progress = reports.observe(lane.key, screen, now, deps.config.nudgeAfterMin * 60_000, !supervised?.hung);
      } catch (error) {
        // One corrupt journal skips its own lane, printed once per error, and never ends the sweep for the others.
        if (!(error instanceof ReportError)) throw error;
        const note = `journal-error|${error.message}`;
        if (note !== lane.lastFreshnessNote) {
          acts.push({ kind: "journal-error", lane: lane.key, detail: error.message });
          await remember(deps, lane.key, { lastFreshnessNote: note });
        }
        continue;
      }
    }
    if (progress?.state === "stalled" && previous?.state !== "stalled" && !supervisedHung) {
      acts.push({ kind: "stalled", lane: lane.key, detail: progress.lastEvent.text });
    }
    if (progress?.state === "stalled") continue;
    // A blocker, question, halted or done lane is not nudged, but its report still reaches the thread.
    const running = !progress || progress.state === "running";
    const heard = Math.max(lastHeard(lane), progress?.lastReport ? Date.parse(progress.lastReport.at) : 0);
    const silentMin = Math.round((now - heard) / 60_000);
    let current = lane;
    if (running && silentMin >= deps.config.nudgeAfterMin && (current.lastNudgeAt ?? 0) < heard) {
      try {
        const delivery = await tellLane(
          deps,
          lane,
          `[LEAD] your work thread has had no update for ${silentMin} min. Post a 1-2 sentence progress line (done since last, next) and keep its status true.`,
          { waitMs: 0 },
        );
        await remember(deps, lane.key, { lastNudgeAt: now });
        errors.delete(lane.key);
        acts.push({ kind: delivery.code === 2 ? "held" : "nudged", lane: lane.key, detail: delivery.line });
      } catch (error) {
        const detail = `${error instanceof Error ? error.message : String(error)}; inspect dori tell ${lane.key} --status and the original session; do not resend`;
        const signature = `${lane.openedAt}|${detail}`;
        if (errors.get(lane.key) !== signature) {
          errors.set(lane.key, signature);
          acts.push({ kind: "delivery-error", lane: lane.key, detail });
        }
      }
    }
    const hook = deps.config.hooks.threadReply;
    // The post waits for the thread to be quiet, not the lane: a report resets the nudge clock only, so a lane that
    // reports often still gets its latest report posted, at most once per postAfterMin.
    const threadQuietMin = Math.round((now - Math.max(lastHeard(lane), lane.lastAutoReplyAt ?? 0)) / 60_000);
    // A report stamped in the same millisecond as the last post still counts (<=); lastPostedReport stops a repeat.
    if (
      threadQuietMin >= deps.config.postAfterMin &&
      hook &&
      lane.thread !== "none" &&
      (current.lastAutoReplyAt ?? 0) <= heard
    ) {
      // A journal report is durable, so it skips the two-tick hold; a screen-scraped line counts only once it is still
      // there on the next tick (the two reads are a full loop interval apart).
      const fromJournal = progress?.lastReport ? reportLine(progress.lastReport) : null;
      const report =
        fromJournal ??
        (lane.reportProtocol === "jsonl-v1"
          ? null
          : anchoredReportLine(await readScreen(runtimesOf(deps), ref, 200), lane.key));
      const seenBefore = current.lastSeenReport;
      current = { ...current, lastSeenReport: report ?? undefined };
      let hold: { kind: SweepAct["kind"]; detail: string } | null = null;
      if (!report)
        hold = {
          kind: "no-report",
          detail: lane.reportProtocol === "jsonl-v1" ? "report journal has no report" : "pane has no [REPORT] line",
        };
      else if (!fromJournal && report !== seenBefore)
        hold = { kind: "pending-report", detail: "a new [REPORT] line; posting once it holds on the next tick" };
      else if (report === current.lastPostedReport)
        hold = { kind: "stale-report", detail: "the last [REPORT] line was already posted" };
      if (hold) {
        const note = `${hold.kind}|${hold.detail}|${report ?? ""}`;
        if (note !== current.lastFreshnessNote) acts.push({ kind: hold.kind, lane: lane.key, detail: hold.detail });
        await remember(deps, lane.key, { lastSeenReport: current.lastSeenReport, lastFreshnessNote: note });
        continue;
      }
      const text = `Progress (from the lane's last report): ${scrubForThread(report ?? "", home)}`;
      const sent = await deps.run(fill(hook, { thread: lane.thread, text, key: lane.key }));
      // Only a delivered report counts as posted: a failed hook leaves it unposted, so the next tick sends it again. Like
      // a held-back report, the same failure is printed once, not on every retry.
      if (sent.code !== 0) {
        const detail = `thread hook failed (exit ${sent.code})`;
        const note = `post-failed|${detail}|${report}`;
        if (note !== current.lastFreshnessNote) acts.push({ kind: "post-failed", lane: lane.key, detail });
        await remember(deps, lane.key, { lastSeenReport: current.lastSeenReport, lastFreshnessNote: note });
        continue;
      }
      await remember(deps, lane.key, {
        lastSeenReport: current.lastSeenReport,
        lastAutoReplyAt: now,
        lastPostedReport: report ?? undefined,
        lastFreshnessNote: undefined,
      });
      acts.push({ kind: "posted", lane: lane.key, detail: text });
    }
  }
  return acts;
};
