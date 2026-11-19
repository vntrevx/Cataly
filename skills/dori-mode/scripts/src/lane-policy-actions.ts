import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { takeLock } from "./checkpoint-lock.ts";
import { PolicyError } from "./lane-policy.ts";
import { type BoundPolicy, policyBinding, readLanePolicy } from "./lane-policy-store.ts";
import { Reports } from "./reports.ts";

type Grant = { rule: string; hash: string; reason: string; at: string; usedAt?: string };
type Blocked = { hash: string; rules: string[] };
type PolicyState = { id: string; grants: Grant[]; blocked?: Blocked };
const HASH = /^[a-f0-9]{64}$/;
const RULE = /^denyBash\[(0|[1-9][0-9]*)\]$/;
const stamp = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const ruleValid = (value: unknown, policy: BoundPolicy): value is string =>
  typeof value === "string" && RULE.test(value) && Number(RULE.exec(value)?.[1]) < policy.snapshot.denyBash.length;

const readState = (file: string, policy: BoundPolicy): PolicyState => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { id: policy.snapshot.id, grants: [] };
    throw error;
  }
  const v = value as Partial<PolicyState> | null;
  if (typeof v !== "object" || v === null || v.id !== policy.snapshot.id || !Array.isArray(v.grants))
    throw new PolicyError("invalid lane policy grant journal");
  for (const grant of v.grants) {
    if (
      typeof grant !== "object" ||
      grant === null ||
      !ruleValid(grant.rule, policy) ||
      typeof grant.hash !== "string" ||
      !HASH.test(grant.hash) ||
      typeof grant.reason !== "string" ||
      !grant.reason.trim() ||
      !stamp(grant.at) ||
      (grant.usedAt !== undefined && !stamp(grant.usedAt))
    )
      throw new PolicyError("invalid lane policy grant receipt");
  }
  if (
    v.blocked !== undefined &&
    (typeof v.blocked !== "object" ||
      v.blocked === null ||
      typeof v.blocked.hash !== "string" ||
      !HASH.test(v.blocked.hash) ||
      !Array.isArray(v.blocked.rules) ||
      !v.blocked.rules.length ||
      !v.blocked.rules.every((rule) => ruleValid(rule, policy)))
  )
    throw new PolicyError("invalid lane policy blocked-command receipt");
  return { id: v.id, grants: v.grants, ...(v.blocked ? { blocked: v.blocked } : {}) };
};

const withState = <T>(
  policy: BoundPolicy,
  now: number,
  update: (
    state: PolicyState,
    policy: BoundPolicy,
  ) => { value: T; blocker?: string; activity?: string; clearedBlocker?: string },
): T => {
  const file = join(dirname(policy.file), `policy-grants-${policy.snapshot.id}.json`);
  const held = takeLock(`${file}.lock`, now, (message) => new PolicyError(message), { keepLiveOwner: true });
  if (typeof held === "string") throw new PolicyError(`lane policy held: ${held}`);
  try {
    // A new launch may replace the snapshot between the first read and acquiring this generation's lock.
    const current = readLanePolicy(policyBinding(policy));
    const state = readState(file, current);
    const before = JSON.stringify(state);
    const result = update(state, current);
    const after = JSON.stringify(state);
    if (before !== after) {
      const tmp = `${file}.${randomUUID()}.tmp`;
      writeFileSync(tmp, after, { flag: "wx", mode: 0o600 });
      renameSync(tmp, file);
    }
    const reports = new Reports(current.stateDir);
    if (result.blocker) {
      const last = reports.read(current.snapshot.key)?.lastReport;
      if (last?.kind !== "blocker" || last.text !== result.blocker)
        reports.report(current.snapshot.key, "blocker", result.blocker, now);
    }
    if (result.activity) {
      const last = reports.read(current.snapshot.key)?.lastReport;
      if (result.clearedBlocker && last?.kind === "blocker" && last.text === result.clearedBlocker)
        reports.report(current.snapshot.key, "milestone", result.activity, now);
      else
        reports.append({
          type: "activity",
          key: current.snapshot.key,
          at: new Date(now).toISOString(),
          state: "running",
          text: result.activity,
        });
    }
    return result.value;
  } finally {
    held();
  }
};

/** An allow-once admits one tool attempt, not an execution or an override of native approvals. */
export const checkPolicyCommand = (binding: string, command: string, now: number): string | undefined => {
  const policy = readLanePolicy(binding);
  if (policy.snapshot.allowBash.some((pattern) => new RegExp(`^(?:${pattern})$`).test(command))) return;
  const rules = policy.snapshot.denyBash.flatMap((pattern, index) =>
    new RegExp(pattern).test(command) ? [`denyBash[${index}]`] : [],
  );
  if (!rules.length) return;
  return withState<string | undefined>(policy, now, (state, policy) => {
    const hash = createHash("sha256").update(command).digest("hex");
    const notice = `LANE_POLICY_BLOCKED ${policy.snapshot.key} bash rule=${rules.join(",")} command-sha256=${hash}`;
    const grants = rules.map((rule) =>
      state.grants.find((grant) => grant.rule === rule && grant.hash === hash && grant.usedAt === undefined),
    );
    if (grants.every((grant) => grant !== undefined)) {
      for (const grant of grants) grant.usedAt = new Date(now).toISOString();
      if (state.blocked?.hash === hash && state.blocked.rules.join(",") === rules.join(",")) delete state.blocked;
      return {
        value: undefined,
        activity: `LANE_POLICY_ALLOWED_ONCE ${rules.join(",")} command-sha256=${hash}`,
        clearedBlocker: notice,
      };
    }
    state.blocked = { hash, rules };
    return {
      value: `${notice}. Report this blocker to the owner or lead for approval; this lane cannot grant its own exception. No command ran.`,
      blocker: notice,
    };
  });
};

export const allowPolicyOnce = (binding: string, rule: string, reason: string, now: number): Grant => {
  if (!reason.trim()) throw new PolicyError("allow-once requires a nonempty approval reason");
  return withState(readLanePolicy(binding), now, (state, policy) => {
    if (!ruleValid(rule, policy) || !state.blocked?.rules.includes(rule))
      throw new PolicyError("allow-once must name a rule from the most recently blocked command");
    const hash = state.blocked.hash;
    const existing = state.grants.find((grant) => grant.rule === rule && grant.hash === hash && !grant.usedAt);
    if (existing) return { value: existing };
    const grant = { rule, hash, reason: reason.trim(), at: new Date(now).toISOString() };
    state.grants.push(grant);
    return {
      value: grant,
      activity: `LANE_POLICY_ALLOW_ONCE ${rule} command-sha256=${hash}: ${grant.reason}`,
    };
  });
};
