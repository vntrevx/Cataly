import type { Runtimes } from "../../../../src/runtime/registry.ts";
import { isKind } from "../../../../src/runtime/hc/exec.ts";
import { reasonOf, ToolError } from "../../../../src/runtime/herdr/exec.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { finished } from "./boot-monitors.ts";
import type { FlowDeps } from "./done-flow.ts";
import { Reports } from "./reports.ts";
import { startupScreen, startupFailure } from "./startup-screen.ts";
import { mayRunOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import { laneGoalActive } from "./goal-record.ts";
import type { Lane } from "./registry.ts";
import { runtimesOf } from "./run.ts";

const missingSession = (ref: SessionRef, error: unknown): boolean =>
  isKind(error, "not_found") ||
  (ref.runtime === "herdr" && error instanceof ToolError && /not.?found/i.test(reasonOf(error)));

const launchFinished = async (deps: FlowDeps, key: string): Promise<boolean> => {
  const lane = await deps.registry.read(key);
  return lane !== null && finished({ ...lane, reportState: new Reports(deps.config.stateDir).read(key)?.state });
};

const launchScreen = async (deps: FlowDeps, rts: Runtimes, ref: SessionRef, key: string): Promise<string | null> => {
  try {
    return await startupScreen(rts, ref);
  } catch (error) {
    if (missingSession(ref, error) && (await launchFinished(deps, key))) return null;
    throw error;
  }
};

/**
 * The runtime's own status word for the lane's session. Unlike agentStatus it keeps `shell` (no agent in the session)
 * apart from no status yet: herdr lists an agent that has not reported as `unknown` and a pane with no agent as `shell`.
 * hc lists both with no status, so a session listed with none is probed, which names a shell in front. A session missing
 * from the list is `gone`. OMP instead uses its live-process-bound probe, including approval and shell guards.
 */
const launchStatus = async (
  rts: Runtimes,
  ref: SessionRef,
  ompAgent: boolean,
): Promise<{ status?: string; error?: string }> => {
  try {
    if (ompAgent) {
      const seen = await rts.for(ref).probe(ref);
      return { status: seen.status !== "gone" && seen.shellInFront ? "shell" : seen.status };
    }
    const found = (await rts.for(ref).list()).find((s) => s.ref.id === ref.id);
    if (!found) return { status: "gone" };
    if (found.status !== undefined) return { status: found.status };
    const probed = (await rts.for(ref).probe(ref)).status;
    return probed === "shell" || probed === "gone" ? { status: probed } : {};
  } catch (e) {
    if (missingSession(ref, e)) return { status: "gone" };
    return { error: e instanceof Error ? e.message : String(e) };
  }
};

// The first check is 20 s after start, then the screen and status are re-read every 10 s until `startupWaitSeconds`.
const FIRST_CHECK_MS = 20_000;
const RECHECK_MS = 10_000;
const ready = (s: string | undefined): boolean => s === "idle" || s === "working";
const unreported = (s: string | undefined): boolean => s === undefined || s === "unknown";
// OMP goals come from its trusted current-session record, never quoted screen text. Custom agents may use their
// footer marker or omo goal record. An empty marker opts out of the goal check, not the ready-status check.
const goalShown = (screen: string, marker: string): boolean =>
  screen
    .split("\n")
    .filter((s) => s.trim())
    .slice(-3)
    .join("\n")
    .includes(marker);

export const confirmLaunch = async (
  deps: FlowDeps,
  lane: Lane,
  ref: SessionRef,
  launchedAt: number,
): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  const rts = runtimesOf(deps);
  const cwd = lane.cwd ?? deps.config.defaultCwd;
  const pane = ref.id;
  const started = deps.clock.now();
  await deps.clock.sleep(FIRST_CHECK_MS);
  const screen = await launchScreen(deps, rts, ref, lane.key);
  if (screen === null) return { lane, startup: `STARTUP_DONE ${lane.key}` };
  const ompAgent = mayRunOmpArgv(deps.config.agentCommand);
  const { status, error } = await launchStatus(rts, ref, ompAgent);
  const marker = deps.config.goalMarker;
  const omp = ompAgent ? { run: deps.run, rts, stateDir: deps.config.stateDir, ref } : undefined;
  const recordedGoal = () => laneGoalActive(deps.config.sessionsDir, cwd, lane.key, launchedAt, omp);
  const hasGoal = async (shown: string): Promise<boolean> =>
    (!omp && goalShown(shown, marker)) || (await recordedGoal());
  // A working agent with its goal may be reading a file or log that quotes a failure phrase, as the re-checks allow. An
  // empty goal marker opts out of the goal check, so only a recorded goal vouches for one here.
  const bad = startupFailure(screen, ompAgent);
  const goalProven = async (): Promise<boolean> =>
    (marker !== "" && !omp && goalShown(screen, marker)) || (await recordedGoal());
  if (bad && !(status === "working" && !error && (await goalProven())))
    return { lane, startup: `STARTUP_ERROR ${lane.key} ${pane}: ${bad}` };
  if (status === "gone" && (await launchFinished(deps, lane.key))) return { lane, startup: `STARTUP_DONE ${lane.key}` };
  // No status and no lookup error is an agent still starting (a slow host can take minutes, #202): it is waited for in
  // the goal wait. A lookup error, a `shell` or any other status ends the launch below at once.
  if (ready(status) || (unreported(status) && !error)) {
    const rechecks = Math.max(0, Math.ceil((deps.config.startupWaitSeconds * 1000 - FIRST_CHECK_MS) / RECHECK_MS));
    let shown = screen;
    let current = status;
    for (let check = 0; !ready(current) || (marker && !(await hasGoal(shown))); check++) {
      if (check >= rechecks) {
        const waited = Math.round((deps.clock.now() - started) / 1000);
        return {
          lane,
          startup: ready(current)
            ? `STARTUP_NO_GOAL ${lane.key} ${pane}: the agent is running but shows no goal after ${waited} s; last lines: ${lastLines(shown)}`
            : `STARTUP_UNCONFIRMED ${lane.key} ${pane}: no ready agent status (${current ?? "none"}) after ${waited} s; last lines: ${lastLines(shown)}`,
        };
      }
      await deps.clock.sleep(RECHECK_MS);
      const nextScreen = await launchScreen(deps, rts, ref, lane.key);
      if (nextScreen === null) return { lane, startup: `STARTUP_DONE ${lane.key}` };
      shown = nextScreen;
      // The goal is only good news while the agent is still running: re-check the status on every re-read.
      const again = await launchStatus(rts, ref, ompAgent);
      current = again.status;
      if (current === "gone" && (await launchFinished(deps, lane.key)))
        return { lane, startup: `STARTUP_DONE ${lane.key}` };
      if (again.error || !(ready(current) || unreported(current))) {
        const lost = again.error
          ? `status lookup failed: ${again.error}`
          : `agent status became ${again.status ?? "none"}`;
        return {
          lane,
          startup: `STARTUP_UNCONFIRMED ${lane.key} ${pane}: ${lost} while waiting for its goal; last lines: ${lastLines(shown)}`,
        };
      }
      // A late failure stops the agent. A working agent's own output may quote these phrases (a file or log it reads),
      // so only a non-working agent with no goal is checked for one, including a still-unreported slow start.
      const failed = current !== "working" && !(await hasGoal(shown)) ? startupFailure(shown, ompAgent) : null;
      if (failed) return { lane, startup: `STARTUP_ERROR ${lane.key} ${pane}: ${failed}` };
    }
    return { lane, startup: `STARTUP_OK ${lane.key} ${pane}` };
  }
  const why = error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
  return { lane, startup: `STARTUP_UNCONFIRMED ${lane.key} ${pane}: ${why}; last lines: ${lastLines(screen)}` };
};

export const lastLines = (screen: string): string =>
  screen
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" / ")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .slice(0, 240) || "(blank)";
