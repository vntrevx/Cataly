import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type RepoIdentity } from "./config.js";
import { atomicWriteFile, withFileLock } from "./fs-utils.js";
import { defaultRunner, type Runner } from "./signals.js";

export type PrFile = {
  readonly filename: string;
  readonly status: string;
  readonly patch?: string;
  readonly previous_filename?: string;
};

export type PrCommit = {
  readonly sha: string;
  readonly commit: {
    readonly message: string;
    readonly author: RepoIdentity | null;
    readonly committer: RepoIdentity | null;
  };
  readonly files: readonly PrFile[];
  readonly parents?: readonly { readonly sha: string }[];
};

export type PrSnapshot = {
  readonly repo: string;
  readonly number: number;
  readonly body: string | null;
  readonly head: string;
  readonly commits: readonly PrCommit[];
  readonly files: readonly PrFile[];
};

export type VerifyPrResult = {
  readonly ok: boolean;
  readonly repo: string;
  readonly number: number;
  readonly head?: string;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly asyncUiTests: readonly string[];
};

export type TrackedPr = {
  readonly repo: string;
  readonly number: number;
  readonly lane?: string;
  readonly thread?: string;
  readonly trackedAt: string;
  readonly lastHeadSha?: string;
  readonly lastState?: string;
  readonly lastReviewCount?: number;
  readonly lastCommentCount?: number;
};

export type PrWatchEvent = {
  readonly repo: string;
  readonly number: number;
  readonly lane?: string;
  readonly thread?: string;
  readonly kind: "MERGED" | "CLOSED" | "NEW_COMMITS" | "NEW_REVIEWS" | "NEW_COMMENTS" | "CI_FAILED";
  readonly detail: string;
};

const isTest = (path: string): boolean =>
  !/(?:^|\/)(?:fixtures?|__fixtures__|__snapshots__|helpers?|fakes?|mocks?)\//i.test(path) &&
  (/(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]sx?|py|go|rs|rb|sh|java|kt|swift)$/i.test(path) ||
    /(?:^|\/)(?:test_[^/]+\.py|[^/]+_test\.(?:go|py))$/i.test(path) ||
    (/(?:^|\/)(?:tests?|__tests__)\//i.test(path) &&
      /\.(?:[cm]?[jt]sx?|py|go|rs|rb|sh|java|kt|swift)$/i.test(path) &&
      !/(?:^|\/)(?:(?:setup|conftest|test-utils)[./]|(?:fixtures?|helpers?|fakes?|mocks?)\.[^/]*$)/i.test(path)));

const isSource = (path: string): boolean =>
  !isTest(path) &&
  !/(?:^|\/)(?:docs?|fixtures?|__fixtures__|__snapshots__)\//i.test(path) &&
  /\.(?:[cm]?[jt]sx?|css|scss|sass|less|html|vue|svelte|py|go|rs|rb|sh|sql|c|cpp|h|java|kt|swift)$/i.test(path);

const isUiTest = (file: PrFile): boolean =>
  isTest(file.filename) &&
  file.status !== "removed" &&
  (/\.[jt]sx$/i.test(file.filename) ||
    /(?:^|\/)(?:components?|features?|ui|e2e|browser|playwright)\//i.test(file.filename) ||
    /\b(?:WebView|document|window|page\.(?:goto|locator)|render|screen\.|waitFor|userEvent|fireEvent)\b/.test(
      file.patch ?? "",
    ));

export function checkPrSnapshot(snapshot: PrSnapshot, expectedIdentity?: RepoIdentity): VerifyPrResult {
  const { repo, number } = snapshot;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) errors.push("repository must be owner/repo");
  if (!Number.isSafeInteger(number) || number < 1) errors.push("PR number must be a positive integer");
  if (!snapshot.commits.length) errors.push("PR has no commits to verify");

  const noTestReason = /^No test:[ \t]*(\S[^\r\n]*)$/m.exec(snapshot.body ?? "")?.[1]?.trim();
  let fixesSource = false;
  const changesTest = (file: PrFile): boolean =>
    ["added", "modified", "renamed", "copied", "changed"].includes(file.status) && isTest(file.filename);

  for (const c of snapshot.commits) {
    if (expectedIdentity) {
      for (const role of ["author", "committer"] as const) {
        const actual = c.commit[role];
        if (!actual?.email?.trim()) {
          errors.push(
            `${c.sha}: missing ${role} identity; expected ${expectedIdentity.name} <${expectedIdentity.email}>`,
          );
        } else if (
          actual.email.toLowerCase() === "noreply@github.com"
            ? !(role === "committer" && Array.isArray(c.parents) && c.parents.length > 1)
            : actual.email.toLowerCase() !== expectedIdentity.email.toLowerCase()
        ) {
          errors.push(`${c.sha}: wrong ${role} email ${actual.email}; expected ${expectedIdentity.email}`);
        }
      }
    }
    if (
      /^fix(?:\([^)]+\))?!?:/.test(c.commit.message) &&
      c.files.some((f) => isSource(f.filename) || (f.previous_filename !== undefined && isSource(f.previous_filename)))
    ) {
      fixesSource = true;
      if (!c.files.some(changesTest)) {
        warnings.push(`${c.sha}: fix commit touches source without its own test; checking across full PR`);
      }
    }
  }

  if (fixesSource && !snapshot.files.some(changesTest)) {
    const msg = "PR has source fix commits without an added/changed test";
    if (noTestReason) warnings.push(`${msg}; No test: ${noTestReason}`);
    else errors.push(`${msg}; add a test or include "No test: <reason>" in PR body`);
  }

  const uiSet = new Set<string>();
  for (const c of snapshot.commits) {
    for (const f of c.files) {
      if (f.status === "removed") uiSet.delete(f.filename);
      if (f.previous_filename) uiSet.delete(f.previous_filename);
      if (isUiTest(f)) uiSet.add(f.filename);
    }
  }

  return {
    ok: errors.length === 0,
    repo,
    number,
    head: snapshot.head,
    errors,
    warnings,
    asyncUiTests: [...uiSet].sort(),
  };
}

export async function verifyPrLive(
  repo: string,
  number: number,
  opts: { readonly expectedIdentity?: RepoIdentity; readonly catalyHome?: string; readonly runner?: Runner } = {},
): Promise<VerifyPrResult> {
  const runner = opts.runner ?? defaultRunner;
  const identity = opts.expectedIdentity ?? loadConfig(opts.catalyHome).repoIdentities[repo];
  const prRes = await runner(["gh", "api", `repos/${repo}/pulls/${number}`]);
  if (prRes.code !== 0) {
    return {
      ok: false,
      repo,
      number,
      errors: [`gh api pull failed: ${prRes.err || prRes.out}`],
      warnings: [],
      asyncUiTests: [],
    };
  }
  const prJson = JSON.parse(prRes.out) as { body: string | null; head?: { sha?: string } };
  const filesRes = await runner(["gh", "api", `repos/${repo}/pulls/${number}/files`, "--paginate"]);
  const commitsRes = await runner(["gh", "api", `repos/${repo}/pulls/${number}/commits`, "--paginate"]);
  if (filesRes.code !== 0 || commitsRes.code !== 0) {
    return {
      ok: false,
      repo,
      number,
      errors: [`gh api files/commits failed: ${filesRes.err || commitsRes.err}`],
      warnings: [],
      asyncUiTests: [],
    };
  }
  const files = JSON.parse(filesRes.out) as PrFile[];
  const rawCommits = JSON.parse(commitsRes.out) as Omit<PrCommit, "files">[];
  const commits: PrCommit[] = rawCommits.map((c) => ({ ...c, files }));

  return checkPrSnapshot(
    {
      repo,
      number,
      body: prJson.body ?? null,
      head: prJson.head?.sha ?? "",
      commits,
      files,
    },
    identity,
  );
}

export class PrTracker {
  readonly path: string;

  constructor(readonly stateDir: string) {
    this.path = join(stateDir, "tracked-prs.json");
  }

  list(): TrackedPr[] {
    if (!existsSync(this.path)) return [];
    return JSON.parse(readFileSync(this.path, "utf8")) as TrackedPr[];
  }

  track(repo: string, number: number, lane?: string, thread?: string, now = Date.now()): TrackedPr {
    return withFileLock(`${this.path}.lock`, () => {
      const all = this.list();
      const idx = all.findIndex((p) => p.repo === repo && p.number === number);
      const entry: TrackedPr = {
        repo,
        number,
        ...(lane ? { lane } : {}),
        ...(thread ? { thread } : {}),
        trackedAt: idx >= 0 ? all[idx]!.trackedAt : new Date(now).toISOString(),
        ...(idx >= 0
          ? {
              lastHeadSha: all[idx]!.lastHeadSha,
              lastState: all[idx]!.lastState,
              lastReviewCount: all[idx]!.lastReviewCount,
              lastCommentCount: all[idx]!.lastCommentCount,
            }
          : {}),
      };
      if (idx >= 0) all[idx] = entry;
      else all.push(entry);
      atomicWriteFile(this.path, `${JSON.stringify(all, null, 2)}\n`);
      return entry;
    });
  }

  untrack(repo: string, number: number): boolean {
    return withFileLock(`${this.path}.lock`, () => {
      const all = this.list();
      const next = all.filter((p) => !(p.repo === repo && p.number === number));
      if (next.length === all.length) return false;
      atomicWriteFile(this.path, `${JSON.stringify(next, null, 2)}\n`);
      return true;
    });
  }

  async checkUpdates(runner: Runner = defaultRunner): Promise<{ events: PrWatchEvent[]; errors: string[] }> {
    const tracked = this.list();
    const events: PrWatchEvent[] = [];
    const errors: string[] = [];
    const updatedList: TrackedPr[] = [];
    const CONCURRENCY = 4;
    const fetched: { pr: TrackedPr; res: Awaited<ReturnType<Runner>> }[] = Array.from({ length: tracked.length });
    let idx = 0;

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, tracked.length) }, async () => {
        while (idx < tracked.length) {
          const i = idx++;
          const pr = tracked[i]!;
          const res = await runner([
            "gh",
            "pr",
            "view",
            String(pr.number),
            "--repo",
            pr.repo,
            "--json",
            "state,headRefOid,reviews,comments,statusCheckRollup",
          ]);
          fetched[i] = { pr, res };
        }
      }),
    );

    for (const { pr, res } of fetched) {
      if (res.code !== 0) {
        errors.push(`${pr.repo}#${pr.number}: ${res.err || res.out}`);
        updatedList.push(pr);
        continue;
      }
      const data = JSON.parse(res.out) as {
        state: string;
        headRefOid: string;
        reviews?: { author?: { login?: string }; state?: string }[];
        comments?: unknown[];
        statusCheckRollup?: { name?: string; conclusion?: string; state?: string }[];
      };

      const reviewCount = data.reviews?.length ?? 0;
      const commentCount = data.comments?.length ?? 0;
      const base = {
        repo: pr.repo,
        number: pr.number,
        ...(pr.lane ? { lane: pr.lane } : {}),
        ...(pr.thread ? { thread: pr.thread } : {}),
      };

      if (data.state === "MERGED" && pr.lastState !== "MERGED") {
        events.push({ ...base, kind: "MERGED", detail: `PR merged at ${data.headRefOid.slice(0, 10)}` });
      } else if (data.state === "CLOSED" && pr.lastState !== "CLOSED") {
        events.push({ ...base, kind: "CLOSED", detail: "PR closed without merge" });
      }
      if (pr.lastHeadSha && data.headRefOid && pr.lastHeadSha !== data.headRefOid) {
        events.push({
          ...base,
          kind: "NEW_COMMITS",
          detail: `head moved ${pr.lastHeadSha.slice(0, 8)} -> ${data.headRefOid.slice(0, 8)}`,
        });
      }
      if (pr.lastReviewCount !== undefined && reviewCount > pr.lastReviewCount) {
        events.push({ ...base, kind: "NEW_REVIEWS", detail: `${reviewCount - pr.lastReviewCount} new review(s)` });
      }
      if (pr.lastCommentCount !== undefined && commentCount > pr.lastCommentCount) {
        events.push({ ...base, kind: "NEW_COMMENTS", detail: `${commentCount - pr.lastCommentCount} new comment(s)` });
      }
      const failedChecks = (data.statusCheckRollup ?? []).filter(
        (c) => c.conclusion === "FAILURE" || c.conclusion === "ERROR" || c.state === "FAILURE" || c.state === "ERROR",
      );
      if (failedChecks.length > 0) {
        events.push({
          ...base,
          kind: "CI_FAILED",
          detail: `failing checks: ${failedChecks.map((c) => c.name ?? "unnamed").join(", ")}`,
        });
      }

      if (data.state !== "MERGED" && data.state !== "CLOSED") {
        updatedList.push({
          ...pr,
          lastHeadSha: data.headRefOid,
          lastState: data.state,
          lastReviewCount: reviewCount,
          lastCommentCount: commentCount,
        });
      }
    }

    withFileLock(`${this.path}.lock`, () => {
      atomicWriteFile(this.path, `${JSON.stringify(updatedList, null, 2)}\n`);
    });

    return { events, errors };
  }
}
