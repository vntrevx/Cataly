#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { releaseVersion } from "../../../../src/release/version.ts";
import type { Command } from "./cli-context.ts";
import type { FlowDeps } from "./done-flow.ts";
const USAGE = `dori <command> [options]

  harness <command> [args...]          dispatch every upstream harness command (up, inbox, duty, review, merge, loop, backlog, migrate...)
  update <command> [options]           verified releases: check, install, status, rollback, cache [--version TAG] [--from DIST]
  upstream <command> --config FILE     maintainer staging: check, stage, watch, status, snapshot, restore, recover, restart
  launch <key> --title T --brief FILE --done "merged o/r#N; closed o/r#M" [--thread REF] [--model M] [--cwd DIR]
         [--wall-minutes N|none] [--token-limit N|none] [--cost-limit N|none] [--activity-path FILE ...] [--dry-run]
  adopt  <key> --pane ID --title T --brief FILE --done "..." [--thread REF]
  status [<key>] [--json]              read-only lane, runtime, journal, decision and monitor observations
  board discord|telegram [--to ID] [--thread ID] [--lane KEY] [--loop MIN] [--message ID]
                                       opt-in single status message; reuse its ID, edit only changed content
  eta <prefix> [--json]                historical closed-lane elapsed time (at least 3 samples)
  sync   [--write]                     registry vs live panes; read-only unless --write
  boot                                 read-only check after a restart: Slack auth, vanished panes, journals, open worklog items and decisions, stale watches
  doctor [--json] [--repo owner/repo]   read-only configuration, adoption and monitor diagnostics; exit 1 on warnings
  monitor-presets [name] [--json]      recommended argv and filters; starts nothing
  report <key> --kind milestone|blocker|question|halted|done --text TEXT
                                       append a durable progress report and print its [REPORT] line
  checkpoint <key> --step ID --result TEXT --evidence PATH [--remote-effect RECEIPT]...
                                       record a completed step once; a conflicting rewrite is refused
  checkpoints <key>                    read completed steps before resuming remote work
  verify-pr <owner/repo> <num> [--loop N] [--cwd DIR]
                                       check every commit's author/committer email and PR-level tests; print the UI test loop (not run)
  pr track <owner/repo#N|pull-url> [--lane K] [--thread REF] / pr untrack <ref> / pr list
  pr watch [--loop MIN] [--ignore-author LOGIN]... [--self LOGIN]
                                       follow tracked PRs after their lane: PR_FEEDBACK, PR_CI_FAIL, PR_HEAD_MOVED, PR_MERGED
  claim-done [<key>] --evidence TEXT  key defaults to the lane registered for your own session (HC_TERMINAL_ID or HERDR_PANE_ID)
  object-done <key> --reason TEXT [--reason TEXT ...]
  lesson add <key> --rule TEXT --evidence PATH [--cwd DIR]
  lesson add --global --rule TEXT --evidence REF
                                       the lead's lesson for every lane, whatever its repo
  lesson list [--cwd DIR]             show current lessons (global ones included), newest first
  lesson mark <id> --outcome pending|helped|no-effect|harmful|encoded
  worklog add <title> --source REF     record an owner request when it arrives
  worklog next|note <id> <text>        set the item's next step, or add a note (a decision, an owner)
  worklog close <id> --result TEXT     close the item with what came of it
  worklog list [--open]                items as JSON; <stateDir>/worklog.md holds the same for reading
  decision ask <question> --source REF [--lane K] [--thread REF] [--option TEXT]... [--recommend N] [--worklog ID] [--message REF]
                                       record a choice put to the owner (up to 9 numbered options)
  decision posted <id> --message REF   record where the question was posted; a reply to that message answers it
  decision answer <id> <answer> --source REF
                                       record the owner's answer: a bare number picks that option, other text stays free text
  decision withdraw <id> --reason TEXT no longer needed
  decision match <message-ref>         print the open decision posted as that message; exit 1 when there is none
  decision list [--open]               decisions as JSON, oldest first
  decision digest                      one line per open decision, to paste into a status message
  close  <key> [--note TEXT] [--lesson TEXT] [--evidence PATH]
                                       close now (Done signals must read back live); an optional lesson never blocks it
  pause  <key> [--note TEXT]           the owner said wait: goal paused (read back), running turn stopped, no nudges; exit 3 if unconfirmed
  resume <key> [--note TEXT]           undo pause: goal resumed (read back), lane back to its earlier status
  tell   <key> --text TEXT             TOLD (exit 0), TELL_UNCONFIRMED (exit 3, never resend; later messages held),
                                       TELL_FAILED or TELL_HELD (exit 2, this message not sent)
  tell   <key> --status                inspect the latest local dispatch, including its exact request ID
  tell   <key> --resolve ID --note WHY  release only that uncertain hold; never confirm, cancel, or replay its action
  watch                                long-running: emits LANE_* lines every 30 s
  freshness [--loop MIN]               nudge silent lanes, post their last report via hooks.threadReply
  dead-panes [--loop MIN]              print DEAD_PANE <id> for stopped agent panes
  guard [--loop MIN]                   host load, memory, disk and pane-count alerts
  heavy <label> -- <command ...>       run a heavy command when a slot is free and load is low
  can-launch                           exit 0 if the host has room for a new lane, else print why and exit 4
  send <slack|telegram|discord> --to TARGET (--text TEXT | --text-file PATH|-) [--thread ID] [--edit ID] [--reply ID]
                                       Discord accepts channel names with DORI_DISCORD_GUILD_ID; --thread needs no --to and also targets edits
                                       Discord splits text past 2000 characters (SENT lists every id); --reply is Discord only
  thread discord create --to CHANNEL --title T [--text T] [--tag NAME]... [--message ID]
                                       --message opens the thread on that message of a text channel
  thread discord set <thread> [--title T] [--tag NAME]... [--archive|--unarchive]
                                       open a forum post or text-channel thread; rename, replace tags, archive or reopen
  react discord --to CHANNEL [--thread ID] --message ID [--emoji E] [--remove]
                                       add or remove the bot's own reaction (eyes by default); --thread needs no --to
  voice discord                       opt-in owner-only voice assistant (voice.enabled in config; paid provider usage)
  channel discord set <channel> --purpose T | clear <channel> | list
                                       the operator's purpose note per channel or thread, shown by inbound --context
  presence <slack|discord>             keep the account shown as online until stopped
  transcribe <audio-file|url>           run hooks.transcribe and print the text; HTTP(S) downloads are private and temporary
  inbound slack|telegram|discord [--loop MIN] [--gateway] [--context]
                                       print INBOUND lines: Slack unread thread replies / Telegram owner DMs, edits and media + configured topic
                                       the Dori posted in (any helper), DMs and channels with unread mentions
                                       Discord requires DORI_DISCORD_TOKEN, DORI_DISCORD_OWNER_ID and configured channel IDs
                                       (more channels or threads: DORI_DISCORD_CHANNEL_IDS=a,b; threads of a watched channel are followed unless
                                       DORI_DISCORD_THREADS=off; every readable one: DORI_DISCORD_SCOPE=all)
                                       Discord polls every 3 seconds by default; --loop MIN overrides the interval;
                                       --gateway delivers owner messages live with REST backfill and ignores --loop, including 0
                                       --context (Discord) adds INBOUND_CONTEXT: channel, thread, topic and recorded purposes
  inbound-lag [--limit N]              receive-lag percentiles from state/telegram-lag.jsonl (the meter behind the INBOUND lines)`;

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
