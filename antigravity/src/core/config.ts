import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { atomicWriteFile } from "./fs-utils.js";

export type RepoIdentity = {
  readonly name: string;
  readonly email: string;
};

export type DiscordConfig = {
  ownerId?: string;
  tokenFile?: string;
  channelIds?: string[];
  guildId?: string;
  scope?: "configured" | "all";
  followThreads?: boolean;
  apiBase?: string;
};

export type OnboardingMemory = {
  status: "not_started" | "completed" | "declined";
  allowedTools: string[];
  declinedTools: string[];
  work?: string;
  persona?: string;
  company?: string;
  notes?: string;
  updatedAt?: string;
};

export type CatalyConfig = {
  agentName: string;
  ownerName?: string;
  doneGraceMinutes: number;
  staleMinutes: number;
  maxLanes: number;
  repoIdentities: Record<string, RepoIdentity>;
  discord: DiscordConfig;
  onboarding: OnboardingMemory;
};

export const DEFAULT_CONFIG: CatalyConfig = {
  agentName: "Cataly",
  doneGraceMinutes: 5,
  staleMinutes: 20,
  maxLanes: 4,
  repoIdentities: {},
  discord: {
    scope: "configured",
    followThreads: true,
    channelIds: [],
  },
  onboarding: {
    status: "not_started",
    allowedTools: [],
    declinedTools: [],
  },
};

export function resolveCatalyHome(overrideHome?: string): string {
  const raw = overrideHome ?? process.env["CATALY_HOME"];
  if (raw && raw.trim()) {
    return resolve(raw.trim());
  }
  return join(homedir(), ".cataly");
}

export function resolveStateDir(catalyHome?: string): string {
  return join(resolveCatalyHome(catalyHome), "state");
}

export function resolveConfigPath(catalyHome?: string): string {
  return join(resolveCatalyHome(catalyHome), "config.json");
}

export function expandUserPath(p: string, baseDir?: string): string {
  const home = homedir();
  const expanded = p === "~" ? home : p.startsWith("~/") || p.startsWith("~\\") ? join(home, p.slice(2)) : p;
  if (isAbsolute(expanded)) return expanded;
  return resolve(baseDir ?? process.cwd(), expanded);
}

type CachedFile<T> = { readonly mtimeMs: number; readonly size: number; readonly value: T };
const configCache = new Map<string, CachedFile<CatalyConfig>>();
const tokenFileCache = new Map<string, CachedFile<string>>();

export function loadConfig(catalyHome?: string): CatalyConfig {
  const path = resolveConfigPath(catalyHome);
  if (!existsSync(path)) {
    configCache.delete(path);
    return structuredClone(DEFAULT_CONFIG);
  }
  const st = statSync(path);
  const hit = configCache.get(path);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return structuredClone(hit.value);
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<CatalyConfig>;
  const parsed: CatalyConfig = {
    agentName: raw.agentName ?? DEFAULT_CONFIG.agentName,
    ...(raw.ownerName !== undefined ? { ownerName: raw.ownerName } : {}),
    doneGraceMinutes: typeof raw.doneGraceMinutes === "number" ? raw.doneGraceMinutes : DEFAULT_CONFIG.doneGraceMinutes,
    staleMinutes: typeof raw.staleMinutes === "number" ? raw.staleMinutes : DEFAULT_CONFIG.staleMinutes,
    maxLanes: typeof raw.maxLanes === "number" ? raw.maxLanes : DEFAULT_CONFIG.maxLanes,
    repoIdentities: { ...raw.repoIdentities },
    discord: {
      ...DEFAULT_CONFIG.discord,
      ...raw.discord,
    },
    onboarding: {
      ...DEFAULT_CONFIG.onboarding,
      ...raw.onboarding,
    },
  };
  configCache.set(path, { mtimeMs: st.mtimeMs, size: st.size, value: parsed });
  return structuredClone(parsed);
}

export function saveConfig(config: CatalyConfig, catalyHome?: string): CatalyConfig {
  const home = resolveCatalyHome(catalyHome);
  mkdirSync(home, { recursive: true });
  const path = resolveConfigPath(home);
  atomicWriteFile(path, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  configCache.delete(path);
  return config;
}

export function updateConfig(
  patch: Partial<Omit<CatalyConfig, "discord" | "onboarding" | "repoIdentities">> & {
    discord?: Partial<DiscordConfig>;
    onboarding?: Partial<OnboardingMemory>;
    repoIdentities?: Record<string, RepoIdentity>;
  },
  catalyHome?: string,
): CatalyConfig {
  const current = loadConfig(catalyHome);
  const next: CatalyConfig = {
    ...current,
    ...(patch.agentName !== undefined ? { agentName: patch.agentName } : {}),
    ...(patch.ownerName !== undefined ? { ownerName: patch.ownerName } : {}),
    ...(patch.doneGraceMinutes !== undefined ? { doneGraceMinutes: patch.doneGraceMinutes } : {}),
    ...(patch.staleMinutes !== undefined ? { staleMinutes: patch.staleMinutes } : {}),
    ...(patch.maxLanes !== undefined ? { maxLanes: patch.maxLanes } : {}),
    repoIdentities: patch.repoIdentities
      ? { ...current.repoIdentities, ...patch.repoIdentities }
      : current.repoIdentities,
    discord: patch.discord ? { ...current.discord, ...patch.discord } : current.discord,
    onboarding: patch.onboarding
      ? { ...current.onboarding, ...patch.onboarding, updatedAt: new Date().toISOString() }
      : current.onboarding,
  };
  return saveConfig(next, catalyHome);
}

/**
 * Load Discord bot token securely without ever logging or returning it in public config views.
 * Precedence: CATALY_DISCORD_TOKEN env -> CATALY_DISCORD_TOKEN_FILE env -> config.discord.tokenFile -> ~/.cataly/secrets/discord.token
 */
export function loadDiscordBotToken(catalyHome?: string): string | null {
  const envToken = process.env["CATALY_DISCORD_TOKEN"]?.trim();
  if (envToken) return envToken;

  const home = resolveCatalyHome(catalyHome);
  const config = loadConfig(home);
  const candidateFiles = [
    process.env["CATALY_DISCORD_TOKEN_FILE"],
    config.discord.tokenFile,
    join(home, "secrets", "discord.token"),
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);

  for (const file of candidateFiles) {
    const resolved = expandUserPath(file.trim(), home);
    if (existsSync(resolved)) {
      const st = statSync(resolved);
      const hit = tokenFileCache.get(resolved);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
        if (hit.value) return hit.value;
        continue;
      }
      const token = readFileSync(resolved, "utf8").trim();
      tokenFileCache.set(resolved, { mtimeMs: st.mtimeMs, size: st.size, value: token });
      if (token) return token;
    }
  }
  return null;
}
