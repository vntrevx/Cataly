import { validateReleaseManifest } from "../src/release/manifest.ts";
import type { ReleaseManifest } from "../src/release/types.ts";
import { releaseVersion } from "../src/release/version.ts";
import { object } from "../src/update/config.ts";
import { type GitHubReads, verifyMainCi } from "../src/update/github-ci.ts";
import { githubApi, githubPages } from "./release-process.ts";

export const RELEASE_REPOSITORY = "vntrevx/Cataly";

function record(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error("GitHub release gate response is incomplete");
  return value;
}

async function tagCommit(api: GitHubReads["api"], tag: string): Promise<string> {
  const prefix = `repos/${RELEASE_REPOSITORY}`;
  let target = record(record(await api(`${prefix}/git/ref/tags/${tag}`))["object"]);
  const seen = new Set<string>();
  while (target["type"] === "tag") {
    const sha = target["sha"];
    if (typeof sha !== "string" || !/^[a-f0-9]{40}$/.test(sha) || seen.has(sha) || seen.size >= 8) {
      throw new Error("GitHub release tag object is invalid");
    }
    seen.add(sha);
    const annotated = record(await api(`${prefix}/git/tags/${sha}`));
    if (annotated["sha"] !== sha) throw new Error("GitHub annotated tag identity changed");
    target = record(annotated["object"]);
  }
  if (target["type"] !== "commit" || typeof target["sha"] !== "string" || !/^[a-f0-9]{40}$/.test(target["sha"])) {
    throw new Error("GitHub release tag does not resolve to a commit");
  }
  return target["sha"];
}

/** Read-only: successful statuses from another workflow, app, commit or attempt never authorize a release. */
export async function releaseGate(
  value: ReleaseManifest,
  reads: GitHubReads = { api: githubApi, pages: githubPages },
): Promise<void> {
  const manifest = validateReleaseManifest(value);
  if (manifest.releaseVersion !== releaseVersion) {
    throw new Error("Release version differs from the canonical package version");
  }
  const prefix = `repos/${RELEASE_REPOSITORY}`;
  if (
    record(await reads.api(prefix))["full_name"] !== RELEASE_REPOSITORY ||
    (await tagCommit(reads.api, manifest.tag)) !== manifest.commit
  ) {
    throw new Error("Canonical GitHub repository/tag does not identify the release commit");
  }
  const commit = record(await reads.api(`${prefix}/git/commits/${manifest.commit}`));
  if (commit["sha"] !== manifest.commit || record(commit["tree"])["sha"] !== manifest.tree) {
    throw new Error("Canonical GitHub commit/tree differs from the release manifest");
  }
  const main = record(record(await reads.api(`${prefix}/branches/main`))["commit"])["sha"];
  if (typeof main !== "string" || !/^[a-f0-9]{40}$/.test(main))
    throw new Error("Canonical main identity is incomplete");
  const comparison = record(await reads.api(`${prefix}/compare/${manifest.commit}...${main}`));
  if (
    !["ahead", "identical"].includes(String(comparison["status"])) ||
    record(comparison["base_commit"])["sha"] !== manifest.commit ||
    record(comparison["merge_base_commit"])["sha"] !== manifest.commit
  ) {
    throw new Error("Tagged release commit is not an ancestor of canonical main");
  }
  const releases = await reads.pages(`${prefix}/releases?per_page=100`);
  if (!manifest.prerelease && !releases.some((release) => record(release)["draft"] === false)) {
    throw new Error("The first public release must be a prerelease");
  }
  await verifyMainCi(RELEASE_REPOSITORY, manifest.commit, reads);
  if (
    (await tagCommit(reads.api, manifest.tag)) !== manifest.commit ||
    record(record(await reads.api(`${prefix}/branches/main`))["commit"])["sha"] !== main
  ) {
    throw new Error("CI attempt, release tag or canonical main changed during the publication gate");
  }
}
