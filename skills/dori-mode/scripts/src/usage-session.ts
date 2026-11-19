import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";

export type UsageEntry = {
  readonly id: string;
  readonly at: number;
  readonly tokens: number | null;
  readonly costUsd: number | null;
};
export type SessionUsage = {
  readonly signature: string;
  readonly id: string;
  readonly startedAt: number;
  readonly parent: string | null;
  readonly continuation: string | null;
  readonly seance: boolean;
  readonly entries: readonly UsageEntry[];
  readonly tasks: readonly {
    readonly at: number;
    readonly children: readonly { readonly id: string; readonly zero: boolean }[] | null;
  }[];
  readonly errors: readonly string[];
};

/** Only the title/header prefix is read when finding continuation files; no unrelated transcript is parsed. */
export const readUsageHeader = async (path: string): Promise<{ id: string; continuation: string | null }> => {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const value = JSON.parse(line) as { type?: unknown; id?: unknown; continuationOf?: unknown };
      if (value?.type === "title") continue;
      if (value?.type !== "session" || typeof value.id !== "string") throw new Error("session header unavailable");
      return { id: value.id, continuation: typeof value.continuationOf === "string" ? value.continuationOf : null };
    }
    throw new Error("session header unavailable");
  } finally {
    lines.close();
    stream.destroy();
  }
};

/** OMP 18.20.0 session-entries.ts: assistant messages and model_usage are separate billed calls.
 * Task result aggregates are deliberately excluded: verified child files supply their own calls.
 * Cache only numeric usage, IDs and timestamps, never conversation content. Changed files are rebuilt,
 * so replacement/truncation and discarded-turn model_usage rewrites cannot retain old spend. */
export const readSessionUsage = async (path: string, cached?: SessionUsage): Promise<SessionUsage> => {
  const stat = statSync(path, { bigint: true });
  const signature = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
  if (
    cached?.signature === signature &&
    typeof cached.id === "string" &&
    cached.id.length > 0 &&
    (cached.parent === null || typeof cached.parent === "string") &&
    (cached.continuation === null || typeof cached.continuation === "string") &&
    typeof cached.seance === "boolean" &&
    Number.isFinite(cached.startedAt) &&
    Array.isArray(cached.entries) &&
    Array.isArray(cached.tasks) &&
    Array.isArray(cached.errors) &&
    !cached.errors.length &&
    cached.tasks.every(
      (task) =>
        task &&
        Number.isFinite(task.at) &&
        (task.children === null ||
          (Array.isArray(task.children) &&
            task.children.every(
              (child: unknown) =>
                child !== null &&
                typeof child === "object" &&
                "id" in child &&
                typeof child.id === "string" &&
                "zero" in child &&
                typeof child.zero === "boolean",
            ))),
    ) &&
    cached.entries.every(
      (entry) =>
        entry &&
        typeof entry.id === "string" &&
        Number.isFinite(entry.at) &&
        (entry.tokens === null || (Number.isFinite(entry.tokens) && entry.tokens >= 0)) &&
        (entry.costUsd === null || (Number.isFinite(entry.costUsd) && entry.costUsd >= 0)),
    )
  )
    return cached;
  const entries = new Map<string, UsageEntry>();
  const errors: string[] = [];
  let id = "",
    startedAt = Number.NaN,
    parent: string | null = null,
    continuation: string | null = null,
    seance = false;
  const tasks: { at: number; children: { id: string; zero: boolean }[] | null }[] = [];
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const metric = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let value: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid record");
        value = parsed as Record<string, unknown>;
      } catch {
        errors.push("unreadable session record");
        continue;
      }
      if (value["type"] === "session") {
        if (id || typeof value["id"] !== "string") {
          errors.push("invalid session identity");
          continue;
        }
        id = value["id"];
        startedAt = Date.parse(String(value["timestamp"]));
        parent = typeof value["parentSession"] === "string" ? value["parentSession"] : null;
        continuation = typeof value["continuationOf"] === "string" ? value["continuationOf"] : null;
        seance = typeof value["seanceSource"] === "string" && value["seanceSource"].length > 0;
        continue;
      }
      const message = value["message"] as Record<string, unknown> | undefined;
      if (value["type"] === "message" && message?.["role"] === "toolResult" && message["toolName"] === "task") {
        const at = Date.parse(String(value["timestamp"]));
        const details = message["details"] as
          | { results?: Record<string, unknown>[]; progress?: Record<string, unknown>[] }
          | undefined;
        const refs = [
          ...(Array.isArray(details?.results)
            ? details.results.map((ref) => ({ ref, settled: Number.isInteger(ref?.["exitCode"]) }))
            : []),
          ...(Array.isArray(details?.progress)
            ? details.progress.map((ref) => ({
                ref,
                settled: ["completed", "failed", "aborted"].includes(String(ref?.["status"])),
              }))
            : []),
        ];
        const known =
          (Array.isArray(details?.results) || Array.isArray(details?.progress)) &&
          refs.every(({ ref }) => ref && typeof ref["id"] === "string" && ref["id"].length > 0);
        if (Number.isFinite(at))
          tasks.push({
            at,
            children: known
              ? refs.map(({ ref, settled }) => ({
                  id: String(ref["id"]),
                  // Lazy native journals may be absent only when terminal counters prove no calls.
                  zero:
                    settled &&
                    ref["tokens"] === 0 &&
                    ref["requests"] === 0 &&
                    (ref["cost"] === undefined || ref["cost"] === 0) &&
                    ref["usage"] === undefined &&
                    ref["advisor"] === undefined,
                }))
              : null,
          });
        else errors.push("task result has no timestamp");
      }
      const own = value["type"] === "model_usage" || (value["type"] === "message" && message?.["role"] === "assistant");
      if (!own) continue;
      const usage = (value["type"] === "model_usage" ? value["usage"] : message?.["usage"]) as
        | Record<string, unknown>
        | undefined;
      const cost = usage?.["cost"] as Record<string, unknown> | undefined;
      const input = metric(usage?.["input"]),
        output = metric(usage?.["output"]),
        cacheWrite = metric(usage?.["cacheWrite"]);
      const entry: UsageEntry = {
        id: typeof value["id"] === "string" ? value["id"] : "",
        at: Date.parse(String(value["timestamp"])),
        tokens: input === null || output === null || cacheWrite === null ? null : metric(input + output + cacheWrite),
        costUsd: metric(cost?.["total"]),
      };
      if (!entry.id || !Number.isFinite(entry.at)) {
        errors.push("usage record has no identity or timestamp");
        continue;
      }
      const previous = entries.get(entry.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
        errors.push("conflicting usage record identity");
      entries.set(entry.id, entry);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (!id || !Number.isFinite(startedAt)) errors.push("session header unavailable");
  const after = statSync(path, { bigint: true });
  if ([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs].join(":") !== signature)
    errors.push("session changed during observation");
  return {
    signature,
    id,
    startedAt,
    parent,
    continuation,
    seance,
    entries: [...entries.values()],
    tasks,
    errors: [...new Set(errors)],
  };
};
