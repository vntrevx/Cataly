import { afterEach, beforeEach, expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "../src/done-flow.ts";
import {
  type ModelReadback,
  type ModelSnapshot,
  type PaneState,
  readPaneState,
  writePaneState,
} from "../src/lane-state.ts";
import {
  claimModelSwitch,
  type ModelSwitchIdentity,
  type ModelSwitchRequest,
  type ModelSwitchResult,
} from "../src/model-switch-state.ts";
import { requestLaneModelSwitch } from "../src/model-switch.ts";
import type { Lane } from "../src/registry.ts";
import type { Clock } from "../src/run.ts";
import { agentIn, depsFor, newWorld, type TestState, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T13:00:00.000Z");
export const STARTED = "2026-01-01T12:00:00.000Z";
export const KEY = "switch-lane";
export const HEAD_PANE = "w1:p1";
export const LANE_PANE = "w1:p7";
// The head is this test process, as the native extension that calls the coordinator is; the lane is another agent.
export const LANE_PID = process.pid + 100;
const HEAD_SESSION = "01a11440-ee81-7f90-b2ed-00000000d041";
const LANE_SESSION = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
export const OTHER_SESSION = "01a11440-0000-7000-8000-00000000beef";
export const OLD = "acme/old-model";
export const NEW = "acme/new-model";

/** What the lane's native `/dori-model-apply` handler does once Enter submits the typed command. */
type Apply = (key: string, nonce: string) => Promise<void> | void;

export let state: TestState;
export let world: World;
export let deps: FlowDeps;
let clock: Clock & { at: number };
let cwd: string;
export let laneFile: string;
export let claimed: ModelSwitchRequest[];

export const at = (): string => new Date(clock.at).toISOString();

const parts = (model: string): { provider: string; id: string } => {
  const [provider = "", id = ""] = model.split("/");
  return { provider, id };
};

export const readback = (model: string, checkedAt: string, requested = model): ModelReadback => ({
  requested: parts(requested),
  observed: parts(model),
  status: "matched",
  billing: "subscription",
  checkedAt,
  source: "native-extension",
});

export const snapshot = (
  id: string,
  model: string,
  kind: "launch" | "idle-switch",
  capturedAt: string,
  requested = model,
): ModelSnapshot => ({
  version: 1,
  id,
  model: parts(model),
  modelRoles: { default: model },
  defaultThinkingLevel: "high",
  configuredThinkingLevel: null,
  thinkingLevel: null,
  capturedAt,
  provenance: { kind, requested, modelRoles: { default: "overlay" }, defaultThinkingLevel: "global" },
});

const pane = (paneId: string): PaneState => {
  const current = readPaneState(state.dir, paneId);
  if (!current) throw new Error(`no pane state for ${paneId}`);
  return current;
};
export const head = (): PaneState => pane(HEAD_PANE);
export const lane = (): PaneState => pane(LANE_PANE);
export const writePane = (paneId: string, patch: Partial<PaneState>): void =>
  writePaneState(state.dir, { ...pane(paneId), updatedAt: at(), ...patch });

export const registered = async (): Promise<Lane> => {
  const current = await deps.registry.read(KEY);
  if (!current) throw new Error("lane not registered");
  return current;
};

export const identity = (s: PaneState): ModelSwitchIdentity => ({
  paneId: s.paneId,
  pid: s.pid,
  sessionId: s.sessionId,
  sessionFile: s.sessionFile ?? "",
  startedAt: s.startedAt,
});

/** The native claim exactly as the extension runs it: the receipt is written inside the registry lock. */
export const claim = async (key: string, nonce: string): Promise<ModelSwitchRequest | null> => {
  const request = await claimModelSwitch(deps.registry, key, nonce, lane(), (receipt) =>
    writePane(LANE_PANE, { modelSwitch: receipt }),
  );
  if (request) claimed.push(request);
  return request;
};

/**
 * The native session after a finished switch, in one pane-state write: a new idle-switch snapshot in the same
 * process-owned profile, its readback and the `changed` receipt.
 */
export const changed = (request: ModelSwitchRequest, model = request.requested, patch: Partial<PaneState> = {}): void =>
  writePane(LANE_PANE, {
    modelSnapshot: snapshot(`snap-${request.nonce}`, model, "idle-switch", at(), request.requested),
    modelReadback: readback(model, at(), request.requested),
    modelSwitch: { nonce: request.nonce, status: "changed" },
    ...patch,
  });

export const changes =
  (model?: string, patch?: (request: ModelSwitchRequest) => Partial<PaneState>): Apply =>
  async (key, nonce) => {
    const request = await claim(key, nonce);
    if (request) changed(request, model, patch?.(request));
  };

export const switchTo = (model: string, from: PaneState = head(), via: FlowDeps = deps): Promise<ModelSwitchResult> =>
  requestLaneModelSwitch(via, KEY, model, from);

export const control: { apply: Apply; ticks?: () => void } = { apply: changes() };

export const modelSwitchSetup = (): void => {
  beforeEach(async () => {
    state = withState();
    world = newWorld();
    claimed = [];
    delete control.ticks;
    cwd = join(state.dir, "repo");
    mkdirSync(cwd);
    laneFile = join(state.dir, "lane.jsonl");
    const headFile = join(state.dir, "head.jsonl");
    writeFileSync(laneFile, "");
    writeFileSync(headFile, "");
    world.panes = [
      { pane_id: HEAD_PANE, workspace_id: "w1", agent: "omp", agent_status: "working" },
      { pane_id: LANE_PANE, workspace_id: "w1", agent: "omp", agent_status: "idle" },
    ];
    agentIn(world, HEAD_PANE, process.pid);
    agentIn(world, LANE_PANE, LANE_PID);
    const headState: PaneState = {
      paneId: HEAD_PANE,
      role: "dori",
      sessionId: HEAD_SESSION,
      sessionFile: headFile,
      cwd,
      pid: process.pid,
      startedAt: STARTED,
      updatedAt: STARTED,
      goal: { status: "none" },
      approvalPending: false,
      agentStatus: "working",
    };
    const launched = {
      modelReadback: readback(OLD, STARTED),
      modelSnapshot: snapshot("snap-launch", OLD, "launch", STARTED),
      modelProfileFile: join(state.dir, "model-profiles", "launch.json"),
    };
    writePaneState(state.dir, headState);
    writePaneState(state.dir, {
      ...headState,
      paneId: LANE_PANE,
      role: "lane",
      sessionId: LANE_SESSION,
      sessionFile: laneFile,
      pid: LANE_PID,
      goal: { status: "paused", objective: "ship it" },
      agentStatus: "idle",
      ...launched,
    });
    clock = {
      at: T0,
      now: () => clock.at,
      sleep: async (ms) => {
        clock.at += ms;
        control.ticks?.();
      },
    };
    control.apply = changes();
    const fake = depsFor(world, clock, state.dir, { defaultCwd: cwd });
    let typed: string | undefined;
    deps = {
      ...fake,
      env: { HERDR_PANE_ID: HEAD_PANE, HERDR_WORKSPACE_ID: "w1" },
      run: async (argv, options) => {
        const result = await fake.run(argv, options);
        if (argv[0] === "herdr" && argv[2] === "send-text" && argv[3] === LANE_PANE) typed = argv[4];
        if (argv[0] === "herdr" && argv[2] === "send-keys" && argv[3] === LANE_PANE && argv[4] === "enter" && typed) {
          const [command, key = "", nonce = ""] = typed.split(" ");
          typed = undefined;
          if (command === "/dori-model-apply") await control.apply(key, nonce);
        }
        return result;
      },
    };
    await deps.registry.write({
      key: KEY,
      title: "switch",
      thread: "none",
      pane: LANE_PANE,
      tab: "w1:t7",
      brief: join(state.dir, "brief.md"),
      done: "merged acme/app#1",
      cwd,
      session: LANE_SESSION,
      sessionFile: laneFile,
      model: OLD,
      ...launched,
      status: "paused",
      openedAt: STARTED,
    });
  });

  afterEach(() => state.done());
};

export const expectUnchanged = async (): Promise<void> => {
  const current = await registered();
  expect(current.model).toBe(OLD);
  expect(current.modelSnapshot?.id).toBe("snap-launch");
  expect(current.modelSwitchRequest).toBeUndefined();
};
