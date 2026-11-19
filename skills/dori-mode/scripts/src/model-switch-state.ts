import { type Lane, type Registry, LANE_KEY, RESERVED_LANE_KEY } from "./registry.ts";
import { exactModelIdentity, type PaneState } from "./lane-state.ts";

export type ModelSwitchResult = { readonly code: 0 | 2 | 3; readonly lines: readonly string[] };

/** One native process in one session file: every field must still match, never the pane alone. */
export type ModelSwitchIdentity = {
  readonly paneId: string;
  readonly pid: number;
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly startedAt: string;
};

export type ModelSwitchRequest = {
  readonly version: 1;
  readonly nonce: string;
  /** The exact provider/id the head asked for, verbatim. */
  readonly requested: string;
  readonly createdAt: string;
  readonly head: ModelSwitchIdentity;
  readonly target: ModelSwitchIdentity;
  /** The target's native snapshot when asked; a change must produce a different one. */
  readonly priorSnapshotId: string | null;
};

/** What the target's native extension publishes on its pane state about the request nonce it claimed. */
export type ModelSwitchReceipt = {
  readonly nonce: string;
  readonly status: "changing" | "changed" | "failed";
  readonly reason?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const fields = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const filled = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isTime = (value: unknown): value is string => filled(value) && Number.isFinite(Date.parse(value));

const isIdentity = (value: unknown): value is ModelSwitchIdentity => {
  const v = fields(value);
  const pid = v?.["pid"];
  return (
    v !== null &&
    filled(v["paneId"]) &&
    typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    filled(v["sessionId"]) &&
    filled(v["sessionFile"]) &&
    isTime(v["startedAt"])
  );
};

/** The lane record is a JSON boundary: a malformed request is never claimed, settled or recorded. */
export const isModelSwitchRequest = (value: unknown): value is ModelSwitchRequest => {
  const v = fields(value);
  const nonce = v?.["nonce"];
  const requested = v?.["requested"];
  const prior = v?.["priorSnapshotId"];
  return (
    v !== null &&
    v["version"] === 1 &&
    typeof nonce === "string" &&
    UUID.test(nonce) &&
    typeof requested === "string" &&
    exactModelIdentity(requested) !== null &&
    isTime(v["createdAt"]) &&
    isIdentity(v["head"]) &&
    isIdentity(v["target"]) &&
    (prior === null || filled(prior))
  );
};

const isModelSwitchReceipt = (value: unknown): value is ModelSwitchReceipt => {
  const v = fields(value);
  const nonce = v?.["nonce"];
  const status = v?.["status"];
  const reason = v?.["reason"];
  return (
    typeof nonce === "string" &&
    UUID.test(nonce) &&
    (status === "changing" || status === "changed" || status === "failed") &&
    (reason === undefined || typeof reason === "string")
  );
};

/** Null without a session file: no request can name a session it cannot find again. */
export const identityOf = (state: PaneState): ModelSwitchIdentity | null =>
  state.sessionFile
    ? {
        paneId: state.paneId,
        pid: state.pid,
        sessionId: state.sessionId,
        sessionFile: state.sessionFile,
        startedAt: state.startedAt,
      }
    : null;

export const sameIdentity = (a: ModelSwitchIdentity, b: ModelSwitchIdentity | null): boolean =>
  b !== null &&
  a.paneId === b.paneId &&
  a.pid === b.pid &&
  a.sessionId === b.sessionId &&
  a.sessionFile === b.sessionFile &&
  a.startedAt === b.startedAt;

/** The request names exactly this lane process and session. The native handler and the readback both require it. */
export const requestMatchesPane = (request: ModelSwitchRequest, pane: PaneState): boolean =>
  pane.role === "lane" && sameIdentity(request.target, identityOf(pane));

export const receiptFor = (state: PaneState | null, nonce: string): ModelSwitchReceipt | null => {
  const receipt = state?.modelSwitch;
  return isModelSwitchReceipt(receipt) && receipt.nonce === nonce ? receipt : null;
};

/** The lane's pending request while it is still `nonce`: the compare of every compare-and-set on the request. */
export const pendingAs = (lane: Lane | null, nonce: string): ModelSwitchRequest | null => {
  const request = lane?.modelSwitchRequest;
  return isModelSwitchRequest(request) && request.nonce === nonce ? request : null;
};

/**
 * The native half of the request's compare-and-set, for the `/dori-model-apply <key> <nonce>` handler after its own
 * idle, approval and queued-work checks and before any setter runs. Under the lane's registry lock `nonce` must still
 * be the pending request for exactly `self`'s process and session; `publish` then writes the `changing` receipt to
 * `self`'s pane state synchronously, inside that lock. A coordinator that gives up withdraws under the same lock, so
 * either it sees `changing` and keeps the request, or this finds nothing to apply (null: publish and change nothing).
 */
export const claimModelSwitch = async (
  registry: Registry,
  key: string,
  nonce: string,
  self: PaneState,
  publish: (receipt: ModelSwitchReceipt) => void,
): Promise<ModelSwitchRequest | null> => {
  if (!LANE_KEY.test(key) || key === RESERVED_LANE_KEY || !UUID.test(nonce)) return null;
  let claimed: ModelSwitchRequest | null = null;
  await registry.update(key, (current) => {
    const request = pendingAs(current, nonce);
    if (request !== null && requestMatchesPane(request, self)) {
      publish({ nonce, status: "changing" });
      claimed = request;
    }
    return null;
  });
  return claimed;
};
