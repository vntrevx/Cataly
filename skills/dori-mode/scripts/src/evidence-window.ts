import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type EvidenceRef, type PathMark, pathMark, UnstableEvidenceError } from "./evidence.ts";
import type { Runner } from "./run.ts";
import type { Observation, SupervisedLane, SupervisionOptions } from "./supervision-observe.ts";

export type FileCoverage = {
  /** A fixed snapshot drains before new candidates are scheduled, so churn cannot starve its tail. */
  readonly pending: readonly string[];
  /** Remember discoveries even when they leave Git status before the next snapshot starts. */
  readonly deferred: readonly string[];
  readonly manifest: string;
  /** Membership changes, new evidence, and failed or raced reads disqualify a cycle from a hung verdict. */
  readonly changed: boolean;
  /** A path's read failure stays reported, once, until a later read of that path succeeds; races are not failures. */
  readonly failed?: Readonly<Record<string, string>>;
};

/** A fixed snapshot drains even when a failed path must be retried in the next cycle. */
const fileWindow = (paths: ReadonlySet<string>, previous: readonly string[], coverage?: FileCoverage): FileCoverage => {
  const ordered = [...paths].sort();
  const manifest = createHash("sha256").update(JSON.stringify(ordered)).digest("hex");
  const cycle = coverage?.pending.length
    ? coverage
    : {
        pending: [...new Set([...ordered, ...previous, ...(coverage?.deferred ?? [])])].sort(),
        deferred: [],
        manifest,
        changed: false,
      };
  const known = new Set([...previous, ...cycle.pending, ...cycle.deferred]);
  return {
    pending: cycle.pending,
    deferred: [...cycle.deferred, ...ordered.filter((path) => !known.has(path))],
    manifest: cycle.manifest,
    changed: cycle.changed || manifest !== cycle.manifest,
    ...(coverage?.failed === undefined ? {} : { failed: coverage.failed }),
  };
};

// Only classify an exit-128 status as non-repository when no Git entry exists in its physical ancestry.
// Permission failures, corrupt Git entries, timeouts and explicit Git environment overrides remain unknown.
const hasGitEntry = (cwd: string): boolean => {
  if (process.env["GIT_DIR"] || process.env["GIT_WORK_TREE"]) return true;
  let path = realpathSync(cwd);
  for (;;) {
    try {
      lstatSync(join(path, ".git"));
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    const parent = dirname(path);
    if (parent === path) return false;
    path = parent;
  }
};

export const observeFiles = async (
  run: Runner,
  options: SupervisionOptions,
  stateDir: string,
  lane: SupervisedLane,
  previous: Pick<Observation, "files" | "coverage"> | null,
  persist: (coverage: FileCoverage) => void,
): Promise<{
  files: Readonly<Record<string, PathMark>>;
  observed: readonly EvidenceRef[];
  coverage?: FileCoverage;
  evidenceError?: string;
}> => {
  let files = previous?.files ?? {};
  let coverage = previous?.coverage;
  let observed: EvidenceRef[] = [];
  let evidenceError: string | undefined;
  try {
    // Never admit the journals and supervision state that the observer writes itself.
    const state = resolve(realpathSync(stateDir), "lanes");
    const ownState = (path: string) => path === state || path.startsWith(`${state}/`);
    const paths = new Set(
      [...(options.activityPaths ?? []), ...(lane.activityPaths ?? [])]
        .map((path) => resolve(lane.cwd ?? ".", path))
        .filter((path) => !ownState(path)),
    );
    if (options.gitActivity !== false && lane.cwd) {
      const result = await run(["git", "-C", lane.cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
        timeoutMs: 10_000,
        preserveOutput: true,
      });
      if (result.code !== 0 && !(result.code === 128 && !hasGitEntry(lane.cwd)))
        throw new Error(`Git evidence observation failed (exit ${result.code}): ${result.err.trim()}`);
      const entries = result.code === 0 ? result.out.split("\0").filter(Boolean) : [];
      const cwd = entries.length ? realpathSync(lane.cwd) : lane.cwd;
      let root = cwd;
      if (entries.length) {
        const repository = await run(["git", "-C", lane.cwd, "rev-parse", "--show-toplevel"], {
          timeoutMs: 10_000,
          preserveOutput: true,
        });
        root = repository.out.replace(/\n$/, "");
        if (repository.code !== 0 || !isAbsolute(root))
          throw new Error(`Git root observation failed (exit ${repository.code}): ${repository.err.trim()}`);
      }
      for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        const path = resolve(root, entry.slice(3));
        const rel = relative(cwd, path);
        if (
          !isAbsolute(rel) &&
          rel !== ".." &&
          !rel.startsWith("../") &&
          !rel.split("/").includes("node_modules") &&
          !ownState(path)
        )
          paths.add(path);
        if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") index++;
      }
    }
    coverage = fileWindow(paths, Object.keys(files), coverage);
    persist(coverage);
    const marks = { ...files };
    const captured: EvidenceRef[] = [];
    const failed: Record<string, string> = { ...coverage.failed };
    for (const path of coverage.pending.slice(0, 256)) {
      try {
        const mark = pathMark(path, files[path]);
        const [, fingerprint, canonical] = mark;
        if (paths.has(path)) marks[path] = mark;
        else delete marks[path];
        if (fingerprint !== "special" && !ownState(canonical ?? path))
          captured.push({ kind: "file", ref: canonical ?? path, fingerprint });
        delete failed[path];
      } catch (error) {
        // A read that raced a change keeps the trusted mark and any earlier failure, and is retried next cycle.
        if (!(error instanceof UnstableEvidenceError))
          failed[path] = error instanceof Error ? error.message : String(error);
        coverage = { ...coverage, changed: true, deferred: [...new Set([...coverage.deferred, path])] };
      }
    }
    observed = captured;
    files = marks;
    coverage = {
      pending: coverage.pending.slice(256),
      deferred: coverage.deferred,
      manifest: coverage.manifest,
      changed: coverage.changed,
      ...(Object.keys(failed).length ? { failed } : {}),
    };
  } catch (error) {
    evidenceError = error instanceof Error ? error.message : String(error);
    if (coverage !== undefined) coverage = { ...coverage, changed: true };
  }
  // A failing path stays one stable report, not a new one each cycle, until a read of it succeeds; a whole-observation
  // failure of this sweep is reported first.
  const failing = Object.entries(coverage?.failed ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const [first] = failing;
  if (evidenceError === undefined && first)
    evidenceError = `${first[1]}${failing.length > 1 ? ` (and ${failing.length - 1} more failing paths)` : ""}`;
  return {
    files,
    observed,
    ...(coverage === undefined ? {} : { coverage }),
    ...(evidenceError === undefined ? {} : { evidenceError }),
  };
};
