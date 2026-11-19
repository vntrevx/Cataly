import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DeploymentHeld } from "./deployment-process.ts";
import { MainCiNotReady } from "./github-ci.ts";
import { loadSourceUpdateConfig, sourceRequiredCi } from "./source-update-config.ts";

const USAGE = `Usage: dori update source <check|status|apply> [--config FILE]
  apply --when idle [--owner-quiet 30m] [--require-ci check,e2e-herdr,e2e-hc] [--dry-run] [--retry-failed]
  dori idle-check [--owner-quiet 30m] [--config FILE]
  dori lead restart --when idle [--owner-quiet 30m] [--dry-run] [--config FILE]
Source mode follows CI-passing main, not consumer releases or model-porting upstream.
Apply/restart must run outside the lead. They preserve its session and use managed health checks and rollback.
Configuration is opt-in: DORI_HOME/source-update.json (default ~/.dori/source-update.json).
--retry-failed retries a previously verified rollback once; the supervisor never adds it.
Exit 4 is held/rolled back, 6 is durable recovery pending, 2 needs operator review. Nothing enables a service.`;

export async function runSourceUpdate(argv: string[]): Promise<number> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const args = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: "string" },
        when: { type: "string" },
        "owner-quiet": { type: "string" },
        "require-ci": { type: "string" },
        "dry-run": { type: "boolean" },
        "retry-failed": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
    if (args.values.help || args.positionals.length === 0) {
      console.log(USAGE);
      return 0;
    }
    let operation = args.positionals[0];
    if (operation === "lead") {
      if (args.positionals.length !== 2 || args.positionals[1] !== "restart") throw new Error(USAGE);
      operation = "restart";
    } else if (
      args.positionals.length !== 1 ||
      !operation ||
      !["check", "status", "apply", "idle-check"].includes(operation)
    )
      throw new Error(USAGE);
    const changing = operation === "apply" || operation === "restart";
    if (changing && args.values.when !== "idle") throw new Error("source apply and lead restart require --when idle");
    if (!changing && (args.values.when !== undefined || args.values["dry-run"] || args.values["retry-failed"]))
      throw new Error("--when and --dry-run apply only to apply/restart; --retry-failed applies only to source apply");
    if (operation !== "apply" && args.values["retry-failed"])
      throw new Error("--retry-failed applies only to source apply");
    if (!["check", "apply"].includes(operation) && args.values["require-ci"] !== undefined)
      throw new Error("--require-ci applies only to source check/apply");
    if (operation === "status" && args.values["owner-quiet"] !== undefined)
      throw new Error("status does not change quiet policy");
    const doriHome = process.env["DORI_HOME"] ?? join(homedir(), ".dori");
    if (args.values.config === undefined && !isAbsolute(doriHome)) throw new Error("DORI_HOME must be absolute");
    if (args.values.config !== undefined && !args.values.config.trim()) throw new Error("--config requires a file");
    const config = loadSourceUpdateConfig(resolve(args.values.config ?? join(doriHome, "source-update.json")));
    const quiet = args.values["owner-quiet"];
    if (quiet !== undefined) {
      const match = /^([1-9]\d*)(m|h)$/.exec(quiet);
      const milliseconds = match ? Number(match[1]) * (match[2] === "h" ? 3_600_000 : 60_000) : NaN;
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_800_000)
        throw new Error("--owner-quiet must be at least 30m, in whole minutes or hours");
      config.ownerQuietMs = milliseconds;
    }
    if (args.values["require-ci"] !== undefined)
      config.requiredCi = sourceRequiredCi(args.values["require-ci"].split(",").map((name) => name.trim()));
    if (operation === "status") {
      const { readSourceState, sourceRecoveryPending } = await import("./source-update-state.ts");
      const state = readSourceState(config);
      const job = state.job;
      console.log(
        JSON.stringify({
          mode: "source",
          operation,
          lastAttempt: job
            ? {
                createdAt: job.createdAt,
                commit: job.target.commit,
                ci: job.target.ci,
                status: job.deployment?.status ?? "prepared",
                step: job.deployment?.step,
                recoveryPending: sourceRecoveryPending(job),
                error: job.deployment?.error,
                rollbackError: job.deployment?.rollbackError,
              }
            : null,
          failedCommits: state.failedCommits,
        }),
      );
      return 0;
    }
    if (operation === "idle-check") {
      const { sourceIdle } = await import("./source-update-idle.ts");
      const idle = await sourceIdle(config, abort.signal);
      console.log(
        JSON.stringify({ mode: "source", operation, status: "idle", quietMs: idle.quietMs, receivers: idle.receivers }),
      );
      return 0;
    }
    const { checkSourceUpdate, applySourceUpdate, restartSourceLead } = await import("./source-update-run.ts");
    const options = {
      dryRun: args.values["dry-run"] === true,
      retryFailed: args.values["retry-failed"] === true,
      signal: abort.signal,
    };
    const result =
      operation === "check"
        ? await checkSourceUpdate(config, abort.signal)
        : operation === "restart"
          ? await restartSourceLead(config, options)
          : await applySourceUpdate(config, options);
    console.log(
      JSON.stringify({
        mode: "source",
        operation,
        status: result.status,
        dryRun: options.dryRun,
        commit: result.target?.commit ?? result.deployment?.commit,
        current: result.current?.commit,
        ci: result.target?.ci,
        step: result.deployment?.step,
        sessionId: result.deployment?.runtime?.sessionId,
        quietMs: result.quietMs,
        recovery: result.recovery,
        error: result.deployment?.error,
        rollbackError: result.deployment?.rollbackError,
      }),
    );
    if (abort.signal.aborted) return 130;
    if (result.status === "failed") return 2;
    if (result.status === "held" || result.status === "rolled-back") return 4;
    return ["healthy", "available", "unchanged", "ready"].includes(result.status) ? 0 : 6;
  } catch (error) {
    if (abort.signal.aborted) {
      console.error("SOURCE_UPDATE_INTERRUPTED");
      return 130;
    }
    const held = error instanceof DeploymentHeld || error instanceof MainCiNotReady;
    console.error(
      `${held ? "SOURCE_UPDATE_HELD" : "SOURCE_UPDATE_ERROR"} ${error instanceof Error ? error.message : "unknown failure"}`,
    );
    return held ? 4 : 2;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
