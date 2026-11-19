import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { owned, realDirectory } from "../release/files.ts";
import { DeploymentHeld } from "./deployment-process.ts";
import type { DeploymentInput } from "./deployment-types.ts";
import { assertSourceAdmission, sourceManifest } from "./source.ts";
import type { SourceUpdateConfig } from "./source-update-config.ts";
import { sourceGit } from "./source-update-git.ts";
import type { SourceTarget } from "./source-update-target.ts";

export async function sourceCandidate(
  config: SourceUpdateConfig,
  target: SourceTarget,
  signal?: AbortSignal,
): Promise<DeploymentInput> {
  const root = config.deployment.releaseRoot;
  const parent = join(root, "source-candidates");
  realDirectory(parent, true);
  owned(parent);
  const candidate = join(parent, target.commit);
  const remote = `https://github.com/${config.repository}.git`;
  if (!existsSync(candidate)) {
    const partial = join(parent, `${target.commit}.partial-${randomUUID()}`);
    mkdirSync(partial, { mode: 0o700 });
    await sourceGit(config, ["init", "--quiet", partial], root, signal);
    await sourceGit(config, ["remote", "add", "origin", remote], partial, signal);
    await sourceGit(config, ["fetch", "--no-tags", "--depth=1", "origin", target.commit], partial, signal);
    await sourceGit(config, ["checkout", "--detach", target.commit], partial, signal);
    if (existsSync(candidate)) throw new DeploymentHeld("source candidate appeared during preparation");
    renameSync(partial, candidate);
  }
  realDirectory(candidate);
  owned(candidate);
  realDirectory(join(candidate, ".git"));
  owned(join(candidate, ".git"));
  const git = (args: string[]) => sourceGit(config, args, candidate, signal);
  if (
    (await git(["rev-parse", "HEAD"])).trim() !== target.commit ||
    (await git(["rev-parse", "HEAD^{tree}"])).trim() !== target.tree ||
    (await git(["status", "--porcelain=v1", "--untracked-files=all"])).trim()
  )
    throw new DeploymentHeld("source candidate differs from its selected clean commit and tree");
  const publicManifest = sourceManifest(candidate);
  assertSourceAdmission(publicManifest, "candidate");
  return {
    remote,
    commit: target.commit,
    tree: target.tree,
    sourceHash: publicManifest.hash,
    candidate,
    publicManifest,
  };
}
