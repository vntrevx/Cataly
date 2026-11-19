import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { type EvidenceRef, markHolds, type PathMark, pathMark, racyMark, UnstableEvidenceError } from "./evidence.ts";
import type { Runner } from "./run.ts";
import type { SupervisedLane, SupervisionOptions } from "./supervision-observe.ts";

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
type Marks = Readonly<Record<string, PathMark>>;
/** One sweep's candidates from Git and activityPaths, and which paths are the observer's own state. */
type Candidates = { readonly paths: ReadonlySet<string>; readonly ownState: (path: string) => boolean };
export type Discovery = Candidates | { readonly error: string };
/** What one window read found: the marks it trusts, the file evidence it saw, its schedule and its uncertainty. */
export type WindowRead = {
  readonly files: Marks;
  readonly observed: readonly EvidenceRef[];
  readonly coverage?: FileCoverage;
  readonly evidenceError?: string;
};

/** A fixed snapshot drains even when a failed path must be retried in the next cycle. */
export const fileWindow = (
  paths: ReadonlySet<string>,
  previous: readonly string[],
  coverage?: FileCoverage,
): FileCoverage => {
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

/**
 * Before a new hung verdict only: re-stat every known candidate, including this sweep's window. A racy mark, changed
 * stat or failed lstat leaves the verdict unknown. These sequential lstats are not an atomic filesystem snapshot;
 * they neither replace marks nor move the schedule. Only a later content read may credit changed bytes as evidence.
 */
export const confirmMarks = (
  files: Readonly<Record<string, PathMark>>,
  observedAt = Date.now(),
): { readonly quiet: boolean; readonly stats: number } => {
  const marks = Object.entries(files);
  if (marks.some(([, mark]) => racyMark(mark))) return { quiet: false, stats: 0 };
  let stats = 0;
  for (const [path, mark] of marks) {
    stats++;
    if (!markHolds(path, mark, observedAt)) return { quiet: false, stats };
  }
  return { quiet: true, stats };
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

/** Lists the candidates. Git is external I/O: call this before taking the delivery lock, never under it. */
export const discoverFiles = async (
  run: Runner,
  options: SupervisionOptions,
  stateDir: string,
  lane: SupervisedLane,
): Promise<Discovery> => {
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
    return { paths, ownState };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

// A failing path stays one stable report, not a new one each cycle, until a read of it succeeds; a whole-observation
// failure of this sweep is reported first.
const reported = (read: WindowRead, failure?: string): WindowRead => {
  const failing = Object.entries(read.coverage?.failed ?? {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const [first] = failing;
  const evidenceError =
    failure ?? (first && `${first[1]}${failing.length > 1 ? ` (and ${failing.length - 1} more failing paths)` : ""}`);
  return evidenceError === undefined ? read : { ...read, evidenceError };
};

/** A failed discovery reads nothing: the trusted marks and the schedule stay, and the cycle is disqualified. */
export const missedWindow = (files: Marks, coverage: FileCoverage | undefined, failure: string): WindowRead => {
  const kept = coverage === undefined ? {} : { coverage: { ...coverage, changed: true } };
  return reported({ files, observed: [], ...kept }, failure);
};

/**
 * Reads at most 256 candidates of the prepared window: their stats, and the bytes of any not settled unchanged. Run it
 * outside the delivery lock, after the plan is durable; only a commit in the same generation records what it found.
 */
export const readWindow = ({ paths, ownState }: Candidates, files: Marks, planned: FileCoverage): WindowRead => {
  let coverage = planned;
  const marks = { ...files };
  const observed: EvidenceRef[] = [];
  const failed: Record<string, string> = { ...coverage.failed };
  for (const path of coverage.pending.slice(0, 256)) {
    try {
      const mark = pathMark(path, files[path]);
      const [, fingerprint, canonical] = mark;
      if (paths.has(path)) marks[path] = mark;
      else delete marks[path];
      if (fingerprint !== "special" && !ownState(canonical ?? path))
        observed.push({ kind: "file", ref: canonical ?? path, fingerprint });
      delete failed[path];
    } catch (error) {
      // A read that raced a change keeps the trusted mark and any earlier failure, and is retried next cycle.
      if (!(error instanceof UnstableEvidenceError))
        failed[path] = error instanceof Error ? error.message : String(error);
      coverage = { ...coverage, changed: true, deferred: [...new Set([...coverage.deferred, path])] };
    }
  }
  return reported({
    files: marks,
    observed,
    coverage: {
      pending: coverage.pending.slice(256),
      deferred: coverage.deferred,
      manifest: coverage.manifest,
      changed: coverage.changed,
      ...(Object.keys(failed).length ? { failed } : {}),
    },
  });
};
