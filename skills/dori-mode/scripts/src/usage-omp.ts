import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeLock } from "./checkpoint-lock.ts";
import type { DoriConfig } from "./config.ts";
import { LANE_KEY, type Lane, Registry } from "./registry.ts";
import { sessionDirFor, sessionFileStart } from "./session-id.ts";
import type { Usage } from "./supervision-observe.ts";
import { readUsageHeader, type SessionUsage, type UsageEntry } from "./usage-session.ts";
import { readUsageTree } from "./usage-tree.ts";

export class UsageError extends Error {}
export type LaneUsage = {
  readonly key: string;
  readonly thread: string;
  readonly session: string | null;
  readonly observedSession: string | null;
  readonly at: string;
  readonly from: string;
  readonly until: string;
  readonly main: Usage;
  readonly subagents: Usage;
  readonly total: Usage;
  readonly childSessions: number;
  readonly issues: readonly string[];
  readonly entries: readonly UsageEntry[];
  readonly costBasis: "API price estimate, not a bill";
  readonly tokenBasis: "input + output + cacheWrite (cache reads excluded)";
};

const validHistory = (value: unknown) =>
  value === undefined || (Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0));

/** One lane's time interval, never the lifetime of a resumed conversation. Re-reading replaces a snapshot, not adds it. */
export const collectOmpUsage = async (
  config: Pick<DoriConfig, "stateDir" | "sessionsDir" | "defaultCwd">,
  lane: Lane,
  now: number,
  since = 0,
): Promise<LaneUsage> => {
  if (!LANE_KEY.test(lane.key)) throw new UsageError("invalid lane key");
  const from = Math.max(Date.parse(lane.openedAt), since);
  const until = Math.min(now, lane.closedAt ? Date.parse(lane.closedAt) : now);
  if (!Number.isFinite(from) || !Number.isFinite(until)) throw new UsageError("lane interval is invalid");
  const issues: string[] = [];
  const main: UsageEntry[] = [],
    children: UsageEntry[] = [];
  let childSessions = 0;
  let observedSession = lane.session ?? null;
  const totals = (rows: readonly UsageEntry[], incomplete: boolean): Usage => ({
    tokens: incomplete || rows.some((r) => r.tokens === null) ? null : rows.reduce((s, r) => s + (r.tokens ?? 0), 0),
    costUsd: incomplete || rows.some((r) => r.costUsd === null) ? null : rows.reduce((s, r) => s + (r.costUsd ?? 0), 0),
  });
  const result = (): LaneUsage => ({
    key: lane.key,
    thread: lane.thread,
    session: lane.session ?? null,
    observedSession,
    at: new Date(now).toISOString(),
    from: new Date(from).toISOString(),
    until: new Date(until).toISOString(),
    main: totals(main, issues.length > 0),
    subagents: totals(children, issues.length > 0),
    total: totals([...main, ...children], issues.length > 0),
    childSessions,
    issues: [...new Set(issues)],
    entries: [...main, ...children],
    costBasis: "API price estimate, not a bill",
    tokenBasis: "input + output + cacheWrite (cache reads excluded)",
  });
  if (!lane.session) {
    issues.push("lane has no verified session binding; run sync --write");
    return result();
  }
  if (!validHistory(lane.priorSessions)) {
    issues.push("lane session history unavailable");
    return result();
  }
  const others = await new Registry(config.stateDir).list();
  if (others.some((other) => !validHistory(other.priorSessions))) {
    issues.push("lane ownership history unavailable");
    return result();
  }
  const directory = sessionDirFor(config.sessionsDir, lane.cwd ?? config.defaultCwd);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    issues.push("session directory unavailable");
    return result();
  }
  const source = (id: string) => names.filter((name) => sessionFileStart(name)?.id === id);
  const next = new Map<string, { id: string; file: string; valid: boolean }[]>();
  for (const name of names) {
    const candidate = sessionFileStart(name);
    if (!candidate) continue;
    try {
      const header = await readUsageHeader(join(directory, name));
      if (header.continuation)
        next.set(header.continuation, [
          ...(next.get(header.continuation) ?? []),
          { id: header.id, file: name, valid: header.id === candidate.id },
        ]);
    } catch {
      // An unreadable header cannot be proven unrelated to this continuation chain.
      issues.push("continuation discovery incomplete");
    }
  }
  const roots: { id: string; file: string }[] = [];
  for (const binding of new Set([...(lane.priorSessions ?? []), lane.session])) {
    const own = source(binding);
    if (own.length !== 1) {
      issues.push("session file missing or ambiguous");
      continue;
    }
    let current = { id: binding, file: own[0]! };
    const seen = new Set([binding]);
    while (next.has(current.id)) {
      const successors = next.get(current.id)!;
      if (successors.length !== 1 || seen.has(successors[0]!.id)) {
        issues.push("ambiguous or cyclic continuation");
        break;
      }
      const successor = successors[0]!;
      if (!successor.valid) {
        issues.push("session header identity mismatch");
        break;
      }
      current = successor;
      seen.add(current.id);
    }
    if (binding === lane.session) observedSession = current.id;
    roots.push({ id: current.id, file: join(directory, current.file) });
  }
  if (!roots.length) return result();
  const dir = join(config.stateDir, "lanes", lane.key);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "usage-cache.json");
  const held = takeLock(`${path}.lock`, now, (m) => new UsageError(m), { keepLiveOwner: true });
  if (typeof held === "string") {
    issues.push("usage collection in progress");
    return result();
  }
  try {
    let cached: Record<string, SessionUsage> = {};
    if (existsSync(path)) {
      try {
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (value.version === 4 && value.files && typeof value.files === "object") cached = value.files;
      } catch {
        /* Disposable numeric cache: source records remain authoritative. */
      }
    }
    const tree = await readUsageTree(roots, from, until, cached);
    main.push(...tree.main);
    children.push(...tree.children);
    issues.push(...tree.issues);
    if (
      others.some(
        (other) =>
          other.key !== lane.key &&
          [other.session, ...(other.priorSessions ?? [])].some((id) => id && tree.sessionIds.has(id)) &&
          Date.parse(other.openedAt) < until &&
          (other.closedAt ? Date.parse(other.closedAt) : now) > from,
      )
    )
      issues.push("session is shared by overlapping lane intervals");
    childSessions = tree.childSessions;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 4, files: tree.files }), { mode: 0o600 });
    renameSync(tmp, path);
    return result();
  } finally {
    held();
  }
};
