import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { consumerPaths, owned } from "../release/files.ts";
import { hasConsumerState } from "../release/state.ts";
import { command, DeploymentHeld } from "./deployment-process.ts";
import type { GitHubReads } from "./github-ci.ts";
import { sourceManifest } from "./source.ts";
import type { SourceUpdateConfig } from "./source-update-config.ts";

export type SourceSnapshot = { path: string; commit: string; tree: string; sourceHash: string };

function environment(config: SourceUpdateConfig): Record<string, string> {
  return {
    HOME: config.credentialHome,
    PATH: [dirname(config.git), dirname(config.gh), dirname(config.deployment.bun), "/usr/bin", "/bin"].join(":"),
    LANG: "C.UTF-8",
    GH_PROMPT_DISABLED: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

export function sourceGit(config: SourceUpdateConfig, args: string[], cwd: string, signal?: AbortSignal) {
  return command(
    [
      "/bin/sh",
      "-c",
      'umask 077; exec "$@"',
      "dori-source-git",
      config.git,
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      ...args,
    ],
    cwd,
    environment(config),
    120_000,
    signal,
  );
}

export function sourceReads(config: SourceUpdateConfig, signal?: AbortSignal): GitHubReads {
  const query = async (args: string[]) =>
    JSON.parse(
      await command([config.gh, "api", ...args], config.credentialHome, environment(config), 30_000, signal),
    ) as unknown;
  return {
    api: (path) => query([path]),
    pages: async (path, collection) => {
      const pages = await query([path, "--paginate", "--slurp"]);
      if (!Array.isArray(pages)) throw new DeploymentHeld("GitHub pagination is invalid");
      return pages.flatMap((page: unknown) => {
        const rows =
          collection && page !== null && typeof page === "object" && !Array.isArray(page)
            ? (page as Record<string, unknown>)[collection]
            : page;
        if (!Array.isArray(rows)) throw new DeploymentHeld("GitHub page collection is invalid");
        return rows;
      });
    },
  };
}

/** Only an ordinary clean source checkout; never a linked worktree or consumer installation. */
export async function currentSource(config: SourceUpdateConfig, signal?: AbortSignal): Promise<SourceSnapshot> {
  const deployment = config.deployment;
  if (hasConsumerState(consumerPaths(deployment.home, deployment.doriHome)))
    throw new DeploymentHeld("source updates cannot manage a consumer installation");
  const path = realpathSync(deployment.liveSource);
  owned(path);
  const gitDirectory = join(path, ".git");
  const stat = lstatSync(gitDirectory, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    throw new DeploymentHeld("source updates require an ordinary Git checkout, not a linked worktree");
  owned(gitDirectory);
  const git = (args: string[]) => sourceGit(config, args, path, signal);
  const commit = (await git(["rev-parse", "--verify", "HEAD"])).trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new DeploymentHeld("source HEAD is invalid");
  const tree = (await git(["rev-parse", "--verify", `${commit}^{tree}`])).trim();
  if (!/^[a-f0-9]{40}$/.test(tree)) throw new DeploymentHeld("source tree is invalid");
  const sourceHash = sourceManifest(path).hash;
  if ((await git(["status", "--porcelain=v1", "--untracked-files=normal"])).trim())
    throw new DeploymentHeld("source checkout has local changes; preserve them before updating");
  if ((await git(["rev-parse", "--verify", "HEAD"])).trim() !== commit || realpathSync(deployment.liveSource) !== path)
    throw new DeploymentHeld("source identity changed during observation");
  return { path, commit, tree, sourceHash };
}
