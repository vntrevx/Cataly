import type { BudgetLimits, SupervisionOptions } from "./supervision-observe.ts";

const KEYS: Record<keyof SupervisionOptions, true> = {
  hungAfterMinutes: true,
  staleAfterMinutes: true,
  defaults: true,
  lanes: true,
  usageArgv: true,
  usage: true,
  recordCostArgv: true,
  activityPaths: true,
  gitActivity: true,
};
const CEILINGS: Record<keyof BudgetLimits, true> = { wallMinutes: true, tokens: true, costUsd: true };
const ceilingError = (where: string, budget: object): string | null => {
  for (const name of Object.keys(budget)) {
    if (!Object.hasOwn(CEILINGS, name))
      return `invalid supervision ${where}.${name}: unknown ceiling (expected wallMinutes, tokens or costUsd)`;
  }
  return null;
};

// A malformed setting must not silently turn a ceiling off or crash every later sweep.
export const supervisionOptionsError = (value: unknown): string | null => {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return "invalid supervision: expected an object";
  const input = value as { [K in keyof SupervisionOptions]?: unknown };
  for (const name of Object.keys(input)) {
    if (!Object.hasOwn(KEYS, name)) return `invalid supervision ${name}: unknown setting`;
  }
  for (const name of ["defaults", "lanes"] as const) {
    const budget = input[name];
    if (budget !== undefined && (typeof budget !== "object" || budget === null || Array.isArray(budget)))
      return `invalid supervision ${name}: expected an object`;
  }
  if (input.defaults !== undefined) {
    const problem = ceilingError("defaults", input.defaults as object);
    if (problem) return problem;
  }
  for (const [key, budget] of Object.entries((input.lanes ?? {}) as Record<string, unknown>)) {
    if (typeof budget !== "object" || budget === null || Array.isArray(budget))
      return `invalid supervision lanes.${key}: expected an object`;
    const problem = ceilingError(`lanes.${key}`, budget);
    if (problem) return problem;
  }
  for (const name of ["usageArgv", "recordCostArgv", "activityPaths"] as const) {
    const list = input[name];
    if (list !== undefined && !(Array.isArray(list) && list.every((item) => typeof item === "string")))
      return `invalid supervision ${name}: expected an array of strings`;
  }
  if (input.gitActivity !== undefined && typeof input.gitActivity !== "boolean")
    return "invalid supervision gitActivity: expected true or false";
  return null;
};
