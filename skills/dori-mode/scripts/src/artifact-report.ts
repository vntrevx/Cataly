import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { artifactWithin } from "./artifact-files.ts";
import type { Artifact } from "./artifact-records.ts";
import type { Artifacts } from "./artifacts.ts";
import { Checkpoints } from "./checkpoints.ts";

/** No local path, private title or historical URL is copied into a final message. */
export const artifactNote = async (
  artifacts: Artifacts,
  key: string,
  entries = artifacts.read(key),
): Promise<string> => {
  if (!entries.length) return "";
  const publicEntries = entries.filter((entry) => entry.versions.at(-1)?.visibility === "public");
  const views = await artifacts.views(key, publicEntries);
  const checkpoints = views.some((entry) => entry.state === "current")
    ? new Checkpoints(artifacts.config.stateDir).read(key)
    : [];
  const lines: string[] = [];
  const privateCount = entries.length - publicEntries.length;
  for (const entry of views) {
    const last = entry.versions.at(-1);
    if (!last) throw new Error("registered artifact has no version");
    if (entry.state !== "current" || !entry.current?.url) {
      lines.push(`Artifact ${entry.id}: ${entry.state}; public link withheld. Run dori artifacts ${key}.`);
      continue;
    }
    const hash = entry.current.sha256;
    const delivered = entry.receipts.filter((receipt) => receipt.sha256 === hash).length;
    const evidence = `artifact:${entry.id}@sha256:${hash}`;
    const verified = checkpoints.filter((checkpoint) => checkpoint.evidence.includes(evidence)).length;
    lines.push(
      `Artifact ${entry.id}: ${JSON.stringify(last.title)}\n${entry.current.url}\nsha256=${hash} registered=${last.at} checkpoints=${verified} delivery=${delivered ? "operator-reported" : "not-recorded"}; HTTP=not-checked; viewed=unknown`,
    );
  }
  if (privateCount) lines.push(`Private artifacts omitted: ${privateCount}.`);
  return lines.join("\n");
};

/** Close has already committed: a later registration is refused, and an in-flight writer keeps every worktree. */
export const artifactClose = async (
  artifacts: Artifacts,
  key: string,
  now: number,
): Promise<{ note: string; entries: readonly Artifact[] | null }> => {
  const path = artifacts.path(key);
  let release: (() => void) | undefined;
  try {
    if (!existsSync(`${path}.lock`) && !artifacts.read(key).length) return { note: "", entries: [] };
    release = artifacts.lock(key, now);
    const entries = artifacts.read(key);
    return { note: await artifactNote(artifacts, key, entries), entries };
  } catch {
    return {
      note: `Artifacts unavailable or writer active; worktrees kept. Run dori artifacts ${key}.`,
      entries: null,
    };
  } finally {
    release?.();
  }
};

/** Keep both lexical aliases and canonical targets, including older delivered versions and private artifacts. */
export const artifactKeepsWorktree = (entries: readonly Artifact[] | null, worktree: string): boolean => {
  if (entries === null) return true;
  if (!entries.length) return false;
  const root = resolve(worktree);
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return true;
  }
  return entries.some((entry) =>
    [entry.path, ...entry.versions.map((version) => version.realPath)].some(
      (path) => artifactWithin(root, path) || artifactWithin(realRoot, path),
    ),
  );
};
