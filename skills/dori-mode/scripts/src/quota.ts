import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DoriConfig } from "./config.ts";
import type { Runner } from "./run.ts";

export type QuotaOptions = {
  readonly command?: readonly string[];
  readonly cacheMinutes?: number;
  readonly warnUsedPercent?: number;
};
export type QuotaLimit = {
  readonly label: string;
  readonly durationMs: number | null;
  readonly windowId: string | null;
  readonly usedFraction: number | null;
  readonly resetsAt: number | null;
  readonly status: string;
};
export type QuotaAccount = {
  readonly provider: string;
  readonly account: string;
  readonly fetchedAt: number | null;
  readonly state: "reported" | "unavailable" | "disabled";
  readonly limits: readonly QuotaLimit[];
};
export type QuotaSnapshot = {
  readonly observedAt: number;
  readonly generatedAt: number | null;
  readonly accounts: readonly QuotaAccount[];
  readonly stale: boolean;
  readonly errors: readonly string[];
  readonly warnUsedPercent: number | null;
};
export class QuotaError extends Error {}

const number = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = (value: unknown): number | null => {
  const n = number(value);
  return n !== null && n <= 8_640_000_000_000_000 ? n : null;
};
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Pinned OMP usage JSON, excluding raw payloads, credentials and reset-credit data. No policy mutation. */
export const parseQuota = (value: unknown): { generatedAt: number; accounts: QuotaAccount[] } => {
  const data = record(value),
    generatedAt = timestamp(data["generatedAt"]);
  if (generatedAt === null || !Array.isArray(data["reports"])) throw new QuotaError("invalid OMP usage JSON");
  const accounts: QuotaAccount[] = [];
  const identity = (r: Record<string, unknown>, i: number) => {
    const meta = record(r["metadata"]);
    return String(meta["email"] ?? meta["accountId"] ?? r["email"] ?? r["accountId"] ?? `account-${i + 1}`);
  };
  for (const [i, item] of data["reports"].entries()) {
    const report = record(item);
    if (typeof report["provider"] !== "string" || !Array.isArray(report["limits"]))
      throw new QuotaError("invalid OMP account report");
    const limits = report["limits"].map((item): QuotaLimit => {
      const limit = record(item),
        amount = record(limit["amount"]),
        window = record(limit["window"]),
        scope = record(limit["scope"]);
      const explicit = number(amount["usedFraction"]),
        used = number(amount["used"]),
        maximum = number(amount["limit"]),
        remaining = number(amount["remainingFraction"]);
      const fraction =
        explicit ??
        (used !== null && maximum !== null && maximum > 0
          ? used / maximum
          : amount["unit"] === "percent" && used !== null
            ? used / 100
            : remaining === null
              ? null
              : Math.max(0, 1 - remaining));
      return {
        label: typeof limit["label"] === "string" ? limit["label"] : "unknown window",
        durationMs: number(window["durationMs"]),
        windowId: typeof scope["windowId"] === "string" ? scope["windowId"] : null,
        usedFraction: fraction,
        resetsAt: timestamp(window["resetsAt"]),
        status: typeof limit["status"] === "string" ? limit["status"] : "unknown",
      };
    });
    accounts.push({
      provider: report["provider"],
      account: identity(report, i),
      fetchedAt: timestamp(report["fetchedAt"]),
      state: "reported",
      limits,
    });
  }
  for (const [field, state] of [
    ["accountsWithoutUsage", "unavailable"],
    ["disabledCredentials", "disabled"],
  ] as const) {
    if (data[field] === undefined) continue;
    if (!Array.isArray(data[field])) throw new QuotaError("invalid OMP unreported accounts");
    for (const [i, item] of data[field].entries()) {
      const account = record(item);
      accounts.push({
        provider: typeof account["provider"] === "string" ? account["provider"] : "unknown",
        account: identity(account, i),
        fetchedAt: null,
        state,
        limits: [],
      });
    }
  }
  return { generatedAt, accounts };
};

export const readQuota = async (
  config: DoriConfig,
  run: Runner,
  now: number,
  refresh = false,
): Promise<QuotaSnapshot> => {
  const options = config.quota ?? {};
  const stop = config.agentCommand.indexOf("--dori-role");
  const command = options.command ?? (stop > 0 ? config.agentCommand.slice(0, stop) : []);
  if (!command.length) throw new QuotaError("quota needs an OMP launcher in quota.command");
  const ttl = (options.cacheMinutes ?? 5) * 60_000;
  const key = createHash("sha256").update(JSON.stringify(command)).digest("hex");
  const path = join(config.stateDir, "quota-cache.json");
  let previous: { key: string; fetchedAt: number; data: { generatedAt: number; accounts: QuotaAccount[] } } | null =
    null;
  if (existsSync(path)) {
    try {
      const stored = JSON.parse(readFileSync(path, "utf8"));
      const accounts = stored.data?.accounts;
      if (
        stored.key === key &&
        timestamp(stored.fetchedAt) !== null &&
        timestamp(stored.data?.generatedAt) !== null &&
        Array.isArray(accounts) &&
        accounts.every(
          (a) =>
            typeof a.provider === "string" &&
            typeof a.account === "string" &&
            ["reported", "unavailable", "disabled"].includes(a.state) &&
            (a.fetchedAt === null || timestamp(a.fetchedAt) !== null) &&
            Array.isArray(a.limits) &&
            a.limits.every(
              (l: QuotaLimit) =>
                typeof l.label === "string" &&
                typeof l.status === "string" &&
                (l.windowId === null || typeof l.windowId === "string") &&
                (l.durationMs === null || number(l.durationMs) !== null) &&
                (l.usedFraction === null || number(l.usedFraction) !== null) &&
                (l.resetsAt === null || timestamp(l.resetsAt) !== null),
            ),
        )
      )
        previous = stored;
    } catch {
      /* A corrupt display cache is not provider data. */
    }
  }
  const snapshot = (
    data: { generatedAt: number; accounts: QuotaAccount[] } | null,
    errors: readonly string[],
  ): QuotaSnapshot => ({
    observedAt: now,
    generatedAt: data?.generatedAt ?? null,
    accounts: data?.accounts ?? [],
    stale:
      errors.length > 0 ||
      !data ||
      now < data.generatedAt ||
      now - data.generatedAt > ttl ||
      data.accounts.some(
        (a) => a.state === "reported" && (a.fetchedAt === null || now < a.fetchedAt || now - a.fetchedAt > ttl),
      ),
    errors,
    warnUsedPercent: options.warnUsedPercent ?? null,
  });
  if (!refresh && previous && now >= previous.fetchedAt && now - previous.fetchedAt <= ttl)
    return snapshot(previous.data, []);
  const response = await run([...command, "usage", "--json"], { timeoutMs: 15_000 });
  if (response.code !== 0)
    return snapshot(previous?.data ?? null, [
      `OMP usage query failed (exit ${response.code}); no account switch or retry`,
    ]);
  let data: { generatedAt: number; accounts: QuotaAccount[] };
  try {
    data = parseQuota(JSON.parse(response.out));
  } catch {
    return snapshot(previous?.data ?? null, ["OMP usage response unavailable or malformed"]);
  }
  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ key, fetchedAt: now, data }), { mode: 0o600 });
  renameSync(tmp, path);
  return snapshot(data, []);
};

export const renderQuota = (snapshot: QuotaSnapshot): string => {
  const clean = (value: string) => Bun.stripANSI(value).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
  const lines = [
    `QUOTA ${snapshot.stale ? "stale/unknown" : "observed"} at=${snapshot.generatedAt === null ? "unknown" : new Date(snapshot.generatedAt).toISOString()} (display only)`,
  ];
  for (const account of snapshot.accounts) {
    const windows = account.limits.map(
      (limit) =>
        `${clean(limit.label)} ${limit.usedFraction === null ? "unknown" : `${(limit.usedFraction * 100).toFixed(1)}%`} reset=${limit.resetsAt === null ? "unknown" : new Date(limit.resetsAt).toISOString()} ${clean(limit.status)}${snapshot.warnUsedPercent !== null && limit.usedFraction !== null ? ` display-headroom=${(snapshot.warnUsedPercent - limit.usedFraction * 100).toFixed(1)}pp` : ""}`,
    );
    if (
      !account.limits.some(
        (l) =>
          l.windowId?.toLowerCase() === "5h" ||
          (l.durationMs !== null && Math.abs(l.durationMs - 18_000_000) <= 60_000),
      )
    )
      windows.push("5h missing");
    if (!account.limits.some((l) => l.windowId?.toLowerCase() === "7d" || l.durationMs === 604_800_000))
      windows.push("weekly missing");
    lines.push(
      `${clean(account.provider)} ${clean(account.account)} ${account.state} observed=${account.fetchedAt === null ? "unknown" : new Date(account.fetchedAt).toISOString()} | ${windows.join(" | ")}`,
    );
  }
  if (!snapshot.accounts.length) lines.push("accounts unknown or none reported (not zero usage)");
  for (const error of snapshot.errors) lines.push(`WARN ${error}`);
  return lines.join("\n");
};
