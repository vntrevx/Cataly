import type { LaneEvent, ReportKind } from "./reports.ts";
import { isNativeReference, isProvenance, isRequestId, isRunId } from "./request-identity.ts";

export class ReportError extends Error {}

export const isReportKind = (value: unknown): value is ReportKind =>
  value === "milestone" || value === "blocker" || value === "question" || value === "halted" || value === "done";

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
    ("generation" in value && typeof value.generation !== "string") ||
    ("provenance" in value && !isProvenance(value.provenance))
  ) {
    throw new ReportError(`invalid report record for ${key}`);
  }
  const common = {
    key,
    at: value.at,
    text: value.text,
    ...("generation" in value && typeof value.generation === "string" ? { generation: value.generation } : {}),
    ...("provenance" in value && isProvenance(value.provenance) ? { provenance: value.provenance } : {}),
  };
  if (value.type === "execution") {
    if (
      !("requestId" in value) ||
      !isRequestId(value.requestId) ||
      !("runId" in value) ||
      !isRunId(value.runId) ||
      !("phase" in value) ||
      "provenance" in value
    )
      throw new ReportError(`invalid execution record for ${key}`);
    const execution = { ...common, type: "execution" as const, requestId: value.requestId, runId: value.runId };
    if (value.phase === "started" && !("nativeRef" in value)) return { ...execution, phase: "started" };
    if (value.phase === "bound" && "nativeRef" in value && isNativeReference(value.nativeRef))
      return { ...execution, phase: "bound", nativeRef: value.nativeRef };
    throw new ReportError(`invalid execution binding for ${key}`);
  }
  if (value.type === "reopen") return { ...common, type: "reopen" };
  if (value.type === "report" && "kind" in value && isReportKind(value.kind)) {
    if ("owner" in value && (typeof value.owner !== "string" || !value.owner.trim()))
      throw new ReportError(`invalid owner summary for ${key}`);
    return {
      ...common,
      type: "report",
      kind: value.kind,
      ...("owner" in value ? { owner: value.owner as string } : {}),
    };
  }
  if (value.type === "activity" && "state" in value && (value.state === "running" || value.state === "stalled")) {
    return { ...common, type: "activity", state: value.state };
  }
  throw new ReportError(`invalid report kind or activity state for ${key}`);
};
