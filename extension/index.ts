/**
 * omp-dori: Dori mode on omp. Installed in the global extensions directory, so every omp session loads it, but only
 * sessions with a Dori role change behaviour; every other session runs exactly as without it.
 *
 * - Role: `--dori-role dori|lane` is recorded in the session file on session_start and re-read from the session
 *   branch on every session change, so `--resume` and herdr restores keep it without the flag. Subagents inherit
 *   their spawning agent's role.
 * - A nonempty config `ompUlwPath` applies omp-ulw through a gated API: its event, command and tool handlers run
 *   only in role sessions; load-time registrations stay visible everywhere. Source installs leave it empty for OMP loading.
 * - Pane state (`{stateDir}/sessions/<pane>.json`, read by the `dori` CLI): session id, goal status and open tool
 *   approvals of the Dori/lane session running in HERDR_PANE_ID or HC_TERMINAL_ID.
 * - Lanes without a goal get omp's `goal` tool so the agent can create its goal from the lane brief.
 * - The Dori session gets the `monitor` tool (monitor.ts).
 * - A lane's main agent on GPT-6.1 Sol is told to carry lane bookkeeping along with real work (lane-bookkeeping.ts).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ownedModelProfileFile } from "../skills/dori-mode/scripts/src/model-profile.ts";
import {
  bindModelProfile,
  captureModelSnapshot,
  checkModelProfile,
  loadNativeProfileModules,
  type NativeProfileModules,
  releaseModelProfile,
  thinkingSelectionDrift,
} from "./lane-model-profile.ts";
import { type DoriConfig, loadConfig } from "../skills/dori-mode/scripts/src/config";
import { Registry } from "../skills/dori-mode/scripts/src/registry.ts";
import { realClock, run } from "../skills/dori-mode/scripts/src/run.ts";
import { requestLaneModelSwitch } from "../skills/dori-mode/scripts/src/model-switch.ts";
import { claimModelSwitch, type ModelSwitchReceipt } from "../skills/dori-mode/scripts/src/model-switch-state.ts";
import { SourceBundleError } from "../src/release/source-bundle.ts";
import {
  type DoriRole,
  type GoalStatus,
  type ModelReadback,
  type ModelSnapshot,
  type PaneState,
  exactModelIdentity,
  isModelSnapshot,
  paneStatePath,
  readPaneState,
  writePaneState,
} from "../skills/dori-mode/scripts/src/lane-state";
import { bootstrapMonitors, MONITOR_BOOTSTRAP_FLAG, recordedIntake } from "./bootstrap.ts";
import { RuntimeHealthWriter } from "./deployment-health.ts";
import { type PromptModel, withLaneBookkeeping } from "./lane-bookkeeping.ts";
import { MONITOR_DESCRIPTION, Monitors } from "./monitor";
import { bumpAttempts, MAX_CONTINUATIONS, openOwes, recordOwes, reminder } from "../skills/dori-mode/scripts/src/owes";

interface SessionEntry {
  type: string;
  thinkingLevel?: string | null;
  configured?: string | null;
  customType?: string;
  data?: unknown;
  mode?: string;
}
export interface DoriContext {
  cwd: string;
  mode: string;
  abort(): void;
  isIdle(): boolean;
  hasPendingMessages(): boolean;
  getAsyncJobSnapshot(): {
    readonly running: readonly unknown[];
    readonly delivery: {
      readonly queued: number;
      readonly delivering: boolean;
      readonly pendingJobIds: readonly string[];
    };
  } | null;
  agent: { kind: "main" | "sub"; id: string; parentId?: string };
  model?: PromptModel;
  modelRegistry: {
    getAvailableForProviders(providers: ReadonlySet<string>): PromptModel[];
    isUsingSubscription(model: PromptModel): boolean;
  };
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined; getBranch(): SessionEntry[] };
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}
/** A native registry ref's session on any thread: the AgentSession itself, or a worker's handle to one elsewhere. */
interface NativeSessionHandle {
  readonly model?: PromptModel | undefined;
  readonly sessionManager: { getSessionId(): string; getSessionFile(): string | undefined };
}
/** A root AgentSession living on this thread. */
interface NativeModelSession extends NativeSessionHandle {
  readonly settings: Settings;
  readonly sessionManager: DoriContext["sessionManager"] & {
    appendModelChange(model: string): void;
    appendThinkingLevelChange(thinkingLevel?: string, configured?: string): void;
  };
  readonly agent: { readonly state: { readonly model?: PromptModel } };
  getAsyncJobTree(): { readonly running: readonly unknown[] } | null;
  configuredThinkingLevel(): string | undefined;
  subscribe(listener: (event: { readonly type: string }) => void): () => void;
}

/** The registry's session is this thread's AgentSession running `settings`; a worker handle never has settings. */
const runsSettings = (session: NativeSessionHandle, settings: Settings | undefined): session is NativeModelSession =>
  settings !== undefined && "settings" in session && session.settings === settings;

interface Goal {
  objective: string;
  status: string;
}
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}
export interface ToolDefinition<Params = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  defaultInactive?: boolean;
  loadMode?: "essential" | "discoverable";
  execute(
    toolCallId: string,
    params: Params,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: DoriContext,
  ): Promise<ToolResult>;
}
export interface CommandOptions {
  description?: string;
  handler(args: string, ctx: DoriContext): Promise<void>;
}
interface Schema {
  optional(): Schema;
  describe(description: string): Schema;
}
type Handler = (event: unknown, ctx: DoriContext) => unknown;
export interface DoriApi {
  pi: {
    readonly MAIN_AGENT_ID: string;
    readonly AgentRegistry: {
      global(): {
        get(id: string): { readonly parentId?: string; readonly session?: NativeSessionHandle | null } | undefined;
      };
    };
  };
  getThinkingLevel(): string | undefined;
  setModel(model: PromptModel): Promise<boolean>;
  zod: {
    object(shape: Record<string, Schema>): Schema;
    string(): Schema;
    array(element: Schema): Schema;
    enum(values: readonly [string, ...string[]]): Schema;
  };
  setLabel(label: string): void;
  registerFlag(
    name: string,
    options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
  ): void;
  getFlag(name: string): boolean | string | undefined;
  registerCommand(name: string, options: CommandOptions): void;
  registerTool<Params>(tool: ToolDefinition<Params>): void;
  on(event: "goal_updated", handler: (event: { goal: Goal | null }, ctx: DoriContext) => unknown): void;
  on(
    event: "tool_approval_requested" | "tool_approval_resolved",
    handler: (event: { toolCallId: string }, ctx: DoriContext) => unknown,
  ): void;
  on(event: string, handler: Handler): void;
  appendEntry(customType: string, data?: unknown): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
  ): void;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): Promise<void>;
}

const ROLE_FLAG = "dori-role";
const ROLE_ENTRY = "omp-dori:role";
const MONITOR_ENTRY = "omp-dori:monitor";
const MODEL_SNAPSHOT_ENTRY = "omp-dori:model-snapshot";
const ONLY_IN_ROLE = "works only in Dori sessions (omp --dori-role dori|lane)";
// budget-limited halts the goal until a person raises the budget; unknown statuses must never read as "none",
// which `dori pause` treats as nothing-to-pause.
const GOAL_STATUS: Record<string, GoalStatus> = {
  active: "active",
  paused: "paused",
  "budget-limited": "blocked",
  complete: "complete",
  dropped: "dropped",
};

/**
 * Role by agent registry id. omp rebinds extension factories to every subagent session in the same process without
 * re-evaluating this module, so a subagent finds its spawning agent's role here through `ctx.agent.parentId`.
 */
const agentRoles = new Map<string, DoriRole>();

interface ModelProfileBinding {
  readonly modules: NativeProfileModules;
  readonly ownerApi: DoriApi["pi"];
  readonly owner: NativeModelSession;
  readonly agentId: string;
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly file: string;
  snapshot?: ModelSnapshot;
  error?: string;
  unsubscribe?: () => void;
}

/**
 * Lane profile bindings by the native root session that owns them. A subagent reaches one only through native registry
 * lineage up to that live session object, so another SDK session, a reused agent id or a disposed root never matches.
 * The map belongs to this module graph: a worker-thread subagent imports its own copy and checks its root the way
 * `workerRootProblem` describes.
 */
const rootModelProfiles = new WeakMap<NativeSessionHandle, ModelProfileBinding>();

const parseRole = (value: unknown): DoriRole | undefined => (value === "dori" || value === "lane" ? value : undefined);

const recordedRole = (branch: readonly SessionEntry[]): DoriRole | undefined => {
  let role: DoriRole | undefined;
  for (const entry of branch)
    if (entry.type === "custom" && entry.customType === ROLE_ENTRY) role = parseRole(entry.data) ?? role;
  return role;
};

const goalOf = (goal: Goal | null | undefined): PaneState["goal"] =>
  goal ? { status: GOAL_STATUS[goal.status] ?? "blocked", objective: goal.objective } : { status: "none" };

const isGoal = (value: unknown): value is Goal =>
  typeof value === "object" &&
  value !== null &&
  "status" in value &&
  typeof value.status === "string" &&
  "objective" in value &&
  typeof value.objective === "string";

/** omp persists goals in `mode_change.data.goal` ("goal" / "goal_paused" carry the goal; any other mode ends it). */
const recordedGoal = (branch: readonly SessionEntry[]): PaneState["goal"] => {
  let goal: PaneState["goal"] = { status: "none" };
  for (const entry of branch) {
    if (entry.type !== "mode_change") continue;
    const data =
      typeof entry.data === "object" && entry.data !== null && "goal" in entry.data ? entry.data.goal : undefined;
    goal = (entry.mode === "goal" || entry.mode === "goal_paused") && isGoal(data) ? goalOf(data) : { status: "none" };
  }
  return goal;
};

type MonitorSpec = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly filter: string;
  readonly cwd: string;
};

/**
 * Monitors the Dori session wants running, replayed from its `omp-dori:monitor` entries (start / stop). Monitor
 * processes die with omp; the record is what brings the Telegram poller back after herdr or `omp --resume`
 * restores the session, which otherwise resumes idle with nothing left to wake it.
 */
const recordedMonitors = (branch: readonly SessionEntry[]): Map<string, MonitorSpec> => {
  const specs = new Map<string, MonitorSpec>();
  for (const entry of branch) {
    if (
      entry.type !== "custom" ||
      entry.customType !== MONITOR_ENTRY ||
      typeof entry.data !== "object" ||
      entry.data === null
    )
      continue;
    const data = entry.data as { op?: unknown; name?: unknown; argv?: unknown; filter?: unknown; cwd?: unknown };
    if (typeof data.name !== "string") continue;
    if (data.op === "stop") specs.delete(data.name);
    else if (
      data.op === "start" &&
      Array.isArray(data.argv) &&
      typeof data.filter === "string" &&
      typeof data.cwd === "string"
    ) {
      specs.set(data.name, { name: data.name, argv: data.argv.map(String), filter: data.filter, cwd: data.cwd });
    }
  }
  return specs;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export default async function ompDori(pi: DoriApi): Promise<void> {
  pi.registerFlag(ROLE_FLAG, {
    description: "Run as a Dori-mode session: dori (the messenger session) or lane; kept on resume",
    type: "string",
  });
  pi.registerFlag(MONITOR_BOOTSTRAP_FLAG, {
    description: "Private session-bound monitor bootstrap for an explicit managed legacy handoff",
    type: "string",
  });

  pi.registerFlag("dori-launch-model", {
    description: "Require this exact provider/model before accepting a lane launch brief",
    type: "string",
  });

  const launchSessionIds = new Set<string>();
  let modelProfile: ModelProfileBinding | undefined;
  let modelProfileError: string | undefined;
  let modelSwitch: ModelSwitchReceipt | undefined;
  let modelChanging = false;
  let doriConfig: DoriConfig | undefined;
  let nativeProfileModules: NativeProfileModules | undefined;
  let workerSettingsError: string | undefined;
  // Native binds this factory before a worker-thread session emits anything; its subagents check their root through
  // native settings at every boundary, so those are loaded with the factory.
  if (!isMainThread) {
    try {
      nativeProfileModules = await loadNativeProfileModules();
    } catch (error) {
      workerSettingsError = `native settings are unavailable in this worker (${errorText(error)})`;
    }
  }
  const modelReadback = (ctx: DoriContext): ModelReadback => {
    const snapshot = modelProfile?.sessionId === ctx.sessionManager.getSessionId() ? modelProfile.snapshot : undefined;
    const selector =
      snapshot?.provenance.requested ??
      (launchSessionIds.has(ctx.sessionManager.getSessionId()) ? pi.getFlag("dori-launch-model") : undefined);
    const requested = typeof selector === "string" ? exactModelIdentity(selector) : null;
    // Native command contexts copy model at entry; a pinned owner is the live readback after an awaited setter.
    const model = snapshot ? modelProfile?.owner.agent.state.model : ctx.model;
    const observed = model?.provider ? { provider: model.provider, id: model.id } : null;
    const base = { requested, observed, checkedAt: new Date().toISOString(), source: "native-extension" as const };
    if (!model || !observed || (selector !== undefined && !requested))
      return { ...base, status: "unknown", billing: "unknown" };
    if (!requested) return { ...base, status: "unrequested", billing: "unknown" };
    const billing = ctx.modelRegistry.isUsingSubscription(model) ? "subscription" : "non-subscription";
    const expected = snapshot?.model ?? requested;
    const key = `${expected.provider}/${expected.id}`.toLowerCase();
    const available = ctx.modelRegistry.getAvailableForProviders(new Set([expected.provider.toLowerCase()]));
    const matches = available.filter((candidate) => `${candidate.provider}/${candidate.id}`.toLowerCase() === key);
    const selected = snapshot
      ? matches.find((candidate) => candidate.provider === expected.provider && candidate.id === expected.id)
      : (matches.find((candidate) => candidate.id === requested.id) ?? (matches.length === 1 ? matches[0] : undefined));
    if (!selected) return { ...base, status: matches.length ? "unknown" : "unavailable", billing };
    return {
      ...base,
      status: observed.provider === selected.provider && observed.id === selected.id ? "matched" : "mismatch",
      billing,
    };
  };
  const assertLaunchModel = (ctx: DoriContext): void => {
    if (ctx.agent.kind !== "main" || pi.getFlag("dori-launch-model") === undefined) return;
    if (launchSessionIds.size > 0 && !launchSessionIds.has(ctx.sessionManager.getSessionId())) return;
    const readback = modelReadback(ctx);
    if (role === "lane" && readback.status === "matched") return;
    ctx.abort();
    throw new Error(`STARTUP_MODEL_HOLD: exact launch model ${readback.status}; no automatic substitution`);
  };

  let role: DoriRole | undefined;
  let stateDir: string | undefined;
  let loadError: string | undefined;
  let requiredLoadError: SourceBundleError | undefined;
  let warned = false;
  let lifecycleRegistered = false;
  /** The session whose monitor bootstrap was rejected: it stays role-less until a session_start bootstraps it again. */
  let rejectedBootstrap: string | undefined;
  let session:
    | {
        id: string;
        startedAt: string;
        monitorSpecs?: readonly MonitorSpec[];
        intake?: ReturnType<typeof recordedIntake>;
      }
    | undefined;
  let goal: PaneState["goal"] = { status: "none" };
  let agentStatus: "idle" | "working" = "idle";
  let goalToolAdded = false;
  let paneWritten: string | undefined;
  const approvals = new Set<string>();
  let managedRestorePending = process.env.DORI_MANAGED_STARTUP === "1";
  const monitors = new Monitors(
    async (content, delivery) => {
      const root = stateDir;
      if (!delivery.isCurrent()) return;
      // Monitor delivery is an admission path in its own right; its message must follow committed persistence.
      if (role === "dori" && root !== undefined) await recordOwes(root, content, Date.now(), delivery.signal);
      if (delivery.isCurrent())
        pi.sendMessage(
          { customType: "dori-monitor", content, display: true },
          { triggerTurn: true, deliverAs: "aside" },
        );
    },
    () => (role === "dori" ? session?.id : undefined),
  );
  const runtimeHealth = new RuntimeHealthWriter(monitors);

  // Only remove a live record this process wrote. Inactive pointers are handled separately on plain TUI takeover.
  const removePane = (): void => {
    runtimeHealth.stop();
    if (
      paneWritten !== undefined &&
      stateDir !== undefined &&
      readPaneState(stateDir, paneWritten)?.pid === process.pid
    ) {
      rmSync(paneStatePath(stateDir, paneWritten), { force: true });
      if (process.env.HC_TERMINAL_ID) process.stdout.write("\x1b]7501;state=unknown:app=omp\x1b\\");
    }
    paneWritten = undefined;
  };

  // Preserve session identity for a later resume without attesting a live pane owner.
  const retirePane = (): void => {
    runtimeHealth.stop();
    if (paneWritten === undefined || stateDir === undefined) return;
    const state = readPaneState(stateDir, paneWritten);
    if (state !== null && state.pid === process.pid) {
      writePaneState(stateDir, {
        ...state,
        pid: 0,
        agentStatus: "idle",
        approvalPending: false,
        updatedAt: new Date().toISOString(),
      });
      if (process.env.HC_TERMINAL_ID) process.stdout.write("\x1b]7501;state=unknown:app=omp\x1b\\");
    }
    paneWritten = undefined;
  };

  /**
   * Only the process that owns the pane reports it. `HERDR_PANE_ID` and `HC_TERMINAL_ID` are inherited by every
   * child, so a nested `omp` run (a `-p` check, a subagent's own session) would otherwise take the pane record of
   * the live session above it and delete that record on its own shutdown — which reads to the watchdog as a dead
   * lead, so it restarts the lead every tick. An incumbent that is still alive, and not a newer process reusing its
   * pid, keeps its record.
   */
  const paneHeldByAnother = (paneId: string): boolean => {
    if (stateDir === undefined) return false;
    const existing = readPaneState(stateDir, paneId);
    if (existing === null || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || existing.pid === process.pid)
      return false;
    try {
      process.kill(existing.pid, 0);
    } catch (error) {
      // EPERM still identifies a live owner. Dead processes and invalid pid arguments do not own this pane.
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
    }
    // A start observed later than the session cannot own it. lstart resolves seconds, not same-second PID reuse.
    // An unreadable start time keeps the incumbent's protection.
    const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(existing.pid)], {
      encoding: "utf8",
      // lstart has no offset; its ps producer and Date.parse observer must use the same zone.
      env: { ...process.env, LC_ALL: "C", TZ: Intl.DateTimeFormat().resolvedOptions().timeZone },
      timeout: 1_000,
    });
    const started = Date.parse(ps.stdout?.trim() ?? "");
    return !(ps.status === 0 && Number.isFinite(started) && started > Date.parse(existing.startedAt));
  };

  const savePane = (ctx: DoriContext): void => {
    const paneId = process.env.HC_TERMINAL_ID || process.env.HERDR_PANE_ID;
    if (!paneId || stateDir === undefined || !session) return;
    // Only an interactive session taking over the pane clears an inactive resume pointer. Print/RPC children
    // inherit pane ids too, but do not own the terminal. A record another live process owns stays untouched.
    if (!role) {
      removePane();
      if (ctx.mode === "tui" && !paneHeldByAnother(paneId)) rmSync(paneStatePath(stateDir, paneId), { force: true });
      return;
    }
    if (paneHeldByAnother(paneId)) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    try {
      writePaneState(stateDir, {
        paneId,
        role,
        sessionId: session.id,
        ...(sessionFile ? { sessionFile } : {}),
        cwd: ctx.cwd,
        pid: process.pid,
        startedAt: session.startedAt,
        updatedAt: new Date().toISOString(),
        goal,
        agentStatus,
        approvalPending: approvals.size > 0,
        modelReadback: modelReadback(ctx),
        modelSnapshot: modelProfile?.snapshot,
        modelProfileFile: modelProfile?.file,
        modelSnapshotError: modelProfileError,
        modelSwitch,
      });
    } catch (error) {
      // An old clean frame must not authorize a worker after this owner failed to publish a HOLD. A foreign or
      // different session's record is never removed, and cleanup failure must not replace the publication error.
      const stale = readPaneState(stateDir, paneId);
      if (stale?.pid === process.pid && stale.sessionId === session.id && stale.sessionFile === sessionFile) {
        try {
          rmSync(paneStatePath(stateDir, paneId), { force: true });
        } catch (invalidating) {
          console.error(`omp-dori: could not invalidate stale pane ${paneId}: ${errorText(invalidating)}`);
        }
      }
      throw error;
    }
    if (role === "dori")
      runtimeHealth.update({
        stateDir,
        paneId,
        role,
        sessionId: session.id,
        startedAt: session.startedAt,
        wanted: recordedMonitors(ctx.sessionManager.getBranch()),
        presetLoaded: loadError === undefined,
      });
    else runtimeHealth.stop();
    paneWritten = paneId;
    if (process.env.HC_TERMINAL_ID) {
      const status = approvals.size > 0 ? "blocked" : agentStatus;
      process.stdout.write(`\x1b]7501;state=${status}:app=omp\x1b\\`);
    }
  };

  // Cache desired intent for /new; boot reads the same mirror without opening private session transcripts.
  const saveMonitorSpecs = (specs: ReadonlyMap<string, MonitorSpec>, branch: readonly SessionEntry[]): void => {
    if (!session) return;
    session.monitorSpecs = [...specs.values()];
    session.intake = recordedIntake(branch);
    if (!stateDir) return;
    const dir = join(stateDir, "monitors");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${encodeURIComponent(session.id)}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          version: 1,
          sessionId: session.id,
          monitors: session.monitorSpecs,
          intake: session.intake,
        },
        null,
        2,
      ),
      {
        mode: 0o600,
      },
    );
    renameSync(tmp, path);
  };

  const syncTools = async (): Promise<void> => {
    const active = pi.getActiveTools();
    const next = new Set(active);
    if (role === "dori") next.add("monitor");
    else next.delete("monitor");
    // A session with its own goal keeps whatever omp decided. omp does not take the tool back when the session
    // changes, so ours is removed from any later goal-less session that is not a lane.
    if (goal.status === "none" && role === "lane") {
      if (!next.has("goal")) goalToolAdded = true;
      next.add("goal");
    } else if (goal.status === "none" && goalToolAdded) {
      next.delete("goal");
      goalToolAdded = false;
    }
    if (next.size !== active.length || active.some((name) => !next.has(name))) await pi.setActiveTools([...next]);
  };

  const recordModelSnapshot = (binding: ModelProfileBinding, snapshot: ModelSnapshot): void => {
    if (snapshot.configuredThinkingLevel === "auto") {
      const manager = binding.owner.sessionManager;
      const last = manager.getBranch().findLast((entry) => entry.type === "thinking_level_change");
      // Native may never record auto when its first resolution equals the provisional effort. Record the actual
      // selector alongside our snapshot so native resume, not a re-selection from current defaults, restores it.
      if ((last?.configured ?? last?.thinkingLevel) !== "auto")
        manager.appendThinkingLevelChange(pi.getThinkingLevel(), "auto");
    }
    pi.appendEntry(MODEL_SNAPSHOT_ENTRY, snapshot);
  };

  const syncModelProfile = async (
    ctx: DoriContext,
    branch: readonly SessionEntry[],
    freshLaunch: boolean,
    carried: boolean,
  ): Promise<void> => {
    modelProfileError = undefined;
    if (role !== "lane") {
      if (modelProfile) {
        modelProfile.unsubscribe?.();
        const failed = await releaseModelProfile(modelProfile.owner.settings, modelProfile.file);
        if (failed) {
          modelProfile.error = modelProfileError = failed;
          return;
        }
        rootModelProfiles.delete(modelProfile.owner);
      }
      modelProfile = undefined;
      return;
    }
    const saved = branch.findLast((entry) => entry.type === "custom" && entry.customType === MODEL_SNAPSHOT_ENTRY);
    const inherited = carried ? modelProfile?.snapshot : undefined;
    try {
      nativeProfileModules ??= await loadNativeProfileModules();
      // Native runs every extension handler in its session's settings scope: these are this lane session's own.
      const settings = nativeProfileModules.findScopedSettings();
      const file = stateDir && settings && ownedModelProfileFile(settings.getConfigFiles(), stateDir);
      if (!file) {
        if (saved || modelProfile) throw new Error("saved lane snapshot has no process-owned model profile overlay");
        // Older and opaque launchers have no private overlay. Keep their existing launch contract.
        return;
      }
      // A process-owned overlay is a guarded launch: only the verified native root session running it may bind it.
      const owner = pi.pi.AgentRegistry.global().get(pi.pi.MAIN_AGENT_ID)?.session;
      if (
        !owner ||
        ctx.agent.id !== pi.pi.MAIN_AGENT_ID ||
        !runsSettings(owner, settings) ||
        owner.sessionManager.getSessionId() !== ctx.sessionManager.getSessionId() ||
        owner.sessionManager.getSessionFile() !== ctx.sessionManager.getSessionFile()
      )
        throw new Error("native root session identity is unverified");
      if (modelProfile) {
        modelProfile.unsubscribe?.();
        if (modelProfile.owner !== owner) rootModelProfiles.delete(modelProfile.owner);
      }
      const binding: ModelProfileBinding = {
        modules: nativeProfileModules,
        ownerApi: pi.pi,
        owner,
        agentId: ctx.agent.id,
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        file,
        error: "native model profile is binding",
      };
      modelProfile = binding;
      rootModelProfiles.set(owner, binding);
      // Both native observers run synchronously, before a worker peer read is answered. Publish sticky root drift
      // before the settings push a worker mirror may lag on; peers have no configured-thinking getter of their own.
      const publishDrift = (): void => {
        if (modelChanging || modelProfile !== binding || !binding.snapshot || binding.error) return;
        const failed =
          checkModelProfile(binding.modules, owner.settings, binding.file, binding.snapshot, owner.agent.state.model) ??
          thinkingSelectionDrift(binding.snapshot, owner.configuredThinkingLevel());
        if (!failed) return;
        binding.error = modelProfileError = failed;
        savePane(ctx);
      };
      const stopThinking = owner.subscribe((event) => {
        if (event.type === "thinking_level_changed") publishDrift();
      });
      const stopLayers = owner.settings.onLayersChange(publishDrift);
      binding.unsubscribe = () => {
        stopThinking();
        stopLayers();
      };
      let snapshot: ModelSnapshot;
      if (saved) {
        if (!isModelSnapshot(saved.data))
          throw new Error("latest native model snapshot is malformed; no older snapshot selected");
        snapshot = saved.data;
      } else if (inherited) snapshot = inherited;
      else {
        const proof = modelReadback(ctx);
        const requested = pi.getFlag("dori-launch-model");
        if (!freshLaunch || proof.status !== "matched" || typeof requested !== "string")
          throw new Error(
            "native model snapshot is unknown; use an explicit idle /dori-lane-model selection from the Dori head",
          );
        const captured = captureModelSnapshot(nativeProfileModules, owner.settings, {
          kind: "launch",
          requested,
          model: proof.observed,
          configuredThinkingLevel: owner.configuredThinkingLevel(),
          thinkingLevel: pi.getThinkingLevel(),
        });
        if (typeof captured === "string") throw new Error(captured);
        snapshot = captured;
      }
      binding.snapshot = snapshot;
      const failed =
        (await bindModelProfile(nativeProfileModules, owner.settings, file, snapshot)) ??
        checkModelProfile(nativeProfileModules, owner.settings, file, snapshot, owner.agent.state.model) ??
        thinkingSelectionDrift(snapshot, owner.configuredThinkingLevel());
      if (failed) throw new Error(failed);
      binding.error = undefined;
      if (!saved) {
        // Native /new keeps the live model without recording it. Journal the verified carried selection so a reopen
        // before any assistant response restores that model through native history, not through current defaults.
        if (inherited) owner.sessionManager.appendModelChange(`${snapshot.model.provider}/${snapshot.model.id}`);
        recordModelSnapshot(binding, snapshot);
      }
    } catch (error) {
      modelProfileError = errorText(error);
      if (modelProfile) modelProfile.error = modelProfileError;
      ctx.ui.notify(
        `MODEL_SNAPSHOT_HOLD: ${modelProfileError}. Fix: restore the saved profile or select a model explicitly from the idle Dori head flow.`,
        "warning",
      );
    }
  };

  /** The lane root binding a subagent descends from, followed through the native registry's live lineage. */
  const inheritedModelProfile = (ctx: DoriContext): ModelProfileBinding | undefined => {
    const registry = pi.pi.AgentRegistry.global();
    const seen = new Set<string>();
    for (let id = ctx.agent.parentId; id !== undefined && !seen.has(id); ) {
      seen.add(id);
      const ref = registry.get(id);
      const binding = ref?.session ? rootModelProfiles.get(ref.session) : undefined;
      if (binding) return binding;
      id = ref?.parentId;
    }
    return undefined;
  };

  /**
   * A worker-thread subagent runs its own copy of this module, so its lane root's binding is out of reach. It checks
   * the root through what native carries across threads instead: the root settings mirror its own settings read
   * through, the root session read live through the native registry, and the pane state the root publishes after every
   * profile change, whose pid, session and overlay must all name that root. Only a root on a Dori-owned overlay needs
   * this; a legacy, opaque or ordinary root has none and its subagents pass as before.
   */
  const workerRootProblem = (ctx: DoriContext): string | undefined => {
    if (isMainThread || stateDir === undefined) return undefined;
    const paneId = process.env.HC_TERMINAL_ID || process.env.HERDR_PANE_ID;
    const modules = nativeProfileModules;
    if (!modules) {
      // Without native settings only this process's own pinned-lane publication can say a root is pinned.
      const pane = paneId ? readPaneState(stateDir, paneId) : null;
      return pane?.pid === process.pid && pane.modelProfileFile
        ? (workerSettingsError ?? "native settings are not loaded in this worker")
        : undefined;
    }
    let root = modules.findScopedSettings();
    for (let parent = root?.overlayParent(); parent; parent = parent.overlayParent()) root = parent;
    const file = root && ownedModelProfileFile(root.getConfigFiles(), stateDir);
    if (!root || !file) {
      const pane = paneId ? readPaneState(stateDir, paneId) : null;
      return pane?.pid === process.pid && pane.role === "lane" && pane.modelProfileFile
        ? (pane.modelSnapshotError ?? "owning lane model profile overlay is missing")
        : undefined;
    }
    if (!root.isMirror) return "worker settings do not mirror the native root's settings";
    const registry = pi.pi.AgentRegistry.global();
    const seen = new Set<string>();
    let id = ctx.agent.parentId;
    while (id !== undefined && id !== pi.pi.MAIN_AGENT_ID && !seen.has(id)) {
      seen.add(id);
      id = registry.get(id)?.parentId;
    }
    const owner = id === pi.pi.MAIN_AGENT_ID ? registry.get(id)?.session : undefined;
    // Finish the live peer reads before observing the root's synchronously published profile/selection HOLD.
    const sessionId = owner?.sessionManager.getSessionId();
    const sessionFile = owner?.sessionManager.getSessionFile();
    const actualModel = owner?.model;
    const pane = paneId ? readPaneState(stateDir, paneId) : null;
    if (
      !owner ||
      !pane ||
      pane.pid !== process.pid ||
      pane.role !== "lane" ||
      pane.sessionId !== sessionId ||
      pane.sessionFile !== sessionFile ||
      pane.modelProfileFile !== file
    )
      return "native root lane state is unverified";
    if (pane.modelSnapshotError) return pane.modelSnapshotError;
    if (pane.modelSwitch?.status === "changing") return "explicit idle model change is in progress";
    if (!isModelSnapshot(pane.modelSnapshot)) return "owning lane model snapshot is unknown";
    return checkModelProfile(modules, root, file, pane.modelSnapshot, actualModel) ?? undefined;
  };

  const assertModelProfile = (ctx: DoriContext): void => {
    const binding = ctx.agent.kind === "main" ? modelProfile : inheritedModelProfile(ctx);
    let failed = modelChanging
      ? "explicit idle model change is in progress"
      : ctx.agent.kind === "main"
        ? modelProfileError
        : binding?.error;
    if (!failed && binding) {
      const owner = binding.ownerApi.AgentRegistry.global().get(binding.agentId)?.session;
      if (
        owner !== binding.owner ||
        binding.owner.sessionManager.getSessionId() !== binding.sessionId ||
        binding.owner.sessionManager.getSessionFile() !== binding.sessionFile
      )
        failed = "owning native lane session changed";
      else if (!binding.snapshot) failed = "owning lane model snapshot is unknown";
      else
        failed =
          checkModelProfile(
            binding.modules,
            binding.owner.settings,
            binding.file,
            binding.snapshot,
            binding.owner.agent.state.model,
          ) ??
          thinkingSelectionDrift(binding.snapshot, binding.owner.configuredThinkingLevel()) ??
          undefined;
    } else if (!failed && ctx.agent.kind === "sub") failed = workerRootProblem(ctx);
    if (!failed) return;
    ctx.abort();
    if (ctx.agent.kind === "main") {
      modelProfileError = failed;
      if (modelProfile) modelProfile.error = failed;
      savePane(ctx);
    }
    throw new Error(`MODEL_SNAPSHOT_HOLD: ${failed}; no automatic substitution`);
  };

  // Registered only once a role session appears: approval handlers make omp emit approval events and disable read
  // speculation for the whole process, which ordinary sessions must not pay for.
  const registerLifecycle = (): void => {
    lifecycleRegistered = true;
    pi.on("tool_approval_requested", (event, ctx) => {
      if (!role) return;
      approvals.add(event.toolCallId);
      savePane(ctx);
    });
    pi.on("tool_approval_resolved", (event, ctx) => {
      if (!approvals.delete(event.toolCallId) || !role) return;
      savePane(ctx);
    });
    pi.on("session_shutdown", () => {
      if (modelProfile) {
        modelProfile.unsubscribe?.();
        rootModelProfiles.delete(modelProfile.owner);
      }
      monitors.stopAll();
      retirePane();
    });
  };

  const syncMain = async (
    ctx: DoriContext,
    branch: readonly SessionEntry[],
    lifecycle: { bootstrap: boolean; freshLaunch: boolean; carried: boolean },
  ): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    // Monitors belong to the Dori session that started them; their lines must not wake whatever session comes next.
    if (session?.id !== sessionId || role !== "dori") monitors.stopAll();
    if (session?.id !== sessionId) {
      session = { id: sessionId, startedAt: new Date().toISOString() };
      modelSwitch = undefined;
      approvals.clear();
      agentStatus = "idle";
    }
    if (role && !lifecycleRegistered) registerLifecycle();
    // Before the profile sync, whose pane publication must not carry the previous session's goal. A bootstrap below
    // adds only monitor and intake entries, never a goal.
    goal = recordedGoal(branch);
    await syncModelProfile(ctx, branch, lifecycle.freshLaunch, lifecycle.carried);
    if (lifecycle.bootstrap && role === "dori") {
      try {
        if (bootstrapMonitors(pi, branch, sessionId, recordedMonitors(branch))) branch = ctx.sessionManager.getBranch();
        rejectedBootstrap = undefined;
      } catch (error) {
        // A rejected bootstrap leaves no role session behind: no handler may publish ready or approval-free state, and
        // a later branch or tree move in this session does not restore the role from its record.
        rejectedBootstrap = sessionId;
        role = undefined;
        agentRoles.delete(ctx.agent.id);
        monitors.stopAll();
        removePane();
        throw error;
      }
    }
    if (role && loadError && !warned) {
      warned = true;
      ctx.ui.notify(
        `omp-dori: ${loadError}. ${requiredLoadError ? "Required bound source failed; role requests are blocked." : "Running without omo presets."}`,
        "warning",
      );
    }
    // Publish the verified root profile before tool activation can dispatch worker-thread work, exactly once.
    savePane(ctx);
    await syncTools();
    if (role === "dori") {
      restoreMonitors(ctx, branch, managedRestorePending);
      managedRestorePending = false;
    }
  };

  // Bring the running set in line with what this branch recorded: restart what a resumed session lost, stop what a
  // tree move or branch took back. Restored monitors are announced without starting a turn.
  const restoreMonitors = (ctx: DoriContext, branch: readonly SessionEntry[], managedStartup = false): void => {
    if (!session) return;
    const wanted = recordedMonitors(branch);
    for (const running of monitors.list()) {
      const spec = wanted.get(running.name);
      if (
        !spec ||
        JSON.stringify(spec.argv) !== JSON.stringify(running.argv) ||
        new RegExp(spec.filter).source !== running.filter ||
        spec.cwd !== running.cwd
      )
        monitors.stop(running.name);
    }
    const running = new Set(monitors.list().map((m) => m.name));
    const restored: string[] = [];
    const failed: string[] = [];
    for (const spec of wanted.values()) {
      if (running.has(spec.name)) continue;
      try {
        monitors.start(spec.name, spec.argv, spec.filter, spec.cwd, session.id);
        restored.push(spec.name);
      } catch (error) {
        failed.push(`${spec.name} (${errorText(error)})`);
      }
    }
    saveMonitorSpecs(wanted, branch);
    savePane(ctx);
    if (restored.length === 0 && failed.length === 0) return;
    const lines = [
      ...(restored.length ? [`[monitor] restored for this resumed session: ${restored.join(", ")}`] : []),
      ...(failed.length ? [`[monitor] could not restore: ${failed.join("; ")}`] : []),
    ];
    pi.sendMessage(
      { customType: "dori-monitor", content: lines.join("\n"), display: true },
      { triggerTurn: failed.length > 0 && !managedStartup },
    );
    if (failed.length) ctx.ui.notify(`omp-dori: ${lines.at(-1)}`, "warning");
  };

  // Registered before omp-ulw so its restore handlers see this event's role.
  for (const eventName of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
    pi.on(eventName, async (event, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      let flaggedRole = false;
      let carried = false;
      if (ctx.agent.kind === "sub") {
        role = ctx.agent.parentId === undefined ? undefined : agentRoles.get(ctx.agent.parentId);
      } else {
        if (eventName === "session_start" && launchSessionIds.size === 0)
          launchSessionIds.add(ctx.sessionManager.getSessionId());
        const recorded = recordedRole(branch);
        // `/new` emits `session_switch` with `reason: "new"`; its empty branch has no role entry to read. Adopting
        // that emptiness would strip `monitor`, stop the monitors that answer the messenger, and drop the pane record
        // for the rest of the process lifetime, so the process's own role carries over instead.
        carried =
          eventName === "session_switch" &&
          typeof event === "object" &&
          event !== null &&
          "reason" in event &&
          event.reason === "new";
        role = recorded ?? (carried ? role : undefined);
        if (carried && role === "lane" && session && launchSessionIds.has(session.id))
          launchSessionIds.add(ctx.sessionManager.getSessionId());
        const flagged = pi.getFlag(ROLE_FLAG);
        if (role === undefined && eventName === "session_start" && flagged !== undefined) {
          role = parseRole(flagged);
          if (role) flaggedRole = true;
          else ctx.ui.notify(`omp-dori: --${ROLE_FLAG} must be "dori" or "lane", got "${String(flagged)}"`, "error");
        }
        if (eventName !== "session_start" && rejectedBootstrap === ctx.sessionManager.getSessionId()) role = undefined;
        // Re-record the role and desired monitor starts: an exited child is not a recorded stop, and the fresh
        // branch otherwise loses the intent that `syncMain` uses to restore it.
        if (carried && role && recorded === undefined) pi.appendEntry(ROLE_ENTRY, role);
        if (carried && role === "dori" && recorded === undefined) {
          for (const spec of session?.monitorSpecs ?? [])
            pi.appendEntry(MONITOR_ENTRY, {
              op: "start",
              name: spec.name,
              argv: spec.argv,
              filter: spec.filter,
              cwd: spec.cwd,
            });
          if (session?.intake) pi.appendEntry("omp-dori:intake", session.intake);
        }
      }
      if (role) agentRoles.set(ctx.agent.id, role);
      else agentRoles.delete(ctx.agent.id);
      try {
        if (ctx.agent.kind === "main")
          await syncMain(ctx, ctx.sessionManager.getBranch(), {
            bootstrap: eventName === "session_start",
            freshLaunch: flaggedRole,
            carried,
          });
      } finally {
        // A rejected bootstrap has cleared the role, so it is not recorded; any other failure keeps the role this
        // process runs with, and its record, as a later resume without the flag must restore it.
        if (flaggedRole && role) pi.appendEntry(ROLE_ENTRY, role);
      }
    });
  }

  pi.on("goal_updated", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !role) return;
    goal = goalOf(event.goal);
    savePane(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.agent.kind !== "main" || !role) return;
    agentStatus = "working";
    savePane(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.agent.kind !== "main" || !role) return;
    agentStatus = "idle";
    savePane(ctx);
  });

  /**
   * Recent Discord obligations request bounded continuations until both send and exact-message mark exist.
   * MAX_CONTINUATIONS limits the reminder loop; lanes and subagents never receive this gate.
   */
  pi.on("session_stop", (_event, ctx) => {
    if (role !== "dori" || ctx.agent.kind !== "main" || stateDir === undefined) return;
    const owes = openOwes(stateDir, Date.now());
    if (owes.length === 0) return;
    const attempts = bumpAttempts(
      stateDir,
      owes.map((owe) => owe.id),
    );
    const live = owes.filter((owe) => (attempts[owe.id] ?? 0) <= MAX_CONTINUATIONS);
    if (live.length === 0) return;
    return { continue: true, additionalContext: reminder(live) };
  });

  // OMP chains prompt replacements in extension/handler order; append to the prompt this handler receives.
  pi.on("before_agent_start", (event, ctx) => {
    assertLaunchModel(ctx);
    assertModelProfile(ctx);
    if (role && requiredLoadError) {
      ctx.abort();
      throw requiredLoadError;
    }
    if (role !== "lane" || ctx.agent.kind !== "main" || typeof event !== "object" || event === null) return;
    const systemPrompt = "systemPrompt" in event ? withLaneBookkeeping(event.systemPrompt, ctx.model) : undefined;
    return systemPrompt && { systemPrompt };
  });

  pi.on("before_subagent_spawn", (_event, ctx) => {
    try {
      assertModelProfile(ctx);
    } catch (error) {
      return { block: true, reason: errorText(error) };
    }
  });

  pi.on("before_provider_request", (_event, ctx) => {
    assertLaunchModel(ctx);
    assertModelProfile(ctx);
    if (role && requiredLoadError) {
      ctx.abort();
      throw requiredLoadError;
    }
  });

  for (const event of ["session_before_switch", "session_before_branch", "session_before_tree"]) {
    pi.on(event, (_event, ctx) => {
      if (ctx.agent.kind === "main" && modelChanging) return { cancel: true };
    });
  }

  pi.registerCommand("dori-lane-model", {
    description: "Explicitly change one idle lane's model from its native Dori head",
    async handler(args, ctx) {
      if (ctx.agent.kind !== "main" || role !== "dori" || !stateDir || !doriConfig) {
        ctx.ui.notify("/dori-lane-model works only in the native main Dori head", "warning");
        return;
      }
      const parts = args.trim().split(/\s+/);
      if (parts.length !== 2) {
        ctx.ui.notify("Usage: /dori-lane-model <lane-key> <provider/id>. Pause the lane first.", "warning");
        return;
      }
      savePane(ctx);
      const pane = process.env.HC_TERMINAL_ID || process.env.HERDR_PANE_ID;
      const head = pane ? readPaneState(stateDir, pane) : null;
      if (!head || head.pid !== process.pid || head.sessionId !== ctx.sessionManager.getSessionId()) {
        ctx.ui.notify("MODEL_SWITCH_REFUSED: this head has no owned native pane record", "warning");
        return;
      }
      const result = await requestLaneModelSwitch(
        { config: doriConfig, registry: new Registry(stateDir), run, clock: realClock, env: process.env },
        parts[0]!,
        parts[1]!,
        head,
      );
      ctx.ui.notify(result.lines.join("\n"), result.code === 0 ? "info" : "warning");
    },
  });

  pi.registerCommand("dori-model-apply", {
    description: "Apply a single pending head-authorized idle lane model request",
    async handler(args, ctx) {
      const parts = args.trim().split(/\s+/);
      if (
        parts.length !== 2 ||
        ctx.agent.kind !== "main" ||
        role !== "lane" ||
        !stateDir ||
        modelChanging ||
        modelSwitch?.nonce === parts[1]
      )
        return;
      const binding = modelProfile;
      if (!binding) {
        ctx.ui.notify("MODEL_SWITCH_REFUSED: reopen this lane with a process-owned model profile first", "warning");
        return;
      }
      const idleProblem = (): string | undefined => {
        if (!ctx.isIdle() || agentStatus !== "idle") return "native lane is not idle";
        if (approvals.size || ctx.hasPendingMessages()) return "native lane has an approval or queued input";
        if (!["none", "paused", "complete", "dropped"].includes(goal.status)) return "pause the native goal first";
        const jobs = ctx.getAsyncJobSnapshot();
        if (
          !jobs ||
          jobs.running.length ||
          jobs.delivery.queued ||
          jobs.delivery.delivering ||
          jobs.delivery.pendingJobIds.length ||
          binding.owner.getAsyncJobTree()?.running.length !== 0
        )
          return "native asynchronous or descendant work is pending or unknown";
        if (
          binding.ownerApi.AgentRegistry.global().get(binding.agentId)?.session !== binding.owner ||
          binding.sessionId !== ctx.sessionManager.getSessionId() ||
          binding.sessionFile !== ctx.sessionManager.getSessionFile()
        )
          return "native owning session changed";
        return undefined;
      };
      const busy = idleProblem();
      if (busy) {
        ctx.ui.notify(`MODEL_SWITCH_REFUSED: ${busy}`, "warning");
        return;
      }
      const previousError = binding.error;
      const previousProfileError = modelProfileError;
      let accepted = false;
      modelChanging = true;
      binding.error = "explicit idle model change is in progress";
      try {
        savePane(ctx);
        const pane = process.env.HC_TERMINAL_ID || process.env.HERDR_PANE_ID;
        const self = pane ? readPaneState(stateDir, pane) : null;
        if (!self || self.pid !== process.pid) return;
        const request = await claimModelSwitch(new Registry(stateDir), parts[0]!, parts[1]!, self, (receipt) => {
          const changed = idleProblem();
          if (changed) throw new Error(changed);
          accepted = true;
          modelSwitch = receipt;
          savePane(ctx);
        });
        if (!request) return;
        if (request.priorSnapshotId !== (binding.snapshot?.id ?? null))
          throw new Error("snapshot changed since the head request");
        const changed = idleProblem();
        if (changed) throw new Error(changed);
        const requested = exactModelIdentity(request.requested)!;
        const available = ctx.modelRegistry.getAvailableForProviders(new Set([requested.provider.toLowerCase()]));
        const matches = available.filter(
          (candidate) => `${candidate.provider}/${candidate.id}`.toLowerCase() === request.requested.toLowerCase(),
        );
        const selected =
          matches.find((candidate) => candidate.id === requested.id) ?? (matches.length === 1 ? matches[0] : undefined);
        if (!selected?.provider) throw new Error("requested exact native model is unavailable or ambiguous");
        if (!(await pi.setModel(selected))) throw new Error("native model setter refused the requested model");
        if (
          binding.owner.sessionManager.getSessionId() !== binding.sessionId ||
          binding.owner.sessionManager.getSessionFile() !== binding.sessionFile
        )
          throw new Error("native session changed during model selection");
        const actual = binding.owner.agent.state.model;
        if (actual?.provider !== selected.provider || actual.id !== selected.id)
          throw new Error("native model readback did not confirm the explicit selection");
        const observed = { provider: selected.provider, id: selected.id };
        let snapshot: ModelSnapshot;
        if (binding.snapshot)
          snapshot = {
            ...binding.snapshot,
            id: request.nonce,
            model: observed,
            configuredThinkingLevel: binding.owner.configuredThinkingLevel() ?? null,
            thinkingLevel: pi.getThinkingLevel() ?? null,
            capturedAt: new Date().toISOString(),
            provenance: { ...binding.snapshot.provenance, kind: "idle-switch", requested: request.requested },
          };
        else {
          const captured = captureModelSnapshot(binding.modules, binding.owner.settings, {
            kind: "idle-switch",
            requested: request.requested,
            model: observed,
            configuredThinkingLevel: binding.owner.configuredThinkingLevel(),
            thinkingLevel: pi.getThinkingLevel(),
          });
          if (typeof captured === "string") throw new Error(captured);
          snapshot = captured;
        }
        const failed =
          (await bindModelProfile(binding.modules, binding.owner.settings, binding.file, snapshot)) ??
          checkModelProfile(
            binding.modules,
            binding.owner.settings,
            binding.file,
            snapshot,
            binding.owner.agent.state.model,
          ) ??
          thinkingSelectionDrift(snapshot, binding.owner.configuredThinkingLevel());
        if (failed) throw new Error(failed);
        recordModelSnapshot(binding, snapshot);
        binding.snapshot = snapshot;
        binding.error = modelProfileError = undefined;
        modelSwitch = { nonce: request.nonce, status: "changed" };
      } catch (error) {
        const reason = errorText(error);
        if (accepted) {
          modelSwitch = { nonce: parts[1]!, status: "failed", reason };
          // The earlier state stands only when native reads back the unchanged session, model and pinned profile;
          // anything else holds as it is, without rollback or reselection.
          const owner = binding.ownerApi.AgentRegistry.global().get(binding.agentId)?.session;
          const unchanged =
            binding.snapshot !== undefined &&
            owner === binding.owner &&
            binding.owner.sessionManager.getSessionId() === binding.sessionId &&
            binding.owner.sessionManager.getSessionFile() === binding.sessionFile &&
            checkModelProfile(
              binding.modules,
              binding.owner.settings,
              binding.file,
              binding.snapshot,
              binding.owner.agent.state.model,
            ) === null &&
            thinkingSelectionDrift(binding.snapshot, binding.owner.configuredThinkingLevel()) === null;
          if (unchanged) {
            binding.error = previousError;
            modelProfileError = previousProfileError;
          } else binding.error = modelProfileError = reason;
        }
        ctx.ui.notify(`MODEL_SWITCH_FAILED: ${reason}`, "warning");
      } finally {
        modelChanging = false;
        if (!accepted) {
          binding.error = previousError;
          modelProfileError = previousProfileError;
        }
        savePane(ctx);
      }
    },
  });

  const z = pi.zod;
  pi.registerTool<{ op: "start" | "stop" | "list"; name?: string; argv?: string[]; filter?: string }>({
    name: "monitor",
    label: "Monitor",
    description: MONITOR_DESCRIPTION,
    defaultInactive: true,
    loadMode: "essential",
    parameters: z.object({
      op: z.enum(["start", "stop", "list"]).describe("start a monitor, stop one, or list running monitors"),
      name: z.string().optional().describe("monitor name (start, stop)"),
      argv: z.array(z.string()).optional().describe("command and arguments, run without a shell (start)"),
      filter: z.string().optional().describe("regular expression; matching output lines wake the session (start)"),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (role !== "dori" || ctx.agent.kind !== "main" || !session)
        throw new Error("monitor works only in the Dori session (omp --dori-role dori)");
      let text: string;
      if (params.op === "start") {
        if (!params.name || !params.argv || params.filter === undefined)
          throw new Error("start needs name, argv and filter");
        const started = monitors.start(params.name, params.argv, params.filter, ctx.cwd, session.id);
        pi.appendEntry(MONITOR_ENTRY, {
          op: "start",
          name: started.name,
          argv: started.argv,
          filter: started.filter,
          cwd: ctx.cwd,
        });
        saveMonitorSpecs(recordedMonitors(ctx.sessionManager.getBranch()), ctx.sessionManager.getBranch());
        savePane(ctx);
        text = `started monitor "${started.name}" (pid ${started.pid}): ${started.argv.join(" ")}`;
      } else if (params.op === "stop") {
        if (!params.name) throw new Error("stop needs name");
        const wasRunning = monitors.stop(params.name);
        // A monitor that exited on its own is still recorded; stopping it by name drops it from future restores.
        const recorded = recordedMonitors(ctx.sessionManager.getBranch()).has(params.name);
        if (!wasRunning && !recorded) throw new Error(`no monitor "${params.name}"`);
        if (recorded) pi.appendEntry(MONITOR_ENTRY, { op: "stop", name: params.name });
        saveMonitorSpecs(recordedMonitors(ctx.sessionManager.getBranch()), ctx.sessionManager.getBranch());
        savePane(ctx);
        text = `stopped monitor "${params.name}"`;
      } else {
        const running = monitors.list();
        text =
          running.length === 0
            ? "no monitors running"
            : running.map((m) => `${m.name} (pid ${m.pid}) /${m.filter}/: ${m.argv.join(" ")}`).join("\n");
      }
      return { content: [{ type: "text", text }] };
    },
  });

  // omp-ulw sees this API: every runtime entry point is a no-op outside role sessions.
  const gated = new Proxy(pi, {
    get(target, prop) {
      if (prop === "on")
        return (event: string, handler: Handler) =>
          target.on(event, (payload, ctx) => (role ? handler(payload, ctx) : undefined));
      if (prop === "registerCommand") {
        return (name: string, options: CommandOptions) =>
          target.registerCommand(name, {
            ...options,
            handler: async (args, ctx) => {
              if (role) return options.handler(args, ctx);
              ctx.ui.notify(`/${name} ${ONLY_IN_ROLE}.`, "warning");
            },
          });
      }
      if (prop === "registerTool") {
        return (tool: ToolDefinition) =>
          target.registerTool<Record<string, unknown>>({
            ...tool,
            execute: async (toolCallId, params, signal, onUpdate, ctx) => {
              if (role) return tool.execute(toolCallId, params, signal, onUpdate, ctx);
              ctx.ui.notify(`${tool.name} ${ONLY_IN_ROLE}.`, "warning");
              return { content: [{ type: "text", text: `${tool.name} ${ONLY_IN_ROLE}.` }] };
            },
          });
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  try {
    const config = await loadConfig();
    doriConfig = config;
    stateDir = config.stateDir;
    // An empty ompUlwPath means a standalone omp-ulw extension already serves every session; importing it again
    // would register its commands and handlers twice.
    if (config.ompUlwPath) {
      try {
        // Prepare the runtime-selected dependency through this host's canonical graph before binding the role gate.
        // The host loader is optional when no embedded dependency is configured.
        const { importExtensionModule } = await import("@oh-my-pi/pi-coding-agent/extensibility/extensions/loader");
        const prepared = await importExtensionModule(config.ompUlwPath, import.meta.dir);
        if (prepared.error) throw new Error(prepared.error);
        const ulw: unknown = prepared.factory;
        if (typeof ulw !== "function") throw new Error("its default export is not a function");
        await ulw(gated);
      } catch (error) {
        loadError = `omp-ulw not loaded from ${config.ompUlwPath} (${errorText(error)})`;
        if (
          /\/(?:consumer-dependencies\/omp-ulw-[a-f0-9]{40}-[a-f0-9]{64}|\.cache\/omp-dori\/omp-ulw-[a-f0-9]{64})(?:\/index\.ts)?$/.test(
            config.ompUlwPath,
          )
        )
          requiredLoadError = new SourceBundleError(loadError);
      }
    }
  } catch (error) {
    if (error instanceof SourceBundleError) requiredLoadError = error;
    loadError = `Dori config not loaded (${errorText(error)}); omp-ulw and pane state are off`;
  }
  pi.setLabel("omp-dori");
}
