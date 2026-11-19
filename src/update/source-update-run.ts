import { join } from "node:path";
import { readPaneState } from "../../skills/dori-mode/scripts/src/lane-state.ts";
import { ownReleaseRoot } from "./deployment-files.ts";
import { forwardStopStarted } from "./deployment-native-ui.ts";
import { acquireRestartLock, DeploymentHeld, sameProcess, underProcess } from "./deployment-process.ts";
import { restartDeployment } from "./deployment-restart.ts";
import { readRestartIntent } from "./deployment-restart-state.ts";
import { deployRelease } from "./deployment-run.ts";
import type { DeploymentRecord, DeploymentStatus } from "./deployment-types.ts";
import { digest } from "./source.ts";
import { sourceCandidate } from "./source-update-candidate.ts";
import type { SourceUpdateConfig } from "./source-update-config.ts";
import { currentSource, sourceReads, type SourceSnapshot } from "./source-update-git.ts";
import { sourceIdle, sourceIdleNow } from "./source-update-idle.ts";
import { readSourceState, saveSourceState, sourceRecoveryPending, type SourceJob } from "./source-update-state.ts";
import { ancestor, selectSourceTarget, verifySourceTarget, type SourceTarget } from "./source-update-target.ts";

export type SourceResult = {
  status: DeploymentStatus | "available" | "unchanged" | "ready" | "recovery-pending";
  current?: SourceSnapshot;
  target?: SourceTarget;
  deployment?: DeploymentRecord;
  quietMs?: number;
  recovery?: "lead-restart";
};
const outcome = (record: DeploymentRecord): SourceResult["status"] =>
  record.status === "held" && (record.nativeUiExitRequestedAt || record.nativeExitObservedAt)
    ? "recovery-pending"
    : record.status;

async function assertRetryAllowed(
  config: SourceUpdateConfig,
  failedCommits: readonly string[] | undefined,
  target: SourceTarget,
  retry?: boolean,
  signal?: AbortSignal,
): Promise<void> {
  if (!failedCommits || target.ahead === 0 || retry) return;
  if (failedCommits.includes(target.commit))
    throw new DeploymentHeld(
      "this source target already rolled back; use --retry-failed explicitly or await a newer passing target",
    );
  for (const failedCommit of failedCommits) {
    try {
      await ancestor(config, sourceReads(config, signal), failedCommit, target.commit);
    } catch (error) {
      throw new DeploymentHeld("await a newer passing target after rollback or use --retry-failed explicitly", {
        cause: error,
      });
    }
  }
}

function outside(config: SourceUpdateConfig, record?: DeploymentRecord): void {
  const pane = readPaneState(config.deployment.stateDir, config.deployment.pane);
  if (pane?.role === "dori" && pane.sessionId === config.deployment.sessionId && underProcess(process.pid, pane.pid))
    throw new DeploymentHeld("source controller must run outside the lead process tree");
  for (const identity of [
    record?.oldRuntime,
    record?.runtime,
    record?.rollbackRuntime,
    record?.launchProcess,
    record?.rollbackProcess,
  ]) {
    if (identity && sameProcess(identity) && underProcess(process.pid, identity.pid))
      throw new DeploymentHeld("source recovery controller must run outside every recorded actor");
  }
}
async function idleAdmission(config: SourceUpdateConfig, record: DeploymentRecord, signal?: AbortSignal) {
  const observed = await sourceIdle(config, signal, record.oldRuntime);
  return () => {
    sourceIdleNow(config, observed.runtime);
  };
}

/** Inspection never owns a release root, takes a lease, prepares a candidate or reads a private session body. */
export async function checkSourceUpdate(config: SourceUpdateConfig, signal?: AbortSignal): Promise<SourceResult> {
  const { job } = readSourceState(config);
  const restart = readRestartIntent(config.deployment);
  if (restart && forwardStopStarted(config.deployment, restart))
    return {
      status: restart.status === "failed" ? "failed" : "recovery-pending",
      deployment: restart,
      recovery: "lead-restart",
    };
  if (job && sourceRecoveryPending(job))
    return {
      status: job.deployment?.status === "failed" ? "failed" : "recovery-pending",
      current: job.current,
      target: job.target,
      ...(job.deployment ? { deployment: job.deployment } : {}),
    };
  const current = await currentSource(config, signal);
  const target = await selectSourceTarget(config, current, sourceReads(config, signal));
  return { status: target.ahead === 0 ? "unchanged" : "available", current, target };
}

export async function applySourceUpdate(
  config: SourceUpdateConfig,
  options: { dryRun?: boolean; retryFailed?: boolean; signal?: AbortSignal } = {},
): Promise<SourceResult> {
  const { signal } = options;
  if (options.dryRun) {
    const result = await checkSourceUpdate(config, signal);
    if (result.status === "recovery-pending" || result.status === "failed") return result;
    await assertRetryAllowed(
      config,
      readSourceState(config).failedCommits,
      result.target!,
      options.retryFailed,
      signal,
    );
    const idle = await sourceIdle(config, signal);
    return { ...result, status: result.status === "available" ? "ready" : result.status, quietMs: idle.quietMs };
  }
  ownReleaseRoot(config.deployment);
  const unlock = acquireRestartLock({ restartLock: join(config.deployment.releaseRoot, "source-update.lock") });
  try {
    const state = readSourceState(config);
    let job = state.job;
    outside(config, job?.deployment);
    const pending = readRestartIntent(config.deployment);
    if (pending && forwardStopStarted(config.deployment, pending)) {
      outside(config, pending);
      const recovered = await restartDeployment(config.deployment, signal, (intent) =>
        idleAdmission(config, intent, signal),
      );
      return { status: outcome(recovered), deployment: recovered, recovery: "lead-restart" };
    }
    if (!job || !sourceRecoveryPending(job)) {
      await sourceIdle(config, signal);
      const current = await currentSource(config, signal);
      const target = await selectSourceTarget(config, current, sourceReads(config, signal));
      if (target.ahead === 0) return { status: "unchanged", current, target };
      await assertRetryAllowed(config, state.failedCommits, target, options.retryFailed, signal);
      const input = await sourceCandidate(config, target, signal);
      job = {
        createdAt: new Date().toISOString(),
        repository: config.repository,
        deploymentConfigHash: digest(JSON.stringify(config.deployment)),
        current,
        target,
        input,
      };
      state.job = job;
      saveSourceState(config, state);
    }
    const selected: SourceJob = job;
    if (selected.deploymentConfigHash !== digest(JSON.stringify(config.deployment)))
      throw new DeploymentHeld("restore the recorded deployment configuration before source recovery");
    const persist = (record: DeploymentRecord) => {
      selected.deployment = record;
      if (record.status === "rolled-back" || record.status === "failed")
        state.failedCommits = [...new Set([...(state.failedCommits ?? []), selected.target.commit])];
      else if (record.status === "healthy" && state.failedCommits) {
        state.failedCommits = state.failedCommits.filter((commit) => commit !== selected.target.commit);
        if (state.failedCommits.length === 0) delete state.failedCommits;
      }
      saveSourceState(config, state);
    };
    // The managed journal wins over a stale outer receipt. Once effects began, no fresh CI/quiet gate can strand recovery.
    const record = await deployRelease(
      config.deployment,
      selected.input,
      selected.deployment,
      persist,
      signal,
      async (intent) => {
        if (selected.repository !== config.repository)
          throw new DeploymentHeld("source repository changed before admission");
        await verifySourceTarget(config, selected.target, sourceReads(config, signal));
        const current = await currentSource(config, signal);
        if (
          current.path !== selected.current.path ||
          current.commit !== selected.current.commit ||
          current.tree !== selected.current.tree ||
          current.sourceHash !== selected.current.sourceHash
        )
          throw new DeploymentHeld("installed source changed during candidate preparation");
        return idleAdmission(config, intent, signal);
      },
    );
    if (selected.deployment !== record) persist(record);
    return { status: outcome(record), current: selected.current, target: selected.target, deployment: record };
  } finally {
    unlock();
  }
}

export async function restartSourceLead(
  config: SourceUpdateConfig,
  options: { dryRun?: boolean; signal?: AbortSignal } = {},
): Promise<SourceResult> {
  if (options.dryRun) {
    const { job } = readSourceState(config);
    if (job && sourceRecoveryPending(job))
      throw new DeploymentHeld("finish source update recovery before a separate lead restart");
    const idle = await sourceIdle(config, options.signal);
    return { status: "ready", quietMs: idle.quietMs };
  }
  ownReleaseRoot(config.deployment);
  const unlock = acquireRestartLock({ restartLock: join(config.deployment.releaseRoot, "source-update.lock") });
  try {
    const { job } = readSourceState(config);
    if (job && sourceRecoveryPending(job))
      throw new DeploymentHeld("finish source update recovery before a separate lead restart");
    outside(config, readRestartIntent(config.deployment));
    const record = await restartDeployment(config.deployment, options.signal, (intent) =>
      idleAdmission(config, intent, options.signal),
    );
    return { status: outcome(record), deployment: record };
  } finally {
    unlock();
  }
}
