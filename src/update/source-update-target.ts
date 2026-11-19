import { DeploymentHeld } from "./deployment-process.ts";
import { type GitHubReads, MainCiNotReady, verifyMainCi } from "./github-ci.ts";
import type { SourceUpdateConfig } from "./source-update-config.ts";
import type { SourceSnapshot } from "./source-update-git.ts";

export type SourceTarget = {
  commit: string;
  tree: string;
  main: string;
  ahead: number;
  ci: { id: number; attempt: number };
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DeploymentHeld("GitHub object is invalid");
  return value as Record<string, unknown>;
}
function oid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value))
    throw new DeploymentHeld("GitHub commit identity is invalid");
  return value;
}
async function canonical(config: SourceUpdateConfig, reads: GitHubReads) {
  if (object(await reads.api(`repos/${config.repository}`))["full_name"] !== config.repository)
    throw new DeploymentHeld("source repository is not its configured canonical identity");
}
async function mainHead(config: SourceUpdateConfig, reads: GitHubReads) {
  return oid(object(object(await reads.api(`repos/${config.repository}/branches/main`))["commit"])["sha"]);
}
async function commitAt(config: SourceUpdateConfig, reads: GitHubReads, sha: string) {
  const commit = object(await reads.api(`repos/${config.repository}/git/commits/${sha}`));
  if (oid(commit["sha"]) !== sha || !Array.isArray(commit["parents"]))
    throw new DeploymentHeld("source commit response is not bound to its requested identity");
  const parents = commit["parents"].map((parent: unknown) => oid(object(parent)["sha"]));
  return { tree: oid(object(commit["tree"])["sha"]), parent: parents[0] };
}
export async function ancestor(
  config: SourceUpdateConfig,
  reads: GitHubReads,
  base: string,
  head: string,
): Promise<number> {
  if (base === head) return 0;
  const comparison = object(await reads.api(`repos/${config.repository}/compare/${base}...${head}`));
  const ahead = comparison["ahead_by"];
  if (
    comparison["status"] !== "ahead" ||
    object(comparison["base_commit"])["sha"] !== base ||
    object(comparison["merge_base_commit"])["sha"] !== base ||
    typeof ahead !== "number" ||
    !Number.isSafeInteger(ahead) ||
    ahead < 1
  )
    throw new DeploymentHeld("source target is not a forward ancestor-bound main update");
  return ahead;
}

/** First-parent order, not workflow completion time: a late rerun must not select an older source. */
export async function selectSourceTarget(
  config: SourceUpdateConfig,
  current: SourceSnapshot,
  reads: GitHubReads,
): Promise<SourceTarget> {
  await canonical(config, reads);
  const main = await mainHead(config, reads);
  let sha: string | undefined = main;
  const seen = new Set<string>();
  while (sha && seen.size < 40) {
    if (seen.has(sha)) throw new DeploymentHeld("source main history contains a cycle");
    seen.add(sha);
    const commit = await commitAt(config, reads, sha);
    let ci: SourceTarget["ci"];
    try {
      ci = await verifyMainCi(config.repository, sha, reads, config.requiredCi);
    } catch (error) {
      if (!(error instanceof MainCiNotReady)) throw error;
      if (sha === current.commit) break;
      sha = commit.parent;
      continue;
    }
    const ahead = await ancestor(config, reads, current.commit, sha);
    if (sha === current.commit && commit.tree !== current.tree)
      throw new DeploymentHeld("local and remote source trees differ for the same commit");
    if ((await mainHead(config, reads)) !== main) throw new DeploymentHeld("source main changed during CI selection");
    return { commit: sha, tree: commit.tree, main, ahead, ci };
  }
  throw new DeploymentHeld("no passing forward main target in the latest 40 first-parent commits");
}

/** Revoke admission if the chosen immutable target leaves main or its latest CI attempt stops passing. */
export async function verifySourceTarget(config: SourceUpdateConfig, target: SourceTarget, reads: GitHubReads) {
  await canonical(config, reads);
  const commit = await commitAt(config, reads, target.commit);
  if (commit.tree !== target.tree) throw new DeploymentHeld("selected source tree changed");
  const main = await mainHead(config, reads);
  await ancestor(config, reads, target.commit, main);
  const ci = await verifyMainCi(config.repository, target.commit, reads, config.requiredCi);
  if ((await mainHead(config, reads)) !== main) throw new DeploymentHeld("source main changed before admission");
  return ci;
}
