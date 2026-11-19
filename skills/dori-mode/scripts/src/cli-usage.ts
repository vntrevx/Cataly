import { type Command, die } from "./cli-context.ts";
import { QuotaError, readQuota, renderQuota } from "./quota.ts";
import { LANE_KEY } from "./registry.ts";
import { collectOmpUsage, type LaneUsage, UsageError } from "./usage-omp.ts";

const usage: Command = async ({ key, values, opt, deps, config }) => {
  if (key !== undefined && !LANE_KEY.test(key)) return die("invalid lane key");
  const by = opt("by") ?? "lane";
  if (!["lane", "thread", "day"].includes(by)) return die("--by must be lane, thread or day");
  const rawSince = opt("since");
  if (values["since"] !== undefined && !/^\d+(?:\.\d+)?[hd]$/.test(rawSince ?? ""))
    return die("--since must be a duration such as 24h or 7d");
  const now = deps.clock.now();
  const since = rawSince
    ? now - Number(rawSince.slice(0, -1)) * (rawSince.endsWith("d") ? 86_400_000 : 3_600_000)
    : key
      ? 0
      : now - 86_400_000;
  if (!Number.isFinite(new Date(since).getTime())) return die("--since duration is too large");
  const all = key ? [await deps.registry.read(key)].filter((l) => l !== null) : await deps.registry.list();
  if (key && !all.length) return die(`no registered lane ${key}`);
  const lanes: LaneUsage[] = [];
  for (const lane of all) {
    if (lane.closedAt && Date.parse(lane.closedAt) < since) continue;
    lanes.push(await collectOmpUsage(config, lane, now, since));
  }
  const groups = new Map<string, { group: string; lanes: string[]; tokens: number | null; costUsd: number | null }>();
  for (const lane of lanes) {
    const parts: { group: string; tokens: number | null; costUsd: number | null }[] =
      by === "day"
        ? lane.entries.map((e) => ({ group: new Date(e.at).toISOString().slice(0, 10), ...e }))
        : [{ group: by === "thread" ? lane.thread : lane.key, ...lane.total }];
    if (!parts.length && lane.issues.length) parts.push({ group: "unknown", tokens: null, costUsd: null });
    for (const part of parts) {
      const row = groups.get(part.group) ?? { group: part.group, lanes: [], tokens: 0, costUsd: 0 };
      if (!row.lanes.includes(lane.key)) row.lanes.push(lane.key);
      row.tokens = row.tokens === null || part.tokens === null || lane.issues.length ? null : row.tokens + part.tokens;
      row.costUsd =
        row.costUsd === null || part.costUsd === null || lane.issues.length ? null : row.costUsd + part.costUsd;
      groups.set(part.group, row);
    }
  }
  const result = {
    observedAt: new Date(now).toISOString(),
    since: new Date(since).toISOString(),
    by,
    costBasis: "API price estimate, not a bill",
    tokenBasis: "input + output + cacheWrite (cache reads excluded)",
    scope:
      "registered lane intervals, recorded bindings and verified child/advisor files; unknown coverage is not zero",
    groups: [...groups.values()].sort((a, b) => a.group.localeCompare(b.group)),
    lanes: lanes.map(({ entries: _entries, ...summary }) => summary),
  };
  if (values["json"]) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`USAGE ${result.observedAt} | ${result.costBasis} | ${result.tokenBasis}`);
    for (const row of result.groups)
      console.log(
        `${row.group} tokens=${row.tokens ?? "unknown"} costUsd=${row.costUsd === null ? "unknown" : row.costUsd.toFixed(4)}`,
      );
    for (const lane of lanes) {
      console.log(
        `  ${lane.key} main=${lane.main.costUsd ?? "unknown"} subagents=${lane.subagents.costUsd ?? "unknown"} (${lane.childSessions} sessions) interval=${lane.from}..${lane.until}`,
      );
      for (const issue of lane.issues) console.log(`  WARN ${lane.key}: ${issue}`);
    }
    if (!lanes.length) console.log("No registered lanes in this interval");
  }
};

const quota: Command = async ({ values, deps, config }) => {
  const snapshot = await readQuota(config, deps.run, deps.clock.now(), Boolean(values["refresh"]));
  console.log(values["json"] ? JSON.stringify(snapshot, null, 2) : renderQuota(snapshot));
  if (snapshot.errors.length) process.exitCode = 2;
};

export const usageCommands: Readonly<Record<string, Command>> = { usage, quota };
export const usageErrors = [UsageError, QuotaError] as const;
