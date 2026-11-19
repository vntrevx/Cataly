import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { saveDeploymentJson } from "../src/update/deployment-files.ts";
import { sameProcess } from "../src/update/deployment-process.ts";
import { readSourceState, saveSourceState } from "../src/update/source-update-state.ts";
import { git } from "./update-setup.ts";
import { sourceRolloutFixture } from "./update-source-rollout-setup.ts";

const linux = test.skipIf(process.platform !== "linux");
async function failedNewerTarget() {
  const f = await sourceRolloutFixture();
  writeFileSync(join(f.remote, "src/app.ts"), "export const release = 'failed-newer';\n");
  git(
    f.remote,
    "-c",
    "user.name=Source fixture",
    "-c",
    "user.email=source@example.invalid",
    "commit",
    "-am",
    "Newer target",
  );
  const failed = git(f.remote, "rev-parse", "HEAD");
  const tree = git(f.remote, "rev-parse", "HEAD^{tree}");
  const prefix = `repos/${f.config.repository}`;
  f.responses[`${prefix}/branches/main`] = { commit: { sha: failed } };
  f.responses[`${prefix}/git/commits/${failed}`] = {
    sha: failed,
    tree: { sha: tree },
    parents: [{ sha: f.target.commit }],
  };
  f.responses[`${prefix}/actions/workflows/50/runs?head_sha=${failed}&event=push&per_page=100`] = { workflow_runs: [] };
  f.responses[`${prefix}/compare/${f.target.commit}...${failed}`] = {
    status: "ahead",
    ahead_by: 1,
    base_commit: { sha: f.target.commit },
    merge_base_commit: { sha: f.target.commit },
  };
  f.responses[`${prefix}/compare/${failed}...${f.target.commit}`] = {
    status: "behind",
    ahead_by: 0,
    base_commit: { sha: failed },
    merge_base_commit: { sha: f.target.commit },
  };
  saveDeploymentJson(f.responsesPath, f.responses);
  saveSourceState(f.config, { version: 1, failedCommits: [failed] });
  return { ...f, failed, prefix };
}

for (const dryRun of [true, false])
  linux(
    `an older passing target cannot bypass a newer rollback circuit (${dryRun ? "dry" : "apply"})`,
    async () => {
      const f = await failedNewerTarget();
      try {
        const result = await f.cli("update", "source", "apply", "--when", "idle", ...(dryRun ? ["--dry-run"] : []));
        expect(result.code).toBe(4);
        expect(result.stdout + result.stderr).toContain("newer");
        expect(readSourceState(f.config).failedCommits).toEqual([f.failed]);
        expect(sameProcess(f.runtime)).toBe(true);
        expect(f.readNativeRequests()).toEqual([]);
      } finally {
        f.closeRequests();
      }
    },
    15_000,
  );

linux(
  "explicitly installing an older target does not erase a different failed commit",
  async () => {
    const f = await failedNewerTarget();
    try {
      const result = await f.cli("update", "source", "apply", "--when", "idle", "--retry-failed");
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(JSON.parse(result.stdout).status).toBe("healthy");
      expect(readSourceState(f.config).failedCommits).toEqual([f.failed]);
      const rewrite = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(f.target.commit, f.failed));
      const runs = `${f.prefix}/actions/workflows/50/runs?head_sha=`;
      f.responses[`${runs}${f.failed}&event=push&per_page=100`] = rewrite(
        f.responses[`${runs}${f.target.commit}&event=push&per_page=100`],
      );
      for (const path of [
        `${f.prefix}/actions/runs/70`,
        `${f.prefix}/actions/runs/70/attempts/2/jobs?per_page=100`,
        ...[100, 101, 102].map((id) => `${f.prefix}/check-runs/${id}`),
      ])
        f.responses[path] = rewrite(f.responses[path]);
      saveDeploymentJson(f.responsesPath, f.responses);
      const retried = await f.cli("update", "source", "apply", "--when", "idle", "--dry-run");
      expect(retried.code).toBe(4);
      expect(retried.stdout + retried.stderr).toContain("already rolled back");
    } finally {
      f.closeRequests();
    }
  },
  20_000,
);

linux(
  "an explicitly retried older failure cannot reauthorize the newer failed target",
  async () => {
    const f = await failedNewerTarget();
    try {
      const omp = f.config.deployment.omp!;
      const program = readFileSync(omp, "utf8");
      const marker = "pid: process.pid, startedAt, updatedAt: startedAt, source,";
      expect(program).toContain(marker);
      const prefix = join(f.config.deployment.releaseRoot, "releases", f.target.commit + "-");
      writeFileSync(
        omp,
        program.replace(marker, `${marker}\n  presetLoaded: !source.startsWith(${JSON.stringify(prefix)}),`),
      );
      const failed = await f.cli("update", "source", "apply", "--when", "idle", "--retry-failed");
      expect(failed).toMatchObject({ code: 4, stderr: "" });
      expect(JSON.parse(failed.stdout).status).toBe("rolled-back");
      const rewrite = (value: unknown) => JSON.parse(JSON.stringify(value).replaceAll(f.target.commit, f.failed));
      const runs = `${f.prefix}/actions/workflows/50/runs?head_sha=`;
      f.responses[`${runs}${f.failed}&event=push&per_page=100`] = rewrite(
        f.responses[`${runs}${f.target.commit}&event=push&per_page=100`],
      );
      for (const path of [
        `${f.prefix}/actions/runs/70`,
        `${f.prefix}/actions/runs/70/attempts/2/jobs?per_page=100`,
        ...[100, 101, 102].map((id) => `${f.prefix}/check-runs/${id}`),
      ])
        f.responses[path] = rewrite(f.responses[path]);
      f.responses[`${f.prefix}/compare/${f.current.commit}...${f.failed}`] = {
        status: "ahead",
        ahead_by: 2,
        base_commit: { sha: f.current.commit },
        merge_base_commit: { sha: f.current.commit },
      };
      saveDeploymentJson(f.responsesPath, f.responses);
      const requests = f.readNativeRequests().length;
      const retried = await f.cli("update", "source", "apply", "--when", "idle", "--dry-run");
      expect(retried.code).toBe(4);
      expect(retried.stdout + retried.stderr).toContain("already rolled back");
      expect(readSourceState(f.config).failedCommits).toEqual([f.failed, f.target.commit]);
      expect(f.readNativeRequests()).toHaveLength(requests);
    } finally {
      f.closeRequests();
    }
  },
  20_000,
);
