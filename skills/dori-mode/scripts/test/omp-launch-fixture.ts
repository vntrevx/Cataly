import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PaneState } from "../src/lane-state.ts";
import { launchLane } from "../src/launch.ts";
import { snapshotFor } from "./model-snapshot-fixture.ts";
import { Reports } from "../src/reports.ts";
import { sessionDirFor } from "../src/session-id.ts";
import { agentIn, depsFor, fakeClock, laneState, newWorld, type TestState } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let n = 0;

export type OmpLaunchOptions = {
  firstLane?: string;
  at?: string;
  screen?: string;
  slow?: boolean;
  packageCommand?: boolean;
  model?: string;
  startDelay?: number;
  suspended?: boolean;
  unreportedUntil?: number;
  startupWaitSeconds?: number;
  goalMarker?: string;
  finish?: { after: number; kind: "closed" | "verified-done" | "journal"; readFailure?: string };
};

export const startOmpLane = async (
  state: TestState,
  key: string,
  patch: Partial<PaneState> = {},
  options: OmpLaunchOptions = {},
) => {
  const brief = join(state.dir, `${key}.md`);
  writeFileSync(brief, "# Ship the fixture\n");
  const sessionsDir = join(state.dir, "omp-store");
  const dir = sessionDirFor(sessionsDir, "/repo");
  mkdirSync(dir, { recursive: true });
  const id = `01a1b6d8-0000-7000-8000-${String(++n).padStart(12, "0")}`;
  const at = options.at ?? "2026-01-01T12:00:03.000Z";
  const sessionFile = join(dir, `${at.replace(/:/g, "-").replace(".", "-")}_${id}.jsonl`);
  writeFileSync(
    sessionFile,
    `${[
      { type: "session", id, timestamp: at, cwd: "/repo" },
      {
        type: "message",
        message: {
          role: "user",
          content: [
            {
              type: "text",
              text: `Read the brief at ${brief}. You are the ${options.firstLane ?? key} lane; report as the footer says.`,
            },
          ],
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  const world = newWorld();
  world.screen = options.screen ?? "Working (12s)\nprompt\nGoal: ...";
  world.screens = [options.screen && patch.goal?.status === "none" && !options.slow ? options.screen : "Native idle"];
  world.panes = [{ pane_id: "w:p9", workspace_id: "w", agent: "omp", agent_status: "idle" }];
  if (options.unreportedUntil && world.panes[0]) world.panes[0].agent_status = "unknown";
  if (options.suspended && world.panes[0]) world.panes[0].foreground = "zsh";
  agentIn(world, "w:p9");
  const [provider = "", modelId = ""] = (options.model ?? "anthropic/claude-opus-5-5").split("/");
  const readback = {
    requested: { provider, id: modelId },
    observed: { provider, id: modelId },
    status: "matched" as const,
    billing: "subscription" as const,
    checkedAt: "2026-01-01T12:00:00.000Z",
    source: "native-extension" as const,
  };
  const modelSnapshot = snapshotFor(`${provider}/${modelId}`);
  let modelProfileFile: string | undefined;
  const nativeState = () => ({
    sessionId: id,
    sessionFile,
    modelReadback: readback,
    modelSnapshot,
    ...(modelProfileFile === undefined ? {} : { modelProfileFile }),
  });
  let delivered = false;
  laneState(state.dir, "w:p9", { ...nativeState(), agentStatus: "idle", ...patch });
  world.onSendText = () => {
    delivered = true;
    laneState(state.dir, "w:p9", {
      ...nativeState(),
      agentStatus: "working",
      ...patch,
    });
    if (world.panes[0]) world.panes[0].agent_status = "working";
  };
  const clock = fakeClock(T0);
  let finished = false;
  const base = depsFor(
    world,
    {
      ...clock,
      sleep: async (ms) => {
        clock.at += ms;
        if (options.unreportedUntil && clock.at >= T0 + options.unreportedUntil && world.panes[0])
          world.panes[0].agent_status = delivered ? "working" : "idle";
        if (options.finish && !finished && clock.at >= T0 + options.finish.after) {
          const current = await base.registry.read(key);
          if (!current) throw new Error("lane not registered before startup check");
          if (options.finish.kind === "journal") new Reports(state.dir).report(key, "done", "finished", clock.at);
          else await base.registry.write({ ...current, status: options.finish.kind });
          world.panes = [];
          finished = true;
        }
        if (options.slow && ms === 10_000)
          laneState(state.dir, "w:p9", {
            ...nativeState(),
            agentStatus: delivered ? "working" : "idle",
            goal: { status: "active" },
          });
      },
    },
    state.dir,
    {
      sessionsDir,
      ...(options.startupWaitSeconds === undefined ? {} : { startupWaitSeconds: options.startupWaitSeconds }),
      ...(options.goalMarker === undefined ? {} : { goalMarker: options.goalMarker }),
      ...(options.packageCommand
        ? {
            agentCommand: [
              "bun",
              "/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js",
              "--dori-role",
              "lane",
              "--model",
              "{model}",
              "{prompt}",
            ],
          }
        : {}),
    },
  );
  const deps = {
    ...base,
    run: async (argv: readonly string[]) => {
      if (finished && options.finish?.readFailure && argv[0] === "herdr" && argv[2] === "read")
        return { code: 1, out: "", err: options.finish.readFailure };
      if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")
        return {
          code: 0,
          out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
          err: "",
        };
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "run") {
        clock.at += options.startDelay ?? 0;
        modelProfileFile = (await base.registry.read(key))?.modelProfileFile;
        laneState(state.dir, "w:p9", { ...nativeState(), agentStatus: "idle", ...patch });
      }
      return base.run(argv);
    },
  };
  const result = await launchLane(deps, {
    key,
    title: "fixture",
    brief,
    done: "closed acme/app#3",
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  return { result, world };
};
