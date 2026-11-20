import { type Lane, sessionOf } from "./registry.ts";
import { ReportError } from "./report-events.ts";
import { Reports } from "./reports.ts";
import { type ReportProvenance, isRequestId, isRunId, provenanceIdentity } from "./request-identity.ts";

type RunContext = { readonly generation: string | undefined; readonly provenance?: ReportProvenance };

/** Resolve the invocation that wrote the report, never the currently displayed lane session. */
export const runContext = (reports: Reports, lane: Lane, runId: string | undefined): RunContext | null => {
  if (lane.requestId === undefined) return { generation: lane.lifecycleEpoch };
  if (!isRequestId(lane.requestId)) throw new ReportError(`invalid original request for ${lane.key}`);
  if (!isRunId(runId)) return null;
  let context: RunContext | null = null;
  for (const event of reports.events(lane.key)) {
    if (event.type !== "execution" || event.runId !== runId) continue;
    if (event.requestId !== lane.requestId) throw new ReportError(`execution request changed for ${lane.key}`);
    if (event.phase === "started") {
      if (context) throw new ReportError(`duplicate execution start for ${lane.key}`);
      context = { generation: event.generation, provenance: { requestId: event.requestId, runId } };
      continue;
    }
    if (!context || context.generation !== event.generation)
      throw new ReportError(`execution binding has no matching start for ${lane.key}`);
    const provenance = { requestId: event.requestId, runId, nativeRef: event.nativeRef };
    if (
      context.provenance?.nativeRef &&
      JSON.stringify(provenanceIdentity(context.provenance)) !== JSON.stringify(provenanceIdentity(provenance))
    )
      throw new ReportError(`execution native reference changed for ${lane.key}`);
    context = { generation: event.generation, provenance };
  }
  return context;
};

/** Called with the producer's same-generation registry guard; the native ID requires verified live readback. */
export const recordExecution = (stateDir: string, lane: Lane, now: number, nativeSessionId?: string): void => {
  if (lane.requestId === undefined) return;
  const { requestId, runId } = lane;
  if (!isRequestId(requestId) || !isRunId(runId)) throw new ReportError(`invalid launch identity for ${lane.key}`);
  const reports = new Reports(stateDir);
  const previous = runContext(reports, lane, runId);
  const common = {
    type: "execution" as const,
    key: lane.key,
    at: new Date(now).toISOString(),
    requestId,
    runId,
    ...(lane.lifecycleEpoch === undefined ? {} : { generation: lane.lifecycleEpoch }),
  };
  if (nativeSessionId === undefined) {
    if (previous) throw new ReportError(`execution already started for ${lane.key}`);
    reports.append({ ...common, phase: "started", text: "Lane execution started; native admission unverified" });
    return;
  }
  const ref = sessionOf(lane);
  if (!previous || previous.generation !== lane.lifecycleEpoch || !nativeSessionId || !ref)
    throw new ReportError(`execution binding has no matching launch for ${lane.key}`);
  const nativeRef = { sessionId: nativeSessionId, ref: { runtime: ref.runtime, id: ref.id } };
  if (
    previous.provenance?.nativeRef &&
    JSON.stringify(provenanceIdentity(previous.provenance)) !==
      JSON.stringify(provenanceIdentity({ requestId, runId, nativeRef }))
  )
    throw new ReportError(`execution native reference changed for ${lane.key}`);
  reports.append({ ...common, phase: "bound", nativeRef, text: "Lane execution native session verified" });
};
