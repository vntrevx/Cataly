import { removePrepared } from "./launch-session.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { createModelProfileFile } from "./model-profile.ts";
import type { ModelReadback, ModelSnapshot } from "./lane-state.ts";
import { mayRunOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import { configPath } from "./config.ts";
import { modelResumeCommand, verifiedModelSnapshot } from "./launch-model.ts";
import { withDeliveryLock } from "./delivery-lock.ts";
import { type FlowDeps, movedOn } from "./done-flow.ts";
import { quoteForPane } from "./launch-footer.ts";
import { LaunchError } from "./launch.ts";
import { resumeFile } from "./lifecycle-session.ts";
import { resumeLane, type PauseResult } from "./pause.ts";
import { type Lane, sessionFields, sessionOf, statusOf, withStatus } from "./registry.ts";
import { Reports } from "./reports.ts";
import { iso, runtimesOf } from "./run.ts";
import { trustedPaneState } from "./session-id.ts";
import { listSessions, sendVerified } from "./sessions.ts";
import { laneLaunchEnv } from "./slack-token.ts";

/** Reopen is an explicit operator action; neither a timer nor a ready condition calls it. */
export const reopenLane = async (deps: FlowDeps, seen: Lane, note?: string): Promise<PauseResult> => {
  const held = await withDeliveryLock(deps, seen.key, async (): Promise<PauseResult> => {
    const lane = (await deps.registry.read(seen.key)) ?? seen;
    const fail = (text: string, current = lane): PauseResult => ({ lane: current, lines: [text], code: 3 });
    if (statusOf(lane) !== "closed") return fail(`REFUSED ${lane.key}: not closed; use resume for a paused lane`);
    if (!mayRunOmpArgv(deps.config.agentCommand)) throw new LaunchError("reopen requires an OMP agentCommand");
    if (note && /`|\$\(/.test(note)) throw new LaunchError("reopen note contains unsupported delivery syntax");
    const file = await resumeFile(deps, lane);
    const template = deps.config.agentCommand;
    if (
      template.at(-1) !== "{prompt}" ||
      template.slice(0, -1).some((p) => p.includes("{prompt}") || /^--(?:resume|session|continue)(?:=|$)/.test(p))
    )
      throw new LaunchError("reopen requires agentCommand ending in a positional {prompt}, without session selectors");
    const argv = modelResumeCommand(template, file);
    if (typeof argv === "string") throw new LaunchError(argv);
    const rts = runtimesOf(deps);
    const oldRef = sessionOf(lane);
    for (const entry of await listSessions(rts, { lanes: [lane] })) {
      if (oldRef && entry.ref.runtime === oldRef.runtime && entry.ref.id === oldRef.id)
        return fail(`REFUSED ${lane.key}: previous pane still exists`);
      try {
        if ((await rts.for(entry.ref).probe(entry.ref)).sessionId === lane.session)
          return fail(`REFUSED ${lane.key}: recorded session is already running in ${entry.ref.id}`);
      } catch {
        return fail(`REOPEN_UNVERIFIED ${lane.key}: cannot inspect session ${entry.ref.id}; no pane created`);
      }
    }
    const env = laneLaunchEnv(deps.env ?? process.env, deps.env?.["DORI_CONFIG"] ?? configPath(), deps.config);
    const profileFile = createModelProfileFile(deps.config.stateDir);
    argv.push(`--config=${profileFile}`);
    let ref: SessionRef;
    try {
      ref = await rts.default.create({
        name: lane.key,
        role: "lane",
        container: "tab",
        cwd: lane.cwd ?? deps.config.defaultCwd,
        env,
        ...(deps.config.laneWorkspace ? { group: deps.config.laneWorkspace } : {}),
      });
    } catch (error) {
      removePrepared(profileFile);
      throw error;
    }
    const at = iso(deps.clock);
    const opened = await deps.registry.transition(lane, (current) => {
      const {
        closedAt: _closed,
        receipt: _receipt,
        claim: _claim,
        objection: _objection,
        hold: _hold,
        tab: _tab,
        sessionRef: _ref,
        pane: _pane,
        ...rest
      } = current;
      return withStatus(rest, "paused", `reopening: ${note ?? "explicit operator request"}`, at, {
        ...sessionFields(ref),
        sessionFile: file,
        modelProfileFile: profileFile,
        openedAt: at,
        pausedFrom: "working",
        lastReplyAt: deps.clock.now(),
        lastFreshnessNote: undefined,
        pausedSeenWorking: undefined,
      });
    });
    if (!opened) {
      await rts.for(ref).close(ref, "session");
      removePrepared(profileFile);
      return fail(await movedOn(deps, lane, "reopen"));
    }
    // The new paused generation exists even if startup/readback fails and the operator later uses resume.
    new Reports(deps.config.stateDir).append({
      type: "reopen",
      key: lane.key,
      at,
      text: `lane reopening in ${ref.id}`,
    });
    try {
      await rts.for(ref).start(ref, argv.map(quoteForPane).join(" "));
    } catch (error) {
      return fail(
        `REOPEN_UNVERIFIED ${lane.key}: start failed (${String(error)}); pane=${ref.id}, inspect before resume`,
        opened,
      );
    }
    // Never resume a foreign/new session or treat an unknown receipt as an idle agent.
    const attempts = Math.max(1, Math.ceil(deps.config.startupWaitSeconds));
    let ready: { snapshot: ModelSnapshot; readback: ModelReadback } | undefined;
    let modelProblem = "native model snapshot not observed";
    for (let n = 0; n < attempts; n++) {
      const state = await trustedPaneState(deps.run, deps.config.stateDir, ref, rts);
      if (
        state &&
        state.modelReadback &&
        state.sessionId === lane.session &&
        state.sessionFile === file &&
        state.role === "lane" &&
        state.agentStatus === "idle" &&
        !state.approvalPending &&
        ["paused", "none", "complete", "dropped"].includes(state.goal.status)
      ) {
        const snapshot = verifiedModelSnapshot(state, profileFile);
        if (typeof snapshot !== "string") {
          ready = { snapshot, readback: state.modelReadback };
          break;
        }
        modelProblem = snapshot;
        if (state.modelSnapshotError) break;
      }
      await deps.clock.sleep(1000);
    }
    if (!ready)
      return fail(
        `REOPEN_UNVERIFIED ${lane.key}: same paused session and saved model not confirmed in ${ref.id} (${modelProblem}); inspect before resume`,
        opened,
      );
    const { snapshot, readback } = ready;
    const confirmed = await deps.registry.transition(opened, (current) => ({
      ...current,
      model: `${snapshot.model.provider}/${snapshot.model.id}`,
      modelReadback: readback,
      modelSnapshot: snapshot,
    }));
    if (!confirmed) return fail(await movedOn(deps, opened, "reopen model readback"), opened);
    const resumed = await resumeLane(deps, confirmed, note ?? "explicit reopen", true);
    if (resumed.code !== 0) return resumed;
    const delivery = note ? await sendVerified(rts, deps.clock, ref, `[LEAD] ${note}`) : undefined;
    return {
      lane: resumed.lane,
      code: delivery && delivery !== "delivered" ? 3 : 0,
      lines: [
        `REOPENED ${lane.key} pane=${ref.id} session=${lane.session} goal resumed${delivery ? ` note=${delivery}; never resend automatically` : ""}`,
      ],
    };
  });
  return held.ok ? held.value : { lane: seen, lines: [`HELD ${seen.key} delivery lock: ${held.holder}`], code: 3 };
};
