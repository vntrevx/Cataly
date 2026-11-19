import { resolve } from "node:path";
import { readSourceBundle } from "../../../../src/release/source-bundle.ts";
import { type BootLane, finished } from "./boot-monitors.ts";
import type { DoctorFinding } from "./doctor.ts";
import type { FlowDeps } from "./done-flow.ts";
import { exactModelIdentity, type PaneState } from "./lane-state.ts";
import { sessionOf } from "./registry.ts";
import { runtimesOf } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";

const identity = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw["provider"] === "string" && raw["provider"] && typeof raw["id"] === "string" && raw["id"]
    ? `${raw["provider"]}/${raw["id"]}`
    : undefined;
};

const modelFinding = (label: string, state: PaneState | null, expected?: string): DoctorFinding => {
  const unknown = (reason: string, severity: DoctorFinding["severity"] = "INFO"): DoctorFinding => ({
    check: "model",
    severity,
    detail: `${label} status=unknown observed=unknown; ${reason}`,
    provenance: "no trusted native model observation",
    next: "Inspect the selected model in this native session; do not infer it from configuration.",
  });
  if (!state) return unknown("no matching live session/PID ownership");
  const value: unknown = state.modelReadback;
  if (!value || typeof value !== "object") return unknown("modelReadback is absent or invalid");
  const raw = value as Record<string, unknown>;
  const requested = identity(raw["requested"]);
  const observed = identity(raw["observed"]);
  const requestedKey = requested?.toLowerCase();
  const observedKey = observed?.toLowerCase();
  const status = raw["status"];
  const billing = raw["billing"];
  const checkedAt = raw["checkedAt"];
  const reason = raw["reason"];
  if (
    raw["source"] !== "native-extension" ||
    (reason !== undefined && typeof reason !== "string") ||
    requested === undefined ||
    observed === undefined ||
    typeof status !== "string" ||
    !["matched", "mismatch", "unavailable", "unknown", "unrequested"].includes(status) ||
    typeof billing !== "string" ||
    !["subscription", "non-subscription", "unknown"].includes(billing) ||
    typeof checkedAt !== "string" ||
    !Number.isFinite(Date.parse(checkedAt)) ||
    Date.parse(checkedAt) < Date.parse(state.startedAt) ||
    (status === "matched" && (!requested || requestedKey !== observedKey)) ||
    (status === "mismatch" && (!requested || !observed || requested === observed)) ||
    (status === "unrequested" && (requested !== null || !observed)) ||
    (status === "unavailable" && !requested)
  )
    return unknown("modelReadback does not match its session or status contract");
  const exactRequest = expected !== undefined && exactModelIdentity(expected) !== null;
  const legacyRequest = expected !== undefined && !exactRequest;
  if (exactRequest && status !== "unrequested" && status !== "unknown" && requestedKey !== expected?.toLowerCase())
    return unknown(
      `recorded request differs: lane=${JSON.stringify(expected)} native=${JSON.stringify(requested)}`,
      "WARN",
    );
  return {
    check: "model",
    severity: status === "matched" ? (legacyRequest ? "INFO" : "OK") : status === "unrequested" ? "INFO" : "WARN",
    detail:
      label +
      " status=" +
      status +
      " requested=" +
      (requested ?? "none") +
      " observed=" +
      (observed ?? "unknown") +
      " billing=" +
      billing +
      (reason === undefined ? "" : `; reason=${JSON.stringify(reason)}`) +
      "; billing is not spending authorization or quota evidence" +
      (status === "unrequested" && expected !== undefined
        ? `; recorded request=${JSON.stringify(expected)}; request comparison=unrequested (not native launch verification)`
        : legacyRequest
          ? `; recorded request=${JSON.stringify(expected)}; request comparison=unknown (not exact provider/id)`
          : ""),
    provenance: `native-extension session=${JSON.stringify(state.sessionId)} pid=${state.pid} checkedAt=${checkedAt}`,
    next:
      status === "matched"
        ? "Verify spending authorization separately before model work."
        : status === "unrequested"
          ? "Compare the recorded launch choice separately; an unrequested observation is not launch verification."
          : "Inspect the exact requested provider/model in this session; do not automatically substitute it.",
  };
};

const preflightFinding = (lane: BootLane): DoctorFinding | null => {
  if (!("modelReadback" in lane)) return null;
  const unknown: DoctorFinding = {
    check: "model",
    severity: "INFO",
    detail: `lane=${JSON.stringify(lane.key)} preflight status=unknown observed=unknown; invalid launch receipt`,
    provenance: "untrusted lane registry receipt; not a native model observation",
    next: "Inspect the launch receipt and the separate live native model observation.",
  };
  const value: unknown = lane.modelReadback;
  if (!value || typeof value !== "object") return unknown;
  const raw = value as Record<string, unknown>;
  const requested = identity(raw["requested"]);
  const checkedAt = raw["checkedAt"];
  const reason = raw["reason"];
  if (
    raw["source"] !== "launch-preflight" ||
    raw["status"] !== "unavailable" ||
    raw["observed"] !== null ||
    raw["billing"] !== "unknown" ||
    requested === undefined ||
    typeof reason !== "string" ||
    !reason.trim() ||
    typeof checkedAt !== "string" ||
    !Number.isFinite(Date.parse(checkedAt)) ||
    (lane.model !== undefined &&
      exactModelIdentity(lane.model) !== null &&
      requested?.toLowerCase() !== lane.model.toLowerCase())
  )
    return unknown;
  return {
    check: "model",
    severity: "INFO",
    detail:
      "lane=" +
      JSON.stringify(lane.key) +
      " preflight status=unavailable requested=" +
      (requested ?? "none") +
      " observed=unknown billing=unknown; compatibility launch was not model-verified; reason=" +
      JSON.stringify(reason) +
      (requested === null && lane.model !== undefined
        ? `; recorded request=${JSON.stringify(lane.model)}; request comparison=unknown (not exact provider/id)`
        : ""),
    provenance: `launch-preflight historical registry receipt checkedAt=${checkedAt}; not a native model observation`,
    next: "Inspect the separate native observation; this receipt is neither launch verification nor spending authorization.",
  };
};

/** Local lock declarations and live extension observations, not login, catalog or model probes. */
export const doctorProvenance = async (
  deps: Pick<FlowDeps, "run" | "registry" | "config" | "clock" | "rts" | "env">,
  lanes: readonly BootLane[],
  lead: PaneState | null,
): Promise<DoctorFinding[]> => {
  const findings: DoctorFinding[] = [];
  const source = resolve(import.meta.dir, "../../../..");
  for (const native of [true, false]) {
    const name = native ? "native-omp" : "omp-ulw.overlay";
    try {
      const bundle = readSourceBundle(source, native);
      findings.push({
        check: "source",
        severity: "INFO",
        detail:
          "CLI source " +
          name +
          (native ? ` nativeVersion=${bundle.lock.nativeVersion}` : "") +
          " upstreamRevision=" +
          bundle.lock.commit +
          " identity=" +
          bundle.identity +
          "; running revision is not attested by this lock",
        provenance: `${name}.lock and patch digest in the loaded CLI checkout`,
        next: "Inspect the selected executable and live process before claiming runtime compatibility.",
      });
    } catch {
      findings.push({
        check: "source",
        severity: "WARN",
        detail: `CLI source ${name} identity=unknown; lock/patch validation failed`,
        provenance: `${name}.lock in the loaded CLI checkout`,
        next: "Inspect the installed source bundle lock and matching patch.",
      });
    }
  }
  findings.push({
    check: "model",
    severity: "INFO",
    detail: `configured defaultModel=${JSON.stringify(deps.config.defaultModel)}; requested default, not native selection`,
    provenance: "effective Dori configuration",
    next: "Compare the native observation below with the intended provider/model.",
  });
  findings.push(modelFinding("lead", lead));
  const rts = runtimesOf(deps);
  for (const lane of lanes.filter((lane) => !finished(lane))) {
    const ref = sessionOf(lane);
    let live: PaneState | null = null;
    if (ref && lane.session) {
      try {
        live = await trustedPaneState(deps.run, deps.config.stateDir, ref, rts);
        if (live?.role !== "lane" || live.sessionId !== lane.session) live = null;
      } catch {
        live = null;
      }
    }
    findings.push(modelFinding(`lane=${JSON.stringify(lane.key)}`, live, lane.model));
    const preflight = preflightFinding(lane);
    if (preflight) findings.push(preflight);
  }
  const env = deps.env ?? process.env;
  for (const key of ["DORI_DISCORD_TOKEN", "DORI_TELEGRAM_TOKEN", "DORI_SLACK_TOKEN", "DORI_SLACK_TOKEN_FILE"]) {
    findings.push({
      check: "credentials",
      severity: "INFO",
      detail: `${key}=${env[key] ? "present" : "absent"}; account identity=unknown; child-local credentials may differ`,
      provenance: "doctor process environment; presence only, no credential value or file contents read",
      next: "Inspect credentials in the explicitly authorized messenger child, without publishing their values.",
    });
  }
  return findings;
};
