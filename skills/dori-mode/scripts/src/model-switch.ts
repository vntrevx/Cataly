import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { withDeliveryLock } from "./delivery-lock.ts";
import { type FlowDeps, movedOn } from "./done-flow.ts";
import { exactModelIdentity, isModelSnapshot, type PaneState } from "./lane-state.ts";
import { type Lane, LANE_KEY, RESERVED_LANE_KEY, sessionOf, statusOf } from "./registry.ts";
import { iso, runtimesOf } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";
import { confirm, settleEarlier } from "./model-switch-readback.ts";
import {
  identityOf,
  isModelSwitchRequest,
  type ModelSwitchIdentity,
  type ModelSwitchRequest,
  type ModelSwitchResult,
  sameIdentity,
} from "./model-switch-state.ts";

/**
 * `/dori-lane-model <key> <provider/id>`: the native Dori head asks one idle lane's native session to change its model
 * and records the change only from that session's own receipt and snapshot. The request waits on the lane record
 * (`modelSwitchRequest`) and its nonce travels in the private `/dori-model-apply <key> <nonce>` command, typed once:
 * nothing is retried or replayed, and the lane's goal is never resumed. Exit codes as `dori tell` and `pause`:
 * 0 changed and recorded, 2 refused before anything was typed, 3 typed but not verified, or the lane moved on.
 */

const samePath = (a: string, b: string): boolean => {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

const refused = (key: string, why: string, fix?: string): ModelSwitchResult => ({
  code: 2,
  lines: [`MODEL_SWITCH_REFUSED ${key} ${why}`, ...(fix === undefined ? [] : [`Fix: ${fix}`])],
});

const withNotes = (notes: readonly string[], result: ModelSwitchResult): ModelSwitchResult =>
  notes.length === 0 ? result : { code: result.code, lines: [...notes, ...result.lines] };

/** The caller must be this process, attested by the trusted record of its own pane as its live native Dori head. */
const liveHead = async (deps: FlowDeps, head: PaneState): Promise<ModelSwitchIdentity | null> => {
  const claimed = identityOf(head);
  const rts = runtimesOf(deps);
  const self = rts.selfAny(deps.env ?? process.env);
  if (head.role !== "dori" || claimed === null || claimed.pid !== process.pid || self === undefined) return null;
  if (self.id !== claimed.paneId) return null;
  const live = await trustedPaneState(deps.run, deps.config.stateDir, self, rts);
  return live !== null && live.role === "dori" && sameIdentity(claimed, identityOf(live)) ? claimed : null;
};

type Refusal = { readonly why: string; readonly fix?: string };

const liveTarget = (
  deps: FlowDeps,
  lane: Lane,
  state: PaneState | null,
): { readonly state: PaneState; readonly target: ModelSwitchIdentity; readonly profileFile: string } | Refusal => {
  if (state === null || state.role !== "lane") return { why: "has no trusted live native lane session; nothing sent" };
  const target = identityOf(state);
  // OMP allocates this identity before writing a file; an empty session is persisted only after assistant output.
  if (
    target === null ||
    lane.session === undefined ||
    state.sessionId !== lane.session ||
    (lane.sessionFile !== undefined && lane.sessionFile !== target.sessionFile) ||
    !samePath(state.cwd, lane.cwd ?? deps.config.defaultCwd)
  )
    return {
      why: `native session ${state.sessionId} is not the registered session with its file and cwd; nothing sent`,
      fix: "run dori sync and check the lane's session before switching",
    };
  // The change is verified against the profile this process owns; without one it could never be confirmed.
  const profileFile = lane.modelProfileFile;
  if (profileFile === undefined || state.modelProfileFile !== profileFile)
    return {
      why: "native process does not own the lane's registered model profile; nothing sent",
      fix: `park and reopen ${lane.key} so its native process owns a model profile`,
    };
  // Nothing may continue the lane on its own while its model changes: an active or blocked goal is paused first.
  const goal = state.goal.status;
  if (goal === "active" || goal === "blocked")
    return {
      why: `goal is ${goal}; nothing sent`,
      fix: `run dori pause ${lane.key} first; resume it explicitly after the switch`,
    };
  if (goal !== "none" && goal !== "paused" && goal !== "complete" && goal !== "dropped")
    return { why: `goal status ${String(goal)} is unknown; nothing sent` };
  if (state.approvalPending !== false)
    return { why: "has an approval prompt open; nothing sent", fix: "answer the lane's approval prompt first" };
  if (state.agentStatus !== "idle")
    return {
      why: `is ${state.agentStatus ?? "of unreported activity"}, not idle; nothing sent`,
      fix: "wait until the lane's turn ends",
    };
  return { state, target, profileFile };
};

/**
 * Asks the idle lane `key` to change its native model to the exact `selector`. `head` is the calling native extension's
 * own pane state; it must be this process and the live, trusted Dori head of its own pane. The whole request and its
 * readback hold the lane's delivery lock, so no tell, pause or second switch interleaves.
 */
export const requestLaneModelSwitch = async (
  deps: FlowDeps,
  key: string,
  selector: string,
  head: PaneState,
): Promise<ModelSwitchResult> => {
  if (!LANE_KEY.test(key) || key === RESERVED_LANE_KEY) return refused(key, "is not a lane key");
  if (!exactModelIdentity(selector))
    return refused(
      key,
      `cannot switch to ${selector}: not one exact provider/id`,
      "pass one exact provider/id from the native model catalog, never an alias, list or wildcard",
    );
  const held = await withDeliveryLock(deps, key, () => switchHeld(deps, key, selector, head));
  return held.ok
    ? held.value
    : refused(key, `delivery lock held (${held.holder}); nothing sent`, "run it again once that tell or pause ends");
};

const switchHeld = async (
  deps: FlowDeps,
  key: string,
  selector: string,
  head: PaneState,
): Promise<ModelSwitchResult> => {
  const headId = await liveHead(deps, head);
  if (headId === null)
    return refused(
      key,
      "caller is not the live native Dori head of its own pane; nothing sent",
      "run /dori-lane-model in the main native Dori session",
    );
  const notes: string[] = [];
  let lane = await deps.registry.read(key);
  const earlier = lane?.modelSwitchRequest;
  if (lane !== null && earlier !== undefined) {
    if (isModelSwitchRequest(earlier)) {
      const settled = await settleEarlier(deps, lane, earlier, selector);
      if (typeof settled !== "string") return settled;
      notes.push(settled);
      lane = await deps.registry.read(key);
    } else notes.push(`MODEL_SWITCH_SETTLED ${key} earlier request is malformed and can never apply`);
  }
  if (lane === null || statusOf(lane) === "closed")
    return withNotes(notes, refused(key, lane === null ? "is not registered" : "is closed"));
  const ref = sessionOf(lane);
  if (ref === undefined) return withNotes(notes, refused(key, "has no session"));
  const live = liveTarget(deps, lane, await trustedPaneState(deps.run, deps.config.stateDir, ref, runtimesOf(deps)));
  if ("why" in live) return withNotes(notes, refused(key, live.why, live.fix));
  const snapshot = live.state.modelSnapshot;
  const request: ModelSwitchRequest = {
    version: 1,
    nonce: randomUUID(),
    requested: selector,
    createdAt: iso(deps.clock),
    head: headId,
    target: live.target,
    priorSnapshotId: isModelSnapshot(snapshot) ? snapshot.id : null,
  };
  const seen = lane;
  // Still the same open lane session with the pending field as read (absent, or malformed and never applicable).
  const stored = await deps.registry.update(key, (current) => {
    const now = current === null ? undefined : sessionOf(current);
    return current !== null &&
      statusOf(current) !== "closed" &&
      current.session === seen.session &&
      now?.runtime === ref.runtime &&
      now.id === ref.id &&
      JSON.stringify(current.modelSwitchRequest) === JSON.stringify(seen.modelSwitchRequest)
      ? { ...current, modelSwitchRequest: request }
      : null;
  });
  if (stored === null) return withNotes(notes, { code: 3, lines: [await movedOn(deps, seen, "model request")] });
  return withNotes(notes, await confirm(deps, stored, ref, request, live.profileFile, live.state.goal.status));
};
