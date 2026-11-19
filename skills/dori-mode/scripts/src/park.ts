import { SHELLS } from "../../../../src/runtime/foreground.ts";
import { mayRunOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import type { Probe } from "../../../../src/runtime/types.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { type FlowDeps, movedOn, unpushedWork } from "./done-flow.ts";
import { resumeFile } from "./lifecycle-session.ts";
import { pauseLane, type PauseResult } from "./pause.ts";
import { type Lane, sessionOf, statusOf, withStatus } from "./registry.ts";
import { iso, runtimesOf } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";

/** Terminal suspension preserves files and never claims Done or runs threadDone. */
export const parkLane = async (
  deps: FlowDeps,
  seen: Lane,
  note: string,
  outcome: "parked" | "abandoned" = "parked",
  resumeWhen?: string,
): Promise<PauseResult> => {
  const held = await withDeliveryLock(deps, seen.key, async (): Promise<PauseResult> => {
    let lane = (await deps.registry.read(seen.key)) ?? seen;
    const fail = (text: string, code: 2 | 3 = 3): PauseResult => ({ lane, lines: [text], code });
    if (!note.trim()) return fail(`REFUSED ${lane.key}: a reason is required`, 2);
    if (!["working", "not-done", "paused"].includes(statusOf(lane)))
      return fail(`REFUSED ${lane.key}: ${statusOf(lane)} cannot be ${outcome}`, 2);
    const ref = sessionOf(lane);
    const rts = runtimesOf(deps);
    const listed = ref && (await rts.for(ref).list()).find((s) => s.ref.id === ref.id);
    const live = Boolean(listed);
    let probe: Probe | undefined;
    if (outcome === "abandoned" && listed?.status === "shell" && ref) {
      try {
        probe = await rts.for(ref).probe(ref);
      } catch {
        return fail(`ABANDON_UNVERIFIED ${lane.key}: cannot confirm shell ${ref.id}; no pane closed`);
      }
    }
    const front = probe?.foreground;
    const stoppedShell =
      probe?.shellInFront &&
      !probe.pid &&
      front?.length === 1 &&
      SHELLS.has((front[0]?.name ?? "").replace(/^-/, "").split("/").pop() ?? "") &&
      front[0]?.argv.length === 1;
    let session = lane.session;
    let sessionFile = lane.sessionFile;
    if (outcome === "parked") {
      if (!mayRunOmpArgv(deps.config.agentCommand)) return fail(`REFUSED ${lane.key}: park requires OMP`, 2);
      if (live && ref) {
        const state = await trustedPaneState(deps.run, deps.config.stateDir, ref, rts);
        if (state?.role !== "lane" || state.approvalPending || (session && session !== state.sessionId))
          return fail(`PARK_UNVERIFIED ${lane.key}: current lane session identity unavailable or changed`);
        session = state.sessionId;
        sessionFile = state.sessionFile;
      } else if (!lane.hold || statusOf(lane) !== "paused")
        return fail(`PARK_UNVERIFIED ${lane.key}: no live lane to pause`);
      sessionFile = await resumeFile(deps, {
        ...lane,
        ...(session ? { session } : {}),
        ...(sessionFile ? { sessionFile } : {}),
      });
    }
    if (live && !stoppedShell) {
      const paused = await pauseLane(deps, lane, note, true);
      if (paused.code !== 0) return paused;
      lane = paused.lane;
      // An old registry pause is not proof that a woken native goal is still paused.
      if (mayRunOmpArgv(deps.config.agentCommand) && ref) {
        const state = await trustedPaneState(deps.run, deps.config.stateDir, ref, rts);
        if (
          state?.role !== "lane" ||
          state.approvalPending ||
          (session && state.sessionId !== session) ||
          !["paused", "none", "complete", "dropped"].includes(state.goal.status)
        )
          return fail(`PARK_UNVERIFIED ${lane.key}: goal or session changed before close`);
      }
    }
    const warnings = await unpushedWork(deps, lane);
    // Persist the resumable identity before closing: an interrupted park can be completed without guessing.
    const prepared = await deps.registry.transition(lane, (current) =>
      withStatus(current, "paused", `${outcome}: ${note}`, iso(deps.clock), {
        ...(session ? { session } : {}),
        ...(sessionFile ? { sessionFile } : {}),
        hold: { reason: note, ...(resumeWhen ? { resumeWhen } : {}) },
      }),
    );
    if (!prepared) return fail(await movedOn(deps, lane, outcome));
    lane = prepared;
    if (live && ref) {
      try {
        // Close only the recorded pane, never unrelated panes later added to its tab.
        await rts.for(ref).close(ref, "session");
        if ((await rts.for(ref).list()).some((s) => s.ref.id === ref.id))
          return fail(`PARK_UNVERIFIED ${lane.key}: pane still present; files kept`);
      } catch (error) {
        return fail(`PARK_UNVERIFIED ${lane.key}: close failed (${String(error)}); files kept`);
      }
    }
    const at = iso(deps.clock);
    const receipt = { outcome, note, at, cleanup: ["worktrees kept", live ? "pane closed" : "pane absent"], warnings };
    const closed = await deps.registry.transition(lane, (current) =>
      withStatus(current, "closed", `${outcome}: ${note}`, at, { closedAt: at, receipt }),
    );
    if (!closed) return fail(await movedOn(deps, lane, `${outcome} (pane closed)`));
    return {
      lane: closed,
      code: 0,
      lines: [
        ...warnings.map((w) => `WARNING ${w}; preserved`),
        `${outcome === "parked" ? "PARKED" : "ABANDONED"} ${lane.key} ${JSON.stringify(receipt)}`,
      ],
    };
  });
  return held.ok ? held.value : { lane: seen, lines: [`HELD ${seen.key} delivery lock: ${held.holder}`], code: 3 };
};
