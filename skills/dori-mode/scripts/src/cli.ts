#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { releaseVersion } from "../../../../src/release/version.ts";
import type { Command } from "./cli-context.ts";
import { USAGE } from "./cli-usage.ts";
import type { FlowDeps } from "./done-flow.ts";

const [command = "", ...rest] = process.argv.slice(2);
// Command-selected imports keep unrelated graphs out of short-lived CLI processes.
if (command === "harness") process.exit(await (await import("./cli-harness.ts")).runHarness(rest));
if (command === "--version") {
  console.log(releaseVersion);
  process.exit(0);
}
if (command === "update") process.exit(await (await import("../../../../src/release/cli.ts")).runConsumerUpdate(rest));
if (command === "upstream") process.exit(await (await import("../../../../src/update/cli.ts")).runUpdate(rest));

const { die, makeCli } = await import("./cli-context.ts");
const { ConfigError, loadConfig } = await import("./config.ts");
const { Registry } = await import("./registry.ts");
const { realClock, run } = await import("./run.ts");
// Preserve config/native admission before argument parsing or any command execution.
const config = await loadConfig().catch((e: unknown) =>
  e instanceof ConfigError ? die(e.message) : Promise.reject(e),
);
const deps: FlowDeps = { run, clock: realClock, registry: new Registry(config.stateDir), config };
const flags = parseArgs({
  args: rest,
  allowPositionals: true,
  strict: false,
  options: {
    title: { type: "string" },
    brief: { type: "string" },
    done: { type: "string" },
    thread: { type: "string" },
    model: { type: "string" },
    cwd: { type: "string" },
    pane: { type: "string" },
    evidence: { type: "string" },
    reason: { type: "string", multiple: true },
    note: { type: "string" },
    abandon: { type: "boolean" },
    "resume-when": { type: "string" },
    write: { type: "boolean" },
    json: { type: "boolean" },
    repo: { type: "string" },
    loop: { type: "string" },
    gateway: { type: "boolean" },
    context: { type: "boolean" },
    purpose: { type: "string" },
    to: { type: "string" },
    text: { type: "string" },
    status: { type: "boolean" },
    resolve: { type: "string" },
    edit: { type: "string" },
    "text-file": { type: "string" },
    reply: { type: "string" },
    tag: { type: "string", multiple: true },
    archive: { type: "boolean" },
    unarchive: { type: "boolean" },
    message: { type: "string" },
    emoji: { type: "string" },
    remove: { type: "boolean" },
    kind: { type: "string" },
    step: { type: "string" },
    result: { type: "string" },
    "remote-effect": { type: "string", multiple: true },
    "wall-minutes": { type: "string" },
    "token-limit": { type: "string" },
    "cost-limit": { type: "string" },
    "activity-path": { type: "string", multiple: true },
    rule: { type: "string" },
    outcome: { type: "string" },
    lesson: { type: "string" },
    "dry-run": { type: "boolean" },
    global: { type: "boolean" },
    source: { type: "string" },
    open: { type: "boolean" },
    limit: { type: "string" },
    option: { type: "string", multiple: true },
    recommend: { type: "string" },
    lane: { type: "string" },
    worklog: { type: "string" },
    "ignore-author": { type: "string", multiple: true },
    self: { type: "string" },
  },
});
let commands: Readonly<Record<string, Command>> = {};
switch (command) {
  case "report":
  case "lesson":
  case "worklog":
  case "checkpoint":
  case "checkpoints":
    commands = (await import("./cli-journal.ts")).journalCommands;
    break;
  case "launch":
  case "adopt":
  case "claim-done":
  case "object-done":
  case "close":
  case "park":
  case "reopen":
  case "holds":
  case "pause":
  case "resume":
  case "tell":
    commands = (await import("./cli-lanes.ts")).laneCommands;
    break;
  case "status":
  case "board":
  case "eta":
    commands = (await import("./cli-status.ts")).statusCommands;
    break;
  case "sync":
  case "boot":
  case "doctor":
  case "monitor-presets":
  case "verify-pr":
  case "watch":
  case "freshness":
  case "dead-panes":
  case "guard":
  case "heavy":
  case "can-launch":
    commands = (await import("./cli-ops.ts")).opsCommands;
    break;
  case "send":
  case "presence":
  case "inbound":
  case "thread":
  case "react":
  case "channel":
  case "inbound-lag":
  case "transcribe":
    commands = (await import("./cli-messenger.ts")).messengerCommands;
    break;
  case "decision":
    commands = (await import("./cli-decisions.ts")).decisionCommands;
    break;
  case "pr":
    commands = (await import("./cli-pr.ts")).prCommands;
    break;
  case "voice":
    // Keep the opt-in voice graph out of unrelated command startup paths.
    commands = { voice: (await import("./cli-voice.ts")).voiceCommand };
    break;
}
const handler = Object.hasOwn(commands, command) ? commands[command] : undefined;

try {
  if (handler) await handler(makeCli(command, rest, flags, config, deps));
  else {
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
} catch (e) {
  // Import the original classes only on failure; cross-group errors keep their existing identity and formatting.
  const { LaunchError } = await import("./launch.ts");
  const { messengerErrors } = await import("./cli-messenger.ts");
  const { journalErrors } = await import("./cli-journal.ts");
  const { decisionErrors } = await import("./cli-decisions.ts");
  const { prErrors } = await import("./cli-pr.ts");
  const { statusErrors } = await import("./cli-status.ts");
  if (
    e instanceof LaunchError ||
    [...messengerErrors, ...journalErrors, ...decisionErrors, ...prErrors, ...statusErrors].some(
      (type) => e instanceof type,
    )
  )
    die((e as Error).message);
  throw e;
}
