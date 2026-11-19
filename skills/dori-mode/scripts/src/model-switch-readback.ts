import type { SessionRef } from "../../../../src/runtime/types.ts";
import type { FlowDeps } from "./done-flow.ts";
import {
  type GoalStatus,
  type ModelReadback,
  type ModelSnapshot,
  type PaneState,
  readPaneState,
} from "./lane-state.ts";
import { verifiedModelSnapshot } from "./launch-model.ts";
import { type Lane, sessionOf } from "./registry.ts";
import { runtimesOf } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";
import { sendVerified } from "./sessions.ts";
import {
  type ModelSwitchRequest,
  type ModelSwitchResult,
  pendingAs,
  receiptFor,
  requestMatchesPane,
} from "./model-switch-state.ts";

const READ_BACK_TRIES = 8;
const READ_BACK_MS = 700;

const modelOf = (snapshot: ModelSnapshot): string => `${snapshot.model.provider}/${snapshot.model.id}`;

type Evidence = {
  readonly snapshot: ModelSnapshot;
  readonly readback: ModelReadback;
  readonly profileFile: string;
};

type Observation =
  | ({ readonly kind: "changed" } & Evidence)
  | { readonly kind: "failed" | "invalid" | "waiting"; readonly why: string };

/**
 * A `changed` receipt counts only with a verified snapshot in the process's own profile (the launch and reopen proof)
 * that is a new idle-switch snapshot of the requested model, captured and read back after the request.
 */
const changeEvidence = (
  request: ModelSwitchRequest,
  state: PaneState,
  profileFile: string | undefined,
): Evidence | string => {
  if (profileFile === undefined) return "the lane has no registered model profile";
  const snapshot = verifiedModelSnapshot(state, profileFile);
  if (typeof snapshot === "string") return snapshot;
  const readback = state.modelReadback;
  const since = Date.parse(request.createdAt);
  if (snapshot.provenance.kind !== "idle-switch") return `native snapshot is a ${snapshot.provenance.kind} snapshot`;
  if (snapshot.id === request.priorSnapshotId) return `native snapshot ${snapshot.id} predates the request`;
  if (snapshot.provenance.requested !== request.requested)
    return `native snapshot was requested as ${snapshot.provenance.requested}`;
  if (modelOf(snapshot).toLowerCase() !== request.requested.toLowerCase())
    return `native snapshot model is ${modelOf(snapshot)}`;
  if (!(Date.parse(snapshot.capturedAt) >= since)) return "native snapshot was captured before the request";
  if (readback === undefined || !(Date.parse(readback.checkedAt) >= since))
    return "native model readback predates the request";
  return { snapshot, readback, profileFile };
};

/** Only the request's own target process and session may answer it, and only with its nonce. */
const observe = (
  request: ModelSwitchRequest,
  state: PaneState | null,
  profileFile: string | undefined,
): Observation => {
  if (state === null) return { kind: "waiting", why: "the lane's native state is unreadable" };
  if (!requestMatchesPane(request, state))
    return { kind: "invalid", why: "the lane's native process or session changed" };
  const receipt = receiptFor(state, request.nonce);
  if (receipt === null) return { kind: "waiting", why: "no native receipt" };
  if (receipt.status === "changing") return { kind: "waiting", why: "the native change is still running" };
  if (receipt.status === "failed") return { kind: "failed", why: receipt.reason ?? "no reason given" };
  const evidence = changeEvidence(request, state, profileFile);
  return typeof evidence === "string"
    ? { kind: "invalid", why: `changed without matching evidence: ${evidence}` }
    : { kind: "changed", ...evidence };
};

type Released = "withdrawn" | "kept" | "replaced";

const AFTER: Readonly<Record<Released, string>> = {
  withdrawn: "request withdrawn, so a late delivery applies nothing",
  kept: "native acceptance is unfinished or unreadable, so it stays pending; wait for its final receipt or park/reopen the lane if its owning process exited",
  replaced: "the request was replaced meanwhile",
};

/**
 * Withdraws the request so a late `/dori-model-apply` finds nothing to apply, unless `keepAccepted` and the pane
 * shows the native claim or cannot be read. Reading under the same registry lock as claimModelSwitch prevents
 * claim/withdrawal races; missing state cannot prove that an already accepted change is safe to withdraw.
 */
const release = async (
  deps: FlowDeps,
  key: string,
  paneId: string | undefined,
  nonce: string,
  keepAccepted: boolean,
): Promise<Released> => {
  let released: Released = "replaced";
  await deps.registry.update(key, (current) => {
    if (current === null || pendingAs(current, nonce) === null) return null;
    const state = keepAccepted && paneId !== undefined ? readPaneState(deps.config.stateDir, paneId) : null;
    const receipt = receiptFor(state, nonce);
    if (keepAccepted && (state === null || (receipt !== null && receipt.status !== "failed"))) {
      released = "kept";
      return null;
    }
    released = "withdrawn";
    const { modelSwitchRequest: _, ...rest } = current;
    return rest;
  });
  return released;
};

/** Mirror a receipt only in the same lane generation, process profile and native session it was read for. */
const recordChange = (
  deps: FlowDeps,
  lane: Lane,
  request: ModelSwitchRequest,
  evidence: Evidence,
): Promise<Lane | null> =>
  deps.registry.transition(lane, (current) => {
    const ref = sessionOf(lane);
    const now = sessionOf(current);
    if (
      pendingAs(current, request.nonce) === null ||
      current.session !== request.target.sessionId ||
      current.sessionFile !== lane.sessionFile ||
      current.cwd !== lane.cwd ||
      now?.id !== request.target.paneId ||
      now?.runtime !== ref?.runtime ||
      current.modelProfileFile !== evidence.profileFile ||
      current.modelSnapshot?.id !== lane.modelSnapshot?.id
    )
      return null;
    const fresh = observe(
      request,
      readPaneState(deps.config.stateDir, request.target.paneId),
      current.modelProfileFile,
    );
    if (fresh.kind !== "changed" || fresh.snapshot.id !== evidence.snapshot.id) return null;
    const { modelSwitchRequest: _, ...rest } = current;
    return {
      ...rest,
      model: modelOf(fresh.snapshot),
      modelReadback: fresh.readback,
      modelSnapshot: fresh.snapshot,
      modelProfileFile: fresh.profileFile,
    };
  });

/**
 * A request left pending by an earlier call is settled from its own receipt before anything new is sent. One the
 * native session accepted but has not finished blocks the new request: its outcome is never made ambiguous.
 */
export const settleEarlier = async (
  deps: FlowDeps,
  lane: Lane,
  earlier: ModelSwitchRequest,
  selector: string,
): Promise<ModelSwitchResult | string> => {
  const ref = sessionOf(lane);
  const state =
    ref === undefined ? null : await trustedPaneState(deps.run, deps.config.stateDir, ref, runtimesOf(deps));
  const seen = observe(earlier, state, lane.modelProfileFile);
  const what = `MODEL_SWITCH_SETTLED ${lane.key} earlier request ${earlier.nonce} for ${earlier.requested}`;
  if (seen.kind === "changed") {
    if (!(await recordChange(deps, lane, earlier, seen)))
      return {
        code: 3,
        lines: [
          `MODEL_SWITCH_UNVERIFIED ${lane.key} earlier native change ${earlier.nonce} could not be recorded because request or target changed; new request not sent`,
        ],
      };
    const line = `${what} recorded native ${modelOf(seen.snapshot)} snapshot ${seen.snapshot.id}`;
    return earlier.requested === selector
      ? { code: 0, lines: [line, `MODEL_SWITCHED ${lane.key} ${modelOf(seen.snapshot)} already; nothing sent`] }
      : line;
  }
  const released = await release(deps, lane.key, ref?.id, earlier.nonce, seen.kind === "waiting");
  if (released === "kept")
    return {
      code: 3,
      lines: [
        `MODEL_SWITCH_UNVERIFIED ${lane.key} earlier request ${earlier.nonce} for ${earlier.requested} has unfinished or unreadable native acceptance (${seen.why}); new request not sent`,
        "Fix: run /dori-lane-model again once the lane's native receipt is final; if the owning process exited, park/reopen the lane instead",
      ],
    };
  return `${what} ${released === "withdrawn" ? "withdrawn" : "is no longer pending"}: ${seen.why}`;
};

/** Types the private command once, then reads the target's own receipt back; never sends it again. */
export const confirm = async (
  deps: FlowDeps,
  lane: Lane,
  ref: SessionRef,
  request: ModelSwitchRequest,
  profileFile: string,
  goal: GoalStatus,
): Promise<ModelSwitchResult> => {
  const key = lane.key;
  const rts = runtimesOf(deps);
  const end = async (code: 2 | 3, label: string, why: string, keepAccepted: boolean): Promise<ModelSwitchResult> => {
    const released = await release(deps, key, ref.id, request.nonce, keepAccepted);
    return {
      code: released === "kept" ? 3 : code,
      lines: [
        `${label} ${key} request ${request.nonce} for ${request.requested}: ${why}; ${AFTER[released]}; registry model unchanged, not retried`,
      ],
    };
  };
  try {
    const delivery = await sendVerified(rts, deps.clock, ref, `/dori-model-apply ${key} ${request.nonce}`, "idle");
    if (delivery === "failed")
      return await end(2, "MODEL_SWITCH_REFUSED", "no native agent took the command, nothing was typed", true);
    for (let attempt = 1; ; attempt++) {
      const seen = observe(request, await trustedPaneState(deps.run, deps.config.stateDir, ref, rts), profileFile);
      if (seen.kind === "changed")
        return (await recordChange(deps, lane, request, seen))
          ? {
              code: 0,
              lines: [
                `MODEL_SWITCHED ${key} ${modelOf(seen.snapshot)} snapshot ${seen.snapshot.id} (request ${request.nonce}); goal left ${goal}, never resumed here`,
              ],
            }
          : {
              code: 3,
              lines: [
                `MODEL_SWITCH_UNVERIFIED ${key} native reports ${modelOf(seen.snapshot)} snapshot ${seen.snapshot.id}, but request or target no longer current; registry model unchanged (request ${request.nonce})`,
              ],
            };
      if (seen.kind === "failed") return await end(3, "MODEL_SWITCH_FAILED", `native refused: ${seen.why}`, false);
      if (seen.kind === "invalid") return await end(3, "MODEL_SWITCH_UNVERIFIED", seen.why, false);
      if (attempt >= READ_BACK_TRIES)
        return await end(3, "MODEL_SWITCH_UNVERIFIED", `${seen.why} after ${READ_BACK_TRIES} readbacks`, true);
      await deps.clock.sleep(READ_BACK_MS);
    }
  } catch (error) {
    await release(deps, key, ref.id, request.nonce, true);
    throw error;
  }
};
