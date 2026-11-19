import { withDeliveryLock } from "./delivery-lock.ts";
import { type DeliveryRecord, DeliveryState } from "./delivery-state.ts";
import type { FlowDeps } from "./done-flow.ts";
import { type Lane, sessionOf, statusOf } from "./registry.ts";
import { runtimesOf } from "./run.ts";
import { type Delivery, sendVerified, statusLookup, UnsafeTextError } from "./sessions.ts";

/**
 * `dori tell`: the lead's one message to a lane's session, sent through `sendVerified` so a shell, a stopped agent or an
 * approval prompt gets nothing and the text is never sent twice. Exit codes keep the outcomes apart: 0 confirmed,
 * 3 unconfirmed (the text may have arrived; resending could duplicate it), 2 failed (nothing was sent).
 */
export type TellResult = { readonly line: string; readonly code: 0 | 2 | 3 };

const failed = (lane: Lane, why: string): TellResult => ({
  line: `TELL_FAILED ${lane.key} delivery=failed: ${why}; nothing was sent`,
  code: 2,
});

/**
 * The lane is read again under its delivery lock, which `dori pause` holds through its whole pause, so a pause that
 * finished after the caller read the lane holds the send instead of starting a turn the owner asked to hold.
 */
export const tellLane = async (
  deps: FlowDeps,
  lane: Lane,
  text: string,
  options: { readonly locked?: boolean; readonly waitMs?: number; readonly expectedSessionId?: string } = {},
): Promise<TellResult> => {
  const state = new DeliveryState(deps.registry, lane.key);
  const dispatch = async () => {
    const current = await deps.registry.read(lane.key);
    if (!current || statusOf(current) === "closed") return failed(lane, "the lane was closed");
    if (current.nativeCloseIntent) return failed(current, "native close is in progress");
    const pending = state.read();
    if (pending?.status === "uncertain")
      return {
        line: `TELL_HELD ${lane.key} delivery=held: request=${pending.id} is uncertain; this message was not sent; inspect dori tell ${lane.key} --status, then --resolve ${pending.id} --note REASON to end only its hold`,
        code: 2 as const,
      };
    return await send(deps, current, text, state, options.expectedSessionId);
  };
  const held = options.locked
    ? { ok: true as const, value: await dispatch() }
    : await withDeliveryLock(deps, lane.key, dispatch, options.waitMs);
  return held.ok ? held.value : failed(lane, `a pause or another tell holds the lane's delivery lock (${held.holder})`);
};

const send = async (
  deps: FlowDeps,
  lane: Lane,
  text: string,
  state: DeliveryState,
  expectedSessionId?: string,
): Promise<TellResult> => {
  // The owner said wait: a message would start a turn in a paused lane, which only `dori resume` may do.
  if (statusOf(lane) === "paused") return failed(lane, "the lane is paused; resume it first");
  const ref = sessionOf(lane);
  if (!ref) return failed(lane, "the lane has no session");
  const request: DeliveryRecord = {
    id: crypto.randomUUID(),
    openedAt: lane.openedAt,
    session: ref,
    at: new Date(deps.clock.now()).toISOString(),
    status: "uncertain",
  };
  // A crash or exception after submission must leave a fence, not permission to submit the next request.
  state.write(request);
  const unconfirmed = (why: string): TellResult => ({
    line: `TELL_UNCONFIRMED ${lane.key} delivery=unconfirmed: request=${request.id}; ${why}; later messages are held; do not resend`,
    code: 3,
  });
  let delivery: Delivery;
  try {
    delivery = await sendVerified(runtimesOf(deps), deps.clock, ref, text, undefined, expectedSessionId);
  } catch (e) {
    if (!(e instanceof UnsafeTextError)) {
      console.error(unconfirmed(`delivery threw: ${e instanceof Error ? e.message : String(e)}`).line);
      throw e;
    }
    state.write({ ...request, status: "failed", settledAt: new Date(deps.clock.now()).toISOString() });
    return failed(lane, "the text contains a backtick or $(");
  }
  if (delivery !== "unconfirmed")
    state.write({
      ...request,
      status: delivery === "delivered" ? "confirmed" : "failed",
      settledAt: new Date(deps.clock.now()).toISOString(),
    });
  if (delivery === "delivered") return { line: `TOLD ${lane.key} delivery=confirmed`, code: 0 };
  if (delivery === "failed") {
    // sendVerified does not say which hold applied; the status read now tells a shell from a blocked agent.
    const now = await statusLookup(runtimesOf(deps), ref);
    const seen = now.error !== undefined ? "unreadable" : (now.status ?? "no agent");
    return failed(lane, `no agent ready for input (status now: ${seen})`);
  }
  return unconfirmed("no move to working was seen (a working agent gets it as queued input)");
};

/** Ordinary status notifications never wait inside another delivery callback; their hold is reported instead. */
export const notifyLane = async (deps: FlowDeps, lane: Lane, text: string, locked = false): Promise<void> => {
  if (!sessionOf(lane)) return;
  const delivery = await tellLane(deps, lane, text, { locked, waitMs: 0 });
  if (delivery.code !== 0)
    console.log(`LANE_NOTIFY_${delivery.code === 2 ? "HELD" : "UNCONFIRMED"} ${lane.key} ${delivery.line}`);
};

/** Ends only this local hold. It neither confirms/cancels the original action nor sends any text. */
export const resolveTell = async (deps: FlowDeps, key: string, id: string, note: string): Promise<TellResult> => {
  const state = new DeliveryState(deps.registry, key);
  const held = await withDeliveryLock(deps, key, async (): Promise<TellResult> => {
    const current = state.read();
    if (
      !id.trim() ||
      !note.trim() ||
      !current ||
      current.id !== id ||
      (current.status !== "uncertain" && current.status !== "released")
    )
      return {
        line: `TELL_RESOLVE_REFUSED ${key} request=${id}: exact uncertain request ID and a nonempty note are required; inspect dori tell ${key} --status`,
        code: 2,
      };
    if (current.status === "uncertain")
      state.write({
        ...current,
        status: "released",
        settledAt: new Date(deps.clock.now()).toISOString(),
        note: note.trim(),
      });
    return {
      line: `TELL_RESOLVED ${key} request=${id}: hold released only; original delivery remains unknown; nothing sent or replayed`,
      code: 0,
    };
  });
  return held.ok
    ? held.value
    : {
        line: `TELL_RESOLVE_HELD ${key}: delivery is in flight (${held.holder}); nothing changed`,
        code: 2,
      };
};
