/**
 * Pins one lane's native model profile (every model role and the default thinking level) for its native process.
 *
 * The pin is the process's own last `--config` overlay (see skills/dori-mode/scripts/src/model-profile.ts): native
 * re-reads global and project config live and before task spawns, but every layer below this overlay loses to it, and
 * native never writes overlay files. Runtime overrides (CLI role flags, PI_*_MODEL) outrank it; they and any role the
 * overlay does not name are reported as drift, never adopted. Nothing here selects a model or thinking level.
 */
import { randomUUID } from "node:crypto";
import { closeSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { findScopedSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { cfgDefaultThinkingLevel } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { ModelSnapshot } from "../skills/dori-mode/scripts/src/lane-state.ts";

type Provenance = ModelSnapshot["provenance"]["defaultThinkingLevel"];
type ModelIdentity = ModelSnapshot["model"];

/**
 * The host's Settings class with a setting handle from the same module graph. A handle caches values by its own
 * registry slot inside the Settings it reads, so it may only read an instance of this exact class.
 */
export interface NativeProfileModules {
  readonly Settings: typeof Settings;
  readonly cfgDefaultThinkingLevel: typeof cfgDefaultThinkingLevel;
  /** Inside an extension handler: the settings of the session running it, as native scopes every handler. */
  readonly findScopedSettings: typeof findScopedSettings;
}

/**
 * The running host's modules: the native extension loader routes these canonical specifiers to it. Dynamic because
 * the peer exists only inside a running OMP; CI and Dori CLI processes load this file without one.
 */
export const loadNativeProfileModules = async (): Promise<NativeProfileModules> => {
  const [config, session] = await Promise.all([
    import("@oh-my-pi/pi-coding-agent/config/settings"),
    import("@oh-my-pi/pi-coding-agent/session/settings"),
  ]);
  return {
    Settings: config.Settings,
    cfgDefaultThinkingLevel: session.cfgDefaultThinkingLevel,
    findScopedSettings: config.findScopedSettings,
  };
};

interface Profile {
  readonly modelRoles: Readonly<Record<string, string>>;
  readonly roleProvenance: Readonly<Record<string, Provenance>>;
  readonly defaultThinkingLevel: string;
  readonly thinkingProvenance: Provenance;
}

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const readProfile = (modules: NativeProfileModules, settings: Settings): Profile | string => {
  if (!(settings instanceof modules.Settings)) return "native settings belong to another OMP module graph";
  if (settings.overlayParent()) return "native settings are a child overlay, not the root session's settings";
  // Native lists only roles that name a model; `undefined` is the index signature's absent role, never a value.
  const modelRoles: Record<string, string> = {};
  for (const [role, model] of Object.entries(settings.getModelRoles()))
    if (model !== undefined) modelRoles[role] = model;
  return {
    modelRoles,
    roleProvenance: Object.fromEntries(
      Object.keys(modelRoles).map((role) => [role, settings.getModelRoleProvenance(role)]),
    ),
    defaultThinkingLevel: modules.cfgDefaultThinkingLevel.get(settings),
    thinkingProvenance: modules.cfgDefaultThinkingLevel.provenance(settings),
  };
};

/** The overlay must be this process's last config file, or a later overlay could outrank it. */
const notOwned = (settings: Settings, file: string): string | null =>
  settings.getConfigFiles().at(-1) === resolve(file)
    ? null
    : `model profile ${file} is not this native process's last --config overlay`;

/** Replace the overlay atomically, then apply it with the native reload every other config change uses. */
const applyOverlay = async (
  settings: Settings,
  file: string,
  content: Record<string, unknown>,
): Promise<string | null> => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const descriptor = openSync(temporary, "wx", 0o600);
    created = true;
    try {
      writeFileSync(descriptor, `${JSON.stringify(content)}\n`);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, file);
  } catch (error) {
    if (created) rmSync(temporary, { force: true });
    return `model profile ${file} not written: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    await settings.reloadFromDisk();
    return null;
  } catch (error) {
    return `native settings reload failed: ${error instanceof Error ? error.message : String(error)}`;
  }
};

/** The effective native profile now, with the layer each value came from. Captures; never pins. */
export const captureModelSnapshot = (
  modules: NativeProfileModules,
  settings: Settings,
  input: {
    readonly kind: ModelSnapshot["provenance"]["kind"];
    readonly requested: string;
    readonly model: ModelIdentity | null | undefined;
    readonly configuredThinkingLevel: string | undefined;
    readonly thinkingLevel: string | undefined;
  },
): ModelSnapshot | string => {
  if (!input.model?.provider || !input.model.id) return "native actual model is unknown; no model profile captured";
  const profile = readProfile(modules, settings);
  if (typeof profile === "string") return profile;
  return {
    version: 1,
    id: randomUUID(),
    model: { provider: input.model.provider, id: input.model.id },
    modelRoles: profile.modelRoles,
    defaultThinkingLevel: profile.defaultThinkingLevel,
    configuredThinkingLevel: input.configuredThinkingLevel ?? null,
    thinkingLevel: input.thinkingLevel ?? null,
    capturedAt: new Date().toISOString(),
    provenance: {
      kind: input.kind,
      requested: input.requested,
      modelRoles: profile.roleProvenance,
      defaultThinkingLevel: profile.thinkingProvenance,
    },
  };
};

const profileDrift = (modules: NativeProfileModules, settings: Settings, file: string, snapshot: ModelSnapshot) => {
  const owned = notOwned(settings, file);
  if (owned) return owned;
  const profile = readProfile(modules, settings);
  if (typeof profile === "string") return profile;
  const drift: string[] = [];
  const roles = new Set([...Object.keys(snapshot.modelRoles), ...Object.keys(profile.modelRoles)]);
  for (const role of [...roles].sort()) {
    const expected = own(snapshot.modelRoles, role);
    const actual = own(profile.modelRoles, role);
    if (expected === actual) continue;
    const source = own(profile.roleProvenance, role);
    drift.push(
      expected === undefined
        ? `unexpected role ${role}=${actual} (${source})`
        : actual === undefined
          ? `role ${role} unset, expected ${expected}`
          : `role ${role}=${actual} (${source}), expected ${expected}`,
    );
  }
  if (profile.defaultThinkingLevel !== snapshot.defaultThinkingLevel)
    drift.push(
      `defaultThinkingLevel=${profile.defaultThinkingLevel} (${profile.thinkingProvenance}), expected ${snapshot.defaultThinkingLevel}`,
    );
  return drift.length ? `native model profile drift: ${drift.join("; ")}` : null;
};

/**
 * Pin `snapshot` in this process's profile overlay and read it back. Roles any native layer names but the snapshot
 * lacks are unset by the overlay, so a role added globally after capture does not reach this lane.
 * Returns a HOLD reason, or null when the native profile now equals the snapshot.
 */
export const bindModelProfile = async (
  modules: NativeProfileModules,
  settings: Settings,
  file: string,
  snapshot: ModelSnapshot,
): Promise<string | null> => {
  const owned = notOwned(settings, file);
  if (owned) return owned;
  const profile = readProfile(modules, settings);
  if (typeof profile === "string") return profile;
  const layers = settings.mirrorState();
  const named = new Set<string>();
  for (const layer of [layers.global, layers.project, layers.configOverlay, layers.overrides]) {
    const roles = layer["modelRoles"];
    if (roles && typeof roles === "object" && !Array.isArray(roles))
      for (const role of Object.keys(roles)) named.add(role);
  }
  const modelRoles = { ...Object.fromEntries([...named].map((role) => [role, null])), ...snapshot.modelRoles };
  const failed = await applyOverlay(settings, file, {
    modelRoles,
    defaultThinkingLevel: snapshot.defaultThinkingLevel,
  });
  return failed ?? profileDrift(modules, settings, file, snapshot);
};

/**
 * Whether this native session still runs `snapshot`: the actual model is the authority and is only compared, then the
 * full pinned profile. Returns a HOLD reason or null. Drift is never repaired here; rebinding is the caller's decision.
 */
export const checkModelProfile = (
  modules: NativeProfileModules,
  settings: Settings,
  file: string,
  snapshot: ModelSnapshot,
  actual: { readonly provider?: string; readonly id: string } | null | undefined,
): string | null => {
  if (!actual?.provider || !actual.id) return "native actual model is unknown";
  if (actual.provider !== snapshot.model.provider || actual.id !== snapshot.model.id)
    return `native actual model ${actual.provider}/${actual.id} differs from snapshot ${snapshot.model.provider}/${snapshot.model.id}`;
  return profileDrift(modules, settings, file, snapshot);
};

/**
 * Compare the native selector, never auto's changing per-turn effective observation. Native session reconstruction
 * restores a null no-thinking entry as `off`; both mean no configured effort, not a selector change.
 */
export const thinkingSelectionDrift = (snapshot: ModelSnapshot, configured: string | undefined): string | null =>
  (configured ?? "off") === (snapshot.configuredThinkingLevel ?? "off")
    ? null
    : `native thinking selection ${configured ?? "(unset)"} differs from snapshot ${snapshot.configuredThinkingLevel ?? "(unset)"}`;

/** Empty this process's overlay: only the pin goes; every other layer keeps whatever native wrote meanwhile. */
export const releaseModelProfile = async (settings: Settings, file: string): Promise<string | null> =>
  notOwned(settings, file) ?? (await applyOverlay(settings, file, {}));
