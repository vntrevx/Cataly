import { configPath, fill } from "./config.ts";
import type { FlowDeps } from "./done-flow.ts";
import { BRIEF_START, footer, originalBrief, quoteForPane } from "./launch-footer.ts";
import { isPolicyLaneCommand } from "./lane-policy-launch.ts";
import { parseRef } from "../../../../src/runtime/types.ts";
import { openLaneSession } from "./launch-session.ts";
import { LANE_KEY, type Lane, RESERVED_LANE_KEY, sessionFields, upgradeLane } from "./registry.ts";
import { iso, runtimesOf } from "./run.ts";
import { Reports } from "./reports.ts";
import { doneSyntaxErrors } from "./signals.ts";
import type { BudgetLimits } from "./supervision-observe.ts";
import { Lessons, renderLessons } from "./lessons.ts";
import { laneLaunchEnv, TokenFileError } from "./slack-token.ts";
import { confirmLaunch, lastLines } from "./launch-finished.ts";
import { policyBinding, prepareLanePolicy, writeLanePolicy } from "./lane-policy-store.ts";

export type LaunchInput = {
  readonly key: string;
  readonly title: string;
  readonly brief: string;
  readonly done: string;
  readonly thread?: string;
  readonly model?: string;
  readonly cwd?: string;
  readonly budget?: BudgetLimits;
  readonly activityPaths?: readonly string[];
};

export class LaunchError extends Error {}

export const validateLaunch = async (deps: FlowDeps, input: LaunchInput): Promise<void> => {
  if (!LANE_KEY.test(input.key)) throw new LaunchError(`key must match ${LANE_KEY}`);
  if (input.key === RESERVED_LANE_KEY)
    throw new LaunchError(`lane key "${RESERVED_LANE_KEY}" is reserved for the lead`);
  if (await deps.registry.read(input.key)) throw new LaunchError(`lane ${input.key} is already registered`);
  const errors = doneSyntaxErrors(input.done);
  if (errors.length) throw new LaunchError(`Done line is not checkable: ${errors.join("; ")}`);
  for (const [name, value] of Object.entries(input.budget ?? {})) {
    if (value != null && (!Number.isFinite(value) || value < 0)) throw new LaunchError(`invalid ${name} ceiling`);
  }
};

export const adoptLane = async (deps: FlowDeps, input: LaunchInput & { readonly pane: string }): Promise<Lane> => {
  await validateLaunch(deps, input);
  const base: Lane = {
    key: input.key,
    title: input.title,
    thread: input.thread ?? "none",
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

export const prepareLaunch = async (
  deps: FlowDeps,
  input: LaunchInput,
): Promise<{ readonly lane: Lane; readonly preamble: string; readonly warnings: string[] }> => {
  await validateLaunch(deps, input);
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  if (deps.config.lanePolicy !== undefined && !isPolicyLaneCommand(deps.config.agentCommand))
    throw new LaunchError("lanePolicy requires fresh, unambiguous native OMP argv with --dori-role lane");
  const briefFile = Bun.file(input.brief);
  if (!(await briefFile.exists())) throw new LaunchError(`brief not found: ${input.brief}`);
  const draft: Lane = {
    key: input.key,
    title: input.title,
    thread: input.thread ?? "none",
    brief: input.brief,
    done: input.done,
    cwd,
    model,
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
  return {
    lane: draft,
    // A lesson the cap kept out is named too: a brief that silently lacks a standing rule is the bug this catches.
    warnings: [
      ...problems.map((problem) => `LESSON_WARNING ${problem}`),
      ...omitted.map(
        (lesson) => `LESSON_OMITTED ${lesson.id} (${lesson.scope === "global" ? "global" : lesson.cwd}) ${lesson.rule}`,
      ),
    ],
    preamble: `${renderLessons(lessons)}${BRIEF_START}\n${originalBrief(await briefFile.text())}\n${footer(draft, deps.config.leadPane, deps.config.repoIdentities, runtimesOf(deps).choice?.kind)}`,
  };
};

export const launchLane = async (
  deps: FlowDeps,
  input: LaunchInput,
): Promise<{ readonly lane: Lane; readonly startup: string; readonly warnings: string[] }> => {
  const prepared = await prepareLaunch(deps, input);
  return { ...(await startLane(deps, input, prepared.lane, prepared.preamble)), warnings: prepared.warnings };
};

const startLane = async (
  deps: FlowDeps,
  input: LaunchInput,
  draft: Lane,
  preamble: string,
): Promise<{ readonly lane: Lane; readonly startup: string }> => {
  const model = input.model ?? deps.config.defaultModel;
  const cwd = input.cwd ?? deps.config.defaultCwd;
  const rts = runtimesOf(deps);
  const group = deps.config.laneWorkspace || undefined;
  const policy = prepareLanePolicy(deps.config.stateDir, input.key, deps.config.lanePolicy);
  let env: Record<string, string>;
  try {
    env = {
      ...laneLaunchEnv(process.env, configPath(), deps.config),
      DORI_LANE_POLICY: policy ? policyBinding(policy) : "",
    };
  } catch (e) {
    throw e instanceof TokenFileError ? new LaunchError(`token file refused: ${e.message}`) : e;
  }
  const spec = { name: input.key, role: "lane", container: "tab", cwd, env } as const;
  const opened = await openLaneSession(
    deps.registry,
    rts,
    group === undefined ? spec : { ...spec, group },
    draft,
    input.brief,
    preamble,
  );
  if (opened.kind === "failed") {
    const why = opened.error instanceof Error ? opened.error.message : String(opened.error);
    throw new LaunchError(`${opened.what}: ${why}`);
  }
  if (opened.kind === "taken") throw new LaunchError(`lane ${input.key} is already registered`);
  const { lane, ref } = opened;
  if (policy) writeLanePolicy(policy);
  const pane = ref.id;
  // The launch is an activity record, not a report: it starts the journal (so the screen is watched for a stall) but is
  // never posted to the thread as if the agent had reported.
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
    await rts.for(ref).start(ref, fill(deps.config.agentCommand, { model, prompt }).map(quoteForPane).join(" "));
  } catch (e) {
    return { lane, startup: `STARTUP_ERROR ${input.key} ${pane}: start failed: ${lastLines(String(e))}` };
  }
  return confirmLaunch(deps, lane, ref, launchedAt);
};
