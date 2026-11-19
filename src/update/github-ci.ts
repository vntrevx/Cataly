import { object } from "./config.ts";

export const MAIN_CI_CHECKS = ["check", "e2e-herdr", "e2e-hc"] as const;
export type GitHubReads = {
  api: (path: string) => Promise<unknown>;
  pages: (path: string, collection?: string) => Promise<unknown[]>;
};
export class MainCiNotReady extends Error {}

function record(value: unknown): Record<string, unknown> {
  if (!object(value)) throw new Error("GitHub release gate response is incomplete");
  return value;
}
function identifier(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("GitHub release gate identity is incomplete");
  }
  return value;
}
function trustedRun(value: unknown, repository: string, commit: string, workflow: number): Record<string, unknown> {
  const run = record(value);
  if (
    run["head_sha"] !== commit ||
    run["workflow_id"] !== workflow ||
    run["path"] !== ".github/workflows/ci.yml" ||
    run["event"] !== "push" ||
    run["head_branch"] !== "main" ||
    record(run["head_repository"])["full_name"] !== repository
  )
    throw new Error("CI is not the own main ci.yml run for the exact commit");
  identifier(run["id"]);
  identifier(run["run_attempt"]);
  identifier(run["check_suite_id"]);
  return run;
}

/** The latest own main attempt must pass every required job with its Actions app and suite binding. */
export async function verifyMainCi(
  repository: string,
  commit: string,
  reads: GitHubReads,
  required: readonly string[] = MAIN_CI_CHECKS,
): Promise<{ id: number; attempt: number }> {
  const prefix = `repos/${repository}`;
  const workflow = record(await reads.api(`${prefix}/actions/workflows/ci.yml`));
  const workflowId = identifier(workflow["id"]);
  if (workflow["path"] !== ".github/workflows/ci.yml" || workflow["state"] !== "active") {
    throw new Error("Own CI workflow is unavailable");
  }
  const candidates = (
    await reads.pages(
      `${prefix}/actions/workflows/${workflowId}/runs?head_sha=${commit}&event=push&per_page=100`,
      "workflow_runs",
    )
  ).map((run) => trustedRun(run, repository, commit, workflowId));
  candidates.sort((a, b) => Number(b["id"]) - Number(a["id"]));
  if (!candidates.length) throw new MainCiNotReady("No exact-commit main CI run exists; tag pushes do not run ci.yml");
  const run = trustedRun(
    await reads.api(`${prefix}/actions/runs/${candidates[0]!["id"]}`),
    repository,
    commit,
    workflowId,
  );
  const id = identifier(run["id"]);
  const attempt = identifier(run["run_attempt"]);
  if (id !== candidates[0]!["id"]) throw new Error("Latest exact-commit own CI run identity differs");
  if (run["status"] !== "completed" || run["conclusion"] !== "success") {
    throw new MainCiNotReady("Latest exact-commit own CI run has not succeeded");
  }
  const jobs = (await reads.pages(`${prefix}/actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`, "jobs")).map(
    record,
  );
  const checkPrefix = `https://api.github.com/repos/${repository}/check-runs/`;
  const requiredChecks = required.map((name) => {
    const matches = jobs.filter((job) => job["name"] === name);
    if (matches.length !== 1) throw new MainCiNotReady(`Required exact-commit CI job is missing or ambiguous: ${name}`);
    const job = matches[0]!;
    const url = job["check_run_url"];
    const suffix = typeof url === "string" && url.startsWith(checkPrefix) ? url.slice(checkPrefix.length) : "";
    if (
      job["head_sha"] !== commit ||
      job["run_id"] !== id ||
      job["run_attempt"] !== attempt ||
      !/^[1-9]\d*$/.test(suffix)
    )
      throw new Error(`Required CI job did not succeed for the exact attempt: ${name}`);
    if (job["status"] !== "completed" || job["conclusion"] !== "success")
      throw new MainCiNotReady(`Required CI job did not succeed for the exact attempt: ${name}`);
    return { name, checkId: identifier(Number(suffix)) };
  });
  // Drain only these independent GETs before validating in required-job order.
  const results = await Promise.allSettled(
    requiredChecks.map(({ checkId }) => reads.api(`${prefix}/check-runs/${checkId}`)),
  );
  for (const [index, { name, checkId }] of requiredChecks.entries()) {
    const result = results[index]!;
    if (result.status === "rejected") throw result.reason;
    const check = record(result.value);
    if (
      check["id"] !== checkId ||
      check["head_sha"] !== commit ||
      check["name"] !== name ||
      check["status"] !== "completed" ||
      check["conclusion"] !== "success" ||
      record(check["app"])["id"] !== 15368 ||
      record(check["check_suite"])["id"] !== run["check_suite_id"]
    )
      throw new Error(`Required CI check lacks trusted GitHub Actions app15368/workflow binding: ${name}`);
  }
  const final = trustedRun(await reads.api(`${prefix}/actions/runs/${id}`), repository, commit, workflowId);
  if (final["id"] !== id) throw new Error("CI run identity changed during the main gate");
  if (final["run_attempt"] !== attempt || final["status"] !== "completed" || final["conclusion"] !== "success")
    throw new MainCiNotReady("CI attempt changed during the main gate");
  return { id, attempt };
}
