import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelSwitchReceipt } from "./model-switch-state.ts";

/**
 * Per-pane state written by the omp-dori extension from inside a Dori or lane session and read by the `dori` CLI.
 * omp exposes no session id in argv or the environment and no goal readback on screen that dori can trust, so the
 * session reports itself here. One file per herdr pane or hc terminal; the extension is the only writer.
 */
export type DoriRole = "dori" | "lane";
export type GoalStatus = "none" | "active" | "paused" | "complete" | "dropped" | "blocked";

export interface ModelReadback {
  readonly requested: { readonly provider: string; readonly id: string } | null;
  readonly observed: { readonly provider: string; readonly id: string } | null;
  readonly status: "matched" | "mismatch" | "unavailable" | "unknown" | "unrequested";
  readonly billing: "subscription" | "non-subscription" | "unknown";
  readonly checkedAt: string;
  readonly source: "native-extension" | "launch-preflight";
  readonly reason?: string;
}

/** One native observation, replaced only by an explicit idle lane-model change. */
export interface ModelSnapshot {
  readonly version: 1;
  readonly id: string;
  readonly model: NonNullable<ModelReadback["observed"]>;
  readonly modelRoles: Readonly<Record<string, string>>;
  readonly defaultThinkingLevel: string;
  /** The native selection, including auto; its resolved per-turn level is only an observation below. */
  readonly configuredThinkingLevel: string | null;
  /** null is the native session's unset level, not an inferred default. */
  readonly thinkingLevel: string | null;
  readonly capturedAt: string;
  readonly provenance: {
    readonly kind: "launch" | "idle-switch";
    readonly requested: string;
    readonly modelRoles: Readonly<Record<string, "env" | "runtime" | "overlay" | "project" | "global" | "default">>;
    readonly defaultThinkingLevel: "env" | "runtime" | "overlay" | "project" | "global" | "default";
  };
}

export type PaneState = {
  readonly paneId: string;
  readonly role: DoriRole;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly cwd: string;
  readonly pid: number;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly goal: { readonly status: GoalStatus; readonly objective?: string };
  /** A tool approval prompt is open in this session: never type into the pane. */
  readonly approvalPending: boolean;
  /** Last native agent lifecycle event; absent in older records, independent of goal status. */
  readonly agentStatus?: "idle" | "working";
  /** Native catalog and selected-model agreement, never billing authorization or a quota balance. */
  readonly modelReadback?: ModelReadback;
  readonly modelSnapshot?: ModelSnapshot;
  readonly modelProfileFile?: string;
  /** A saved selection exists but cannot safely govern this native session. */
  readonly modelSnapshotError?: string;
  /** This process's receipt for the last `/dori-model-apply` nonce it claimed; validated where read. */
  readonly modelSwitch?: ModelSwitchReceipt;
};

/** The native catalog distinguishes literal colon-tagged ids from thinking suffixes. */
export const exactModelIdentity = (value: string): ModelReadback["requested"] => {
  const match = /^([a-zA-Z0-9][a-zA-Z0-9._-]*)\/([^\s*,]+)$/.exec(value);
  return match?.[1] && match[2] ? { provider: match[1], id: match[2] } : null;
};

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const MODEL_PROVENANCE: ReadonlySet<unknown> = new Set(["env", "runtime", "overlay", "project", "global", "default"]);

/** Session entries and pane JSON are input boundaries; a malformed latest snapshot never falls back to an old one. */
export const isModelSnapshot = (value: unknown): value is ModelSnapshot => {
  if (
    !record(value) ||
    value["version"] !== 1 ||
    typeof value["id"] !== "string" ||
    !value["id"] ||
    !record(value["model"]) ||
    typeof value["model"]["provider"] !== "string" ||
    typeof value["model"]["id"] !== "string" ||
    !record(value["modelRoles"]) ||
    typeof value["defaultThinkingLevel"] !== "string" ||
    !value["defaultThinkingLevel"] ||
    !(
      value["configuredThinkingLevel"] === null ||
      (typeof value["configuredThinkingLevel"] === "string" && value["configuredThinkingLevel"].length > 0)
    ) ||
    !(
      value["thinkingLevel"] === null ||
      (typeof value["thinkingLevel"] === "string" && value["thinkingLevel"].length > 0)
    ) ||
    typeof value["capturedAt"] !== "string" ||
    !Number.isFinite(Date.parse(value["capturedAt"])) ||
    !record(value["provenance"]) ||
    (value["provenance"]["kind"] !== "launch" && value["provenance"]["kind"] !== "idle-switch") ||
    typeof value["provenance"]["requested"] !== "string" ||
    !exactModelIdentity(value["provenance"]["requested"]) ||
    !record(value["provenance"]["modelRoles"]) ||
    !MODEL_PROVENANCE.has(value["provenance"]["defaultThinkingLevel"])
  )
    return false;
  const identity = exactModelIdentity(`${value["model"]["provider"]}/${value["model"]["id"]}`);
  if (!identity || identity.provider !== value["model"]["provider"] || identity.id !== value["model"]["id"])
    return false;
  const sources = value["provenance"]["modelRoles"];
  return Object.entries(value["modelRoles"]).every(
    ([role, model]) => typeof model === "string" && model.length > 0 && MODEL_PROVENANCE.has(sources[role]),
  );
};

export const paneStateDir = (stateDir: string): string => join(stateDir, "sessions");

export const paneStatePath = (stateDir: string, paneId: string): string =>
  join(paneStateDir(stateDir), `${encodeURIComponent(paneId)}.json`);

export const readPaneState = (stateDir: string, paneId: string): PaneState | null => {
  try {
    return JSON.parse(readFileSync(paneStatePath(stateDir, paneId), "utf8")) as PaneState;
  } catch {
    return null;
  }
};

// temp file + rename so a concurrent reader never sees a half-written state
export const writePaneState = (stateDir: string, state: PaneState): void => {
  mkdirSync(paneStateDir(stateDir), { recursive: true });
  const path = paneStatePath(stateDir, state.paneId);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 1));
  renameSync(tmp, path);
};
