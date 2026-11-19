import { homedir } from "node:os";
import { join } from "node:path";

import {
  resolveConsumerOmpCommand,
  resolveConsumerOmpUlwPath,
  resolveProcessOmpCommand,
  resolveProcessOmpUlwPath,
} from "../../../../src/release/runtime.ts";
import type { RuntimeKind } from "../../../../src/runtime/types.ts";
import { supervisionOptionsError } from "./supervision-config.ts";
import type { SupervisionOptions } from "./supervision-observe.ts";
import type { QuotaOptions } from "./quota.ts";
import { usageOptionsError } from "./usage-options.ts";
import type { CommitIdentity } from "./verify-pr-check.ts";

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly threadDone?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

export type DoriConfig = {
  /** Where new sessions open; absent = detected (see run.ts runtimeChoice). */
  readonly runtime?: RuntimeKind;
  readonly stateDir: string;
  readonly laneWorkspace: string;
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  readonly leadPane: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  readonly launchKeywords: string;
  readonly goalMarker: string;
  /** How long `launch` waits for the agent's ready status and goal after it starts; a slow host is a host property. */
  readonly startupWaitSeconds: number;
  readonly sessionsDir: string;
  /** omp-ulw's index.ts, loaded only for Dori and lane sessions by the OMP extension. */
  readonly ompUlwPath: string;
  readonly nudgeAfterMin: number;
  readonly postAfterMin: number;
  readonly closeAfterMin: number;
  readonly heavySlots: number;
  readonly heavyMaxLoad: number;
  readonly deadPanePatterns: readonly string[];
  readonly guard: GuardThresholds;
  readonly hooks: Hooks;
  /** Expected Git author and committer per lowercase `owner/repo`, for `verify-pr` and the lane footer. */
  readonly repoIdentities: Readonly<Record<string, CommitIdentity>>;
  readonly supervision: SupervisionOptions;
  readonly quota?: QuotaOptions;
  readonly prAutoTrack: boolean; // opt-in: claim and checkpoint PR links are tracked for `dori pr watch`
};

export const defaultConfig = (home = homedir()): DoriConfig => ({
  stateDir: join(home, ".dori", "state"),
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  agentCommand: ["omp", "--dori-role", "lane", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic/claude-opus-5-5",
  launchKeywords: "ulw set goal and work",
  goalMarker: "Pursuing goal",
  startupWaitSeconds: 180,
  sessionsDir: join(home, ".omp", "agent", "sessions"),
  ompUlwPath: join(home, ".dori", "omp-ulw", "index.ts"),
  nudgeAfterMin: 15,
  postAfterMin: 20,
  closeAfterMin: 5,
  heavySlots: 1,
  heavyMaxLoad: 80,
  deadPanePatterns: ["has stopped", "no suitable jobs"],
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 },
  hooks: {},
  repoIdentities: {},
  supervision: {
    hungAfterMinutes: 20,
    staleAfterMinutes: 20,
    defaults: { wallMinutes: null, tokens: null, costUsd: null },
  },
  prAutoTrack: false,
});

export const configPath = (): string => process.env["DORI_CONFIG"] ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

const isIdentity = (value: unknown): value is CommitIdentity => {
  const v = value as { name?: unknown; email?: unknown } | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.name === "string" &&
    !!v.name.trim() &&
    typeof v.email === "string" &&
    !!v.email.trim()
  );
};

// The file is untrusted JSON: keep only well-formed identities, so a bad entry reads as an unconfigured repo.
const repoIdentities = (value: unknown): Record<string, CommitIdentity> =>
  typeof value !== "object" || value === null || Array.isArray(value)
    ? {}
    : Object.fromEntries(
        Object.entries(value).flatMap(([repo, identity]) =>
          isIdentity(identity) ? [[repo.toLowerCase(), identity]] : [],
        ),
      );

export class ConfigError extends Error {}

const RUNTIMES: Readonly<Record<RuntimeKind, true>> = { herdr: true, hc: true };
const checkRuntime = (value: unknown): void => {
  if (value !== undefined && !(typeof value === "string" && Object.hasOwn(RUNTIMES, value)))
    throw new ConfigError(
      `invalid runtime: expected ${Object.keys(RUNTIMES)
        .map((k) => JSON.stringify(k))
        .join(" or ")}, got ${JSON.stringify(value)}`,
    );
};

export const loadConfig = async (path = configPath(), home = homedir()): Promise<DoriConfig> => {
  const selectedHome = process.env["DORI_HOME"];
  const base = {
    ...defaultConfig(home),
    ...(selectedHome && path === join(selectedHome, "config.json")
      ? { stateDir: join(selectedHome, "state"), ompUlwPath: join(selectedHome, "omp-ulw/index.ts") }
      : {}),
  };
  const file = Bun.file(path);
  const raw = (await file.exists()) ? ((await file.json()) as Partial<DoriConfig>) : {};
  checkRuntime(raw.runtime);
  const usageError =
    supervisionOptionsError(raw.supervision) ??
    usageOptionsError(raw.supervision?.usage, raw.supervision?.usageArgv, raw.quota);
  if (usageError) throw new ConfigError(usageError);
  if (raw.prAutoTrack !== undefined && typeof raw.prAutoTrack !== "boolean")
    throw new ConfigError("invalid prAutoTrack: expected true or false");
  const merged: DoriConfig = {
    ...base,
    ...raw,
    guard: { ...base.guard, ...raw.guard },
    hooks: { ...base.hooks, ...raw.hooks },
    repoIdentities: repoIdentities(raw.repoIdentities),
    // Only a string is a marker: null or false would quietly turn the goal check off, and an object would never show.
    goalMarker: typeof raw.goalMarker === "string" ? raw.goalMarker : base.goalMarker,
    // Only a nonnegative number is a wait: a string or null would otherwise end every launch at the first check.
    startupWaitSeconds:
      typeof raw.startupWaitSeconds === "number" &&
      Number.isFinite(raw.startupWaitSeconds) &&
      raw.startupWaitSeconds >= 0
        ? raw.startupWaitSeconds
        : base.startupWaitSeconds,
    supervision: {
      ...base.supervision,
      ...raw.supervision,
      defaults: { ...base.supervision.defaults, ...raw.supervision?.defaults },
    },
  };
  for (const [name, value] of Object.entries({
    hungAfterMinutes: merged.supervision.hungAfterMinutes,
    staleAfterMinutes: merged.supervision.staleAfterMinutes,
    ...merged.supervision.defaults,
  })) {
    if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
      throw new ConfigError(`invalid supervision ${name}: expected a nonnegative number or null`);
  }
  for (const [key, budget] of Object.entries(merged.supervision.lanes ?? {})) {
    for (const [name, value] of Object.entries(budget)) {
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
        throw new ConfigError(`invalid supervision lanes.${key}.${name}: expected a nonnegative number or null`);
    }
  }
  const command = resolveProcessOmpCommand(merged.agentCommand, path);
  return {
    ...merged,
    agentCommand:
      command === merged.agentCommand || process.env["DORI_AGENT_ARGV"] === undefined
        ? resolveConsumerOmpCommand(command, { home })
        : command,
    stateDir: expandHome(process.env["DORI_STATE_DIR"] ?? merged.stateDir, home),
    defaultCwd: expandHome(merged.defaultCwd, home),
    sessionsDir: expandHome(merged.sessionsDir, home),
    ompUlwPath: resolveConsumerOmpUlwPath(resolveProcessOmpUlwPath(expandHome(merged.ompUlwPath, home), home), {
      home,
      useDefault: raw.ompUlwPath === undefined,
    }),
    leadPane: process.env["DORI_LEAD_PANE"] ?? merged.leadPane,
  };
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));
