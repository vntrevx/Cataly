#!/usr/bin/env node
import { existsSync } from "node:fs";
import { collectBootSummary, formatBootMarkdown } from "./core/boot.js";
import { resolveCatalyHome, resolveStateDir } from "./core/config.js";
import { LaneRegistry } from "./core/lanes.js";

type HookInput = {
  conversationId?: string;
  hookEventName?: string;
  continuationActive?: boolean;
  terminationReason?: string;
  fullyIdle?: boolean;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  const raw = await readStdin();
  if (!raw) {
    process.stdout.write("{}\n");
    return;
  }

  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch {
    process.stdout.write("{}\n");
    return;
  }

  const catalyHome = resolveCatalyHome();
  const stateDir = resolveStateDir(catalyHome);
  const event = input.hookEventName;

  if (event === "SessionStart") {
    // Fast-path exit when no state directory has been created yet
    if (!existsSync(stateDir)) {
      process.stdout.write("{}\n");
      return;
    }

    const summary = collectBootSummary(catalyHome);
    const hasActiveState =
      summary.openWorklog.length > 0 ||
      summary.openDecisions.length > 0 ||
      summary.activeLanes.length > 0 ||
      summary.pendingDiscordObligations.length > 0 ||
      summary.trackedPrCount > 0;

    if (!hasActiveState) {
      process.stdout.write("{}\n");
      return;
    }

    const msg = [
      formatBootMarkdown(summary),
      "",
      "Cataly active state was detected on session start. Consult these open items before starting overlapping work, or call `cataly_boot` for full details.",
    ].join("\n");

    process.stdout.write(
      `${JSON.stringify({
        injectSteps: [
          {
            systemMessage: {
              systemMessage: msg,
            },
          },
        ],
      })}\n`,
    );
    return;
  }

  if (event === "Stop") {
    if (
      input.continuationActive ||
      input.terminationReason !== "NO_TOOL_CALL" ||
      !input.conversationId ||
      !existsSync(stateDir)
    ) {
      process.stdout.write("{}\n");
      return;
    }

    const registry = new LaneRegistry(stateDir, catalyHome);
    const ownLanes = registry
      .list(false)
      .filter((l) => l.conversationId === input.conversationId && l.status === "working");

    if (ownLanes.length > 0) {
      const keys = ownLanes.map((l) => l.key).join(", ");
      process.stdout.write(
        `${JSON.stringify({
          decision: "continue",
          reason: `Cataly lane(s) [${keys}] bound to this conversation are still in 'working' status. Either verify all Done = signals and call cataly_lane_claim_done, record a blocker/question via cataly_report_add, or pause the lane before stopping.`,
        })}\n`,
      );
      return;
    }

    process.stdout.write("{}\n");
    return;
  }

  process.stdout.write("{}\n");
}

main().catch(() => {
  process.stdout.write("{}\n");
});
