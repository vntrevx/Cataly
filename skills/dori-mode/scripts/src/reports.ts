import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { nextEvidenceSequence } from "./evidence-sequence.ts";
import { type EvidenceRef, isEvidenceRefs, isEvidenceSequence } from "./evidence.ts";
import { LANE_KEY, Registry } from "./registry.ts";

export type ReportKind = "milestone" | "blocker" | "question" | "halted" | "done";
export type ProgressState = "running" | "blocked" | "halted" | "done" | "stalled";
type EventFields = {
  readonly key: string;
  readonly at: string;
  readonly text: string;
  readonly generation?: string;
  /** Selected evidence, independent of the event text and report clock. */
  readonly evidenceRefs?: readonly EvidenceRef[];
  readonly evidenceSequence?: number;
};
export type Report = EventFields & {
  readonly type: "report";
  readonly kind: ReportKind;
};
export type Activity = EventFields & {
  readonly type: "activity";
  readonly state: "running" | "stalled";
};
export type LaneEvent = Report | Activity | (EventFields & { readonly type: "reopen" });
type EventScope = { readonly generation: string | undefined };
export type Progress = {
  readonly state: ProgressState;
  readonly lastReport: Report | null;
  readonly lastEvent: LaneEvent;
  /** Evidence-bearing events, oldest first: with checkpoints, they form one evidence clock. */
  readonly evidenced: readonly LaneEvent[];
};

export class ReportError extends Error {}

export const isReportKind = (value: unknown): value is ReportKind =>
  value === "milestone" || value === "blocker" || value === "question" || value === "halted" || value === "done";

// A question waits on the owner's answer, so it is blocked like a blocker: posted, never nudged.
export const reportState = (kind: ReportKind): ProgressState => {
  switch (kind) {
    case "milestone":
      return "running";
    case "blocker":
      return "blocked";
    case "question":
      return "blocked";
    case "halted":
      return "halted";
    case "done":
      return "done";
  }
};

// The printed line goes to terminals, so escape sequences and other control characters are dropped from it (a CR or
// newline becomes one space); the journal keeps the raw text.
export const reportLine = (report: Report): string =>
  `[REPORT] ${report.key} | ${report.kind} | ${Bun.stripANSI(report.text)
    .replace(/\s*[\r\n]+\s*/g, " ")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the pattern deliberately matches control characters to reject or strip them
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")}`;

export const parseEvent = (line: string, key: string): LaneEvent => {
  const value: unknown = JSON.parse(line);
  if (
    typeof value !== "object" ||
    value === null ||
    !("key" in value) ||
    value.key !== key ||
    !("at" in value) ||
    typeof value.at !== "string" ||
    !Number.isFinite(Date.parse(value.at)) ||
    !("text" in value) ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    !("type" in value) ||
    ("generation" in value && typeof value.generation !== "string")
  ) {
    throw new ReportError(`invalid report record for ${key}`);
  }
  const evidenceRefs = "evidenceRefs" in value ? value.evidenceRefs : undefined;
  if (evidenceRefs !== undefined && !isEvidenceRefs(evidenceRefs))
    throw new ReportError(`invalid report evidenceRefs for ${key}`);
  const evidenceSequence = "evidenceSequence" in value ? value.evidenceSequence : undefined;
  if (evidenceSequence !== undefined && !isEvidenceSequence(evidenceSequence))
    throw new ReportError(`invalid report evidenceSequence for ${key}`);
  const common = {
    key,
    at: value.at,
    text: value.text,
    ...(evidenceRefs !== undefined ? { evidenceRefs } : {}),
    ...(evidenceSequence !== undefined ? { evidenceSequence } : {}),
    ...("generation" in value && typeof value.generation === "string" ? { generation: value.generation } : {}),
  };
  if (value.type === "reopen") return { ...common, type: "reopen" };
  if (value.type === "report" && "kind" in value && isReportKind(value.kind)) {
    return { ...common, type: "report", kind: value.kind };
  }
  if (value.type === "activity" && "state" in value && (value.state === "running" || value.state === "stalled")) {
    return { ...common, type: "activity", state: value.state };
  }
  throw new ReportError(`invalid report kind or activity state for ${key}`);
};

// One O_APPEND write per event: concurrent lane/lead writers cannot overwrite
// each other's state. The last event is the persisted progress state; no
// second mutable snapshot can race with this journal or registry done claims.
export class Reports {
  constructor(readonly stateDir: string) {}

  path(key: string): string {
    if (!LANE_KEY.test(key)) throw new ReportError(`invalid lane key: ${key}`);
    return join(this.stateDir, "lanes", key, "reports.jsonl");
  }

  // With no scope, inspect the raw journal. An explicit undefined generation selects only legacy records.
  read(key: string, scope?: EventScope): Progress | null {
    const path = this.path(key);
    if (!existsSync(path)) return null;
    let progress: Progress | null = null;
    let lastReport: Report | null = null;
    const evidenced: LaneEvent[] = [];
    for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      let event: LaneEvent;
      try {
        event = parseEvent(line, key);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof ReportError)) throw error;
        throw new ReportError(`${path}:${index + 1}: ${error.message}`);
      }
      if (scope && event.generation !== scope.generation) continue;
      if (event.evidenceRefs?.length) evidenced.push(event);
      if (event.type === "reopen") {
        lastReport = null;
        progress = { state: "running", lastReport, lastEvent: event, evidenced };
      } else if (event.type === "report") {
        lastReport = event;
        progress = { state: reportState(event.kind), lastReport: event, lastEvent: event, evidenced };
      } else if (!progress || progress.state === "running" || progress.state === "stalled") {
        progress = { state: event.state, lastReport, lastEvent: event, evidenced };
      }
    }
    return progress;
  }

  append(event: Report, beforeAppend?: () => void): Promise<Report>;
  append(event: Activity, beforeAppend?: () => void): Promise<Activity>;
  append(event: LaneEvent, beforeAppend?: () => void): Promise<LaneEvent>;
  async append(event: LaneEvent, beforeAppend?: () => void): Promise<LaneEvent> {
    const path = this.path(event.key);
    parseEvent(JSON.stringify(event), event.key);
    const dir = join(this.stateDir, "lanes", event.key);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only on creation; a directory made earlier with wider permissions is narrowed here.
    chmodSync(dir, 0o700);
    const commit = (): LaneEvent => {
      // Inspect the accepted prefix synchronously under the same evidence-writer lock as this append.
      beforeAppend?.();
      const recorded = event.evidenceRefs?.length
        ? { ...event, evidenceSequence: nextEvidenceSequence(this.stateDir, event.key) }
        : event;
      appendFileSync(path, `${JSON.stringify(recorded)}\n`, { encoding: "utf8", mode: 0o600 });
      return recorded;
    };
    // Only evidence participates in the cross-journal order; ordinary reports keep their uncontended append path.
    return event.evidenceRefs?.length ? new Registry(this.stateDir).locked(event.key, commit) : commit();
  }

  async report(
    key: string,
    kind: ReportKind,
    text: string,
    now: number,
    generation?: string,
    evidenceRefs: readonly EvidenceRef[] = [],
    beforeAppend?: () => void,
  ): Promise<Report> {
    const report: Report = {
      type: "report",
      key,
      kind,
      text: text.trim(),
      at: new Date(now).toISOString(),
      ...(evidenceRefs.length ? { evidenceRefs } : {}),
      ...(generation === undefined ? {} : { generation }),
    };
    return this.append(report, beforeAppend);
  }

  async observe(
    key: string,
    screen: string,
    now: number,
    staleAfterMs: number,
    resumeOnWorking = true,
    scope?: EventScope,
  ): Promise<Progress | null> {
    const progress = this.read(key, scope);
    if (!progress || (progress.state !== "running" && progress.state !== "stalled")) return progress;
    const visible = Bun.stripANSI(screen);
    const lastAt = (pattern: RegExp): number => {
      let at = -1;
      for (const match of visible.matchAll(pattern)) at = match.index;
      return at;
    };
    const workingAt = lastAt(/^\s*[^\w\n]*(?:Working|Running)\b/gim);
    const working = workingAt >= 0;
    // A failure counts only when no Working line follows it: an old error left on screen above a recovered lane is history.
    const failed =
      lastAt(
        /compaction (?:failed|failure|error)|failed to compact|error (?:during|in) compaction|auto-?compaction failed/gi,
      ) > workingAt;
    const idle = /^\s*[❯>]\s*$/m.test(visible);
    const stale = now - Date.parse(progress.lastReport?.at ?? progress.lastEvent.at) >= staleAfterMs;
    const state =
      failed || (idle && !working && stale) ? "stalled" : working && resumeOnWorking ? "running" : progress.state;
    if (state === progress.state) return progress;
    const { generation } = progress.lastEvent;
    const event: Activity = {
      type: "activity",
      key,
      at: new Date(now).toISOString(),
      state,
      ...(generation === undefined ? {} : { generation }),
      text: failed
        ? "compaction failed"
        : state === "stalled"
          ? "idle prompt without Working or a fresh report"
          : "Working activity resumed",
    };
    await this.append(event);
    return this.read(key, scope);
  }
}
