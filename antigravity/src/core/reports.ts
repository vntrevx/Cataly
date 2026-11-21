import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonlLine, stripAnsi } from "./fs-utils.js";
import { LANE_KEY_PATTERN } from "./lessons.js";

export type ReportKind = "milestone" | "blocker" | "question" | "halted" | "done";
export type ProgressState = "running" | "blocked" | "halted" | "done" | "stalled";

export type Report = {
  readonly type: "report";
  readonly key: string;
  readonly at: string;
  readonly kind: ReportKind;
  readonly text: string;
};

export type Activity = {
  readonly type: "activity";
  readonly key: string;
  readonly at: string;
  readonly state: "running" | "stalled";
  readonly text: string;
};

export type LaneEvent = Report | Activity;

export type Progress = {
  readonly state: ProgressState;
  readonly lastReport: Report | null;
  readonly lastEvent: LaneEvent;
  readonly count: number;
};

export class ReportError extends Error {}

export const isReportKind = (value: unknown): value is ReportKind =>
  value === "milestone" || value === "blocker" || value === "question" || value === "halted" || value === "done";

export const reportState = (kind: ReportKind): ProgressState => {
  switch (kind) {
    case "milestone":
      return "running";
    case "blocker":
    case "question":
      return "blocked";
    case "halted":
      return "halted";
    case "done":
      return "done";
  }
};

export const formatReportLine = (report: Report): string =>
  `[REPORT] ${report.key} | ${report.kind} | ${stripAnsi(report.text)
    .replace(/\s*[\r\n]+\s*/g, " ")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")}`;

export class Reports {
  constructor(readonly stateDir: string) {}

  path(key: string): string {
    if (!LANE_KEY_PATTERN.test(key)) throw new ReportError(`invalid lane key: ${key}`);
    return join(this.stateDir, "lanes", key, "reports.jsonl");
  }

  list(key: string, limit = 50): LaneEvent[] {
    const filePath = this.path(key);
    if (!existsSync(filePath)) return [];
    const events: LaneEvent[] = [];
    for (const [index, line] of readFileSync(filePath, "utf8").split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as LaneEvent;
        if (parsed.key !== key || typeof parsed.text !== "string" || !parsed.text.trim()) {
          throw new ReportError("malformed report entry");
        }
        events.push(parsed);
      } catch (error) {
        throw new ReportError(`${filePath}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return limit > 0 ? events.slice(-limit) : events;
  }

  readProgress(key: string): Progress | null {
    const events = this.list(key, 0);
    if (events.length === 0) return null;
    let progress: Progress | null = null;
    let lastReport: Report | null = null;
    for (const event of events) {
      if (event.type === "report") {
        lastReport = event;
        progress = { state: reportState(event.kind), lastReport: event, lastEvent: event, count: events.length };
      } else if (!progress || progress.state === "running" || progress.state === "stalled") {
        progress = { state: event.state, lastReport, lastEvent: event, count: events.length };
      }
    }
    return progress;
  }

  report(key: string, kind: ReportKind, text: string, now = Date.now()): Report {
    if (!LANE_KEY_PATTERN.test(key)) throw new ReportError(`invalid lane key: ${key}`);
    if (!isReportKind(kind)) throw new ReportError(`invalid report kind: ${String(kind)}`);
    const trimmed = text.trim();
    if (!trimmed) throw new ReportError("report text must not be empty");
    const entry: Report = {
      type: "report",
      key,
      at: new Date(now).toISOString(),
      kind,
      text: trimmed,
    };
    appendJsonlLine(this.path(key), entry);
    return entry;
  }
}
