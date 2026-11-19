export type LanePolicy = {
  readonly denyBash: readonly string[];
  readonly perLane?: Readonly<Record<string, { readonly allowBash: readonly string[] }>>;
};
export class PolicyError extends Error {}

export const policyPatterns = (value: unknown, name: string): readonly string[] => {
  if (!Array.isArray(value) || !value.every((s) => typeof s === "string" && s.length > 0))
    throw new PolicyError(`invalid lanePolicy ${name}: expected nonempty regex strings`);
  for (const pattern of value) {
    try {
      new RegExp(pattern);
    } catch {
      throw new PolicyError(`invalid lanePolicy ${name}: invalid regular expression`);
    }
  }
  return value;
};

export const checkLanePolicy = (value: unknown): void => {
  if (value === undefined) return;
  const v = value as Partial<LanePolicy> | null;
  if (
    typeof v !== "object" ||
    v === null ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => k !== "denyBash" && k !== "perLane")
  )
    throw new PolicyError("invalid lanePolicy: expected denyBash and optional perLane");
  policyPatterns(v.denyBash, "denyBash");
  const perLane = v.perLane;
  if (perLane === undefined) return;
  if (typeof perLane !== "object" || perLane === null || Array.isArray(perLane))
    throw new PolicyError("invalid lanePolicy perLane: expected an object");
  for (const [glob, entry] of Object.entries(perLane)) {
    if (
      !/^[a-zA-Z0-9_.*-]+$/.test(glob) ||
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry) ||
      Object.keys(entry).some((k) => k !== "allowBash")
    )
      throw new PolicyError("invalid lanePolicy perLane: expected lane globs with allowBash");
    policyPatterns(entry.allowBash, `perLane.${glob}.allowBash`);
  }
};
