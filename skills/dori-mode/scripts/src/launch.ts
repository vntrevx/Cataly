import { configPath, fill } from "./config.ts";
import { renderTemplate } from "./launch-template.ts";
import { type LaunchInput, validateLaunch } from "./launch-input.ts";
import type { FlowDeps } from "./done-flow.ts";
import { withLaunchLock } from "./delivery-lock.ts";
import { laneGoalActive } from "./goal-record.ts";
import { BRIEF_START, footer, originalBrief } from "./launch-footer.ts";
import { mayRunOmpArgv } from "../../../../src/runtime/omp-argv.ts";
import { parseRef } from "../../../../src/runtime/types.ts";
import { selectionFor } from "./launch-selection.ts";
import { laneStartCommand, openLaneSession, type OpenedLane } from "./launch-session.ts";
import { type Lane, sessionFields, upgradeLane } from "./registry.ts";
import { type ChosenRuntimes, iso, runtimesOf } from "./run.ts";
import { Reports } from "./reports.ts";
import { Lessons, renderLessons } from "./lessons.ts";
import { laneLaunchEnv, TokenFileError } from "./slack-token.ts";
import { startupFailure } from "./startup-screen.ts";
import { launchFinished, launchScreen, launchStatus } from "./launch-finished.ts";

export class LaunchError extends Error {}
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

export const adoptLane = async (
  deps: FlowDeps,
  input: LaunchInput & { readonly pane: string },
  locked = false,
): Promise<Lane> => {
  await validateLaunch(deps, input, LaunchError);
  if (!locked) {
    const held = await withLaunchLock(deps, input.key, () => adoptLane(deps, input, true));
    if (!held.ok) throw new LaunchError(`lane ${input.key} held: ${held.holder}`);
    return held.value;
  }
  const base: Lane = {
    key: input.key,
    title: input.title,
    thread: input.thread?.trim() ? input.thread : "none",
    brief: input.brief,
    done: input.done,
    cwd: input.cwd ?? deps.config.defaultCwd,
    openedAt: iso(deps.clock),
  };
  // `hc:t7` or `herdr:w1:p3` names its runtime; any other id is a herdr pane, as before runtimes existed.
  const ref = parseRef(input.pane);
  const lane = ref ? { ...base, ...sessionFields(ref) } : upgradeLane({ ...base, pane: input.pane });
  if (!(await deps.registry.create(lane))) throw new LaunchError(`lane ${input.key} is already registered`);
  return lane;
};

export const prepareLaunch = async (deps: FlowDeps, input: LaunchInput, queuedBrief?: string) => {
  await validateLaunch(deps, input, LaunchError);
  const cwd = input.cwd ?? deps.config.defaultCwd;
  let briefText: string;
  if (queuedBrief !== undefined) {
    briefText = queuedBrief;
  } else if (input.template) {
    briefText = renderTemplate(input.template, input.variables ?? {}, deps.env?.["DORI_CONFIG"] ?? configPath());
  } else {
    const briefFile = Bun.file(input.brief);
    if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
    briefText = originalBrief(await briefFile.text());
  }
  const draft: Lane = {
    key: input.key,
    title: input.title,
    thread: input.thread?.trim() ? input.thread : "none",
    brief: input.brief,
    done: input.done,
    cwd,
    model: input.model ?? deps.config.defaultModel,
    launchSelection: selectionFor(deps.config),
    openedAt: iso(deps.clock),
    reportProtocol: "jsonl-v1",
    budget: {
      ...deps.config.supervision.defaults,
      ...deps.config.supervision.lanes?.[input.key],
      // An undefined field is absent, so it keeps the configured ceiling; only null turns one off.
      ...Object.fromEntries(Object.entries(input.budget ?? {}).filter(([, value]) => value !== undefined)),
    },
    activityPaths: input.activityPaths ?? [],
  };
  // A damaged journal line is a warning: it must not keep a lane from starting or hide the lessons around it.
  const { lessons, problems, omitted } = new Lessons(deps.config.stateDir).forRepo(cwd);
  // A lesson the cap kept out is named too: a brief that silently lacks a standing rule is the bug this catches.
  const warnings = [
    ...problems.map((problem) => `LESSON_WARNING ${problem}`),
    ...omitted.map(
      (lesson) => `LESSON_OMITTED ${lesson.id} (${lesson.scope === "global" ? "global" : lesson.cwd}) ${lesson.rule}`,
    ),
  ];
  const { leadPane, repoIdentities, freshness } = deps.config;
  const laneFooter = footer(draft, leadPane, repoIdentities, runtimesOf(deps).choice?.kind, freshness);
  const preamble = `${renderLessons(lessons)}${BRIEF_START}\n${briefText}\n${laneFooter}`;
  return { lane: draft, briefText, preamble, warnings } as const;
};

export const launchLane = async (
  deps: FlowDeps,
  input: LaunchInput,
): Promise<{ readonly lane: Lane; readonly startup: string; readonly warnings: string[] }> => {
  await validateLaunch(deps, input, LaunchError);
  const held = await withLaunchLock(deps, input.key, async () => {
    const opened = await openLaunch(deps, input);
    return { ...(await opened.start()), warnings: opened.warnings };
  });
  if (!held.ok) throw new LaunchError(`lane ${input.key} held: ${held.holder}`);
  return held.value;
};

/** Caller holds the per-key launch lock; capacity admission only needs to span this phase. */
export const openLaunch = async (deps: FlowDeps, input: LaunchInput, queuedBrief?: string) => {
  const { lane: draft, preamble, warnings } = await prepareLaunch(deps, input, queuedBrief);
  const rts = runtimesOf(deps);
  const group = deps.config.laneWorkspace || undefined;
  let env: Record<string, string>;
  try {
    env = laneLaunchEnv(process.env, configPath(), deps.config);
  } catch (e) {
    throw e instanceof TokenFileError ? new LaunchError(`token file refused: ${e.message}`) : e;
  }
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const spec = { name: input.key, role: "lane", container: "tab", cwd, env } as const;
  const opened = await openLaneSession(deps.registry, rts, group === undefined ? spec : { ...spec, group }, draft, {
    preamble,
    generated: queuedBrief !== undefined || Boolean(input.template),
  });
  if (opened.kind === "failed") {
    const why = opened.error instanceof Error ? opened.error.message : String(opened.error);
    throw new LaunchError(`${opened.what}: ${why}`);
  }
  if (opened.kind === "taken") throw new LaunchError(`lane ${input.key} is already registered`);
  return { warnings, start: () => startLane(deps, input, { opened, rts }) };
};

const startLane = async (
  deps: FlowDeps,
  input: LaunchInput,
  { opened, rts }: { readonly opened: Extract<OpenedLane, { kind: "opened" }>; readonly rts: ChosenRuntimes },
): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const { lane, ref } = opened;
  const pane = ref.id;
  // Launch starts the activity journal; it is not a lane report and is never posted to the thread.
  new Reports(deps.config.stateDir).append({
    type: "activity",
    key: lane.key,
    at: iso(deps.clock),
    state: "running",
    text: `lane launched in ${pane}`,
  });
  const prompt = `${deps.config.launchKeywords}. Read and execute the lane brief at ${input.brief} in full. You are the ${input.key} lane; report as the brief's footer says.`;
  // The session can be written while start is still returning; its goal must belong to this invocation.
  const launchedAt = deps.clock.now();
  try {
    await rts.for(ref).start(ref, laneStartCommand(lane, fill(deps.config.agentCommand, { model, prompt })));
  } catch (e) {
    return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: start failed: ${lastLines(String(e))}` };
  }
  const started = deps.clock.now();
  await deps.clock.sleep(FIRST_CHECK_MS);
  const screen = await launchScreen(deps, rts, ref, input.key);
  if (screen === null) return { lane, startup: `STARTUP_DONE ${input.key}` };
  const ompAgent = mayRunOmpArgv(deps.config.agentCommand);
  const { status, error } = await launchStatus(rts, ref, ompAgent);
  const marker = deps.config.goalMarker;
  const omp = ompAgent ? { run: deps.run, rts, stateDir: deps.config.stateDir, ref } : undefined;
  const recordedGoal = () => laneGoalActive(deps.config.sessionsDir, cwd, input.key, launchedAt, omp);
  const hasGoal = async (shown: string): Promise<boolean> =>
    (!omp && goalShown(shown, marker)) || (await recordedGoal());
  // A working agent with its goal may be reading a file or log that quotes a failure phrase, as the re-checks allow. An
  // empty goal marker opts out of the goal check, so only a recorded goal vouches for one here.
  const bad = startupFailure(screen, ompAgent);
  const goalProven = async (): Promise<boolean> =>
    (marker !== "" && !omp && goalShown(screen, marker)) || (await recordedGoal());
  if (bad && !(status === "working" && !error && (await goalProven())))
    return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: ${bad}` };
  if (status === "gone" && (await launchFinished(deps, input.key)))
    return { lane, startup: `STARTUP_DONE ${input.key}` };
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
            ? `STARTUP_NO_GOAL ${input.key} ${pane}: the agent is running but shows no goal after ${waited} s; last lines: ${lastLines(shown)}`
            : `STARTUP_UNCONFIRMED ${input.key} ${pane}: no ready agent status (${current ?? "none"}) after ${waited} s; last lines: ${lastLines(shown)}`,
        };
      }
      await deps.clock.sleep(RECHECK_MS);
      const nextScreen = await launchScreen(deps, rts, ref, input.key);
      if (nextScreen === null) return { lane, startup: `STARTUP_DONE ${input.key}` };
      shown = nextScreen;
      // The goal is only good news while the agent is still running: re-check the status on every re-read.
      const again = await launchStatus(rts, ref, ompAgent);
      current = again.status;
      if (current === "gone" && (await launchFinished(deps, input.key)))
        return { lane, startup: `STARTUP_DONE ${input.key}` };
      if (again.error || !(ready(current) || unreported(current))) {
        const lost = again.error
          ? `status lookup failed: ${again.error}`
          : `agent status became ${again.status ?? "none"}`;
        return {
          lane,
          startup: `STARTUP_UNCONFIRMED ${input.key} ${pane}: ${lost} while waiting for its goal; last lines: ${lastLines(shown)}`,
        };
      }
      // A late failure stops the agent. A working agent's own output may quote these phrases (a file or log it reads),
      // so only a non-working agent with no goal is checked for one, including a still-unreported slow start.
      const failed = current !== "working" && !(await hasGoal(shown)) ? startupFailure(shown, ompAgent) : null;
      if (failed) return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: ${failed}` };
    }
    return { lane, startup: `STARTUP_OK ${input.key} ${pane}` };
  }
  const why = error ? `status lookup failed: ${error}` : `no ready agent status (${status ?? "none"})`;
  return { lane, startup: `STARTUP_UNCONFIRMED ${input.key} ${pane}: ${why}; last lines: ${lastLines(screen)}` };
};

const lastLines = (screen: string): string =>
  screen
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-3)
    .join(" / ")
    .replace(/\/(Users|home|Volumes|private)\/\S+/g, "(local path)")
    .slice(0, 240) || "(blank)";
