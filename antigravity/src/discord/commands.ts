import { SharedBoard } from "../core/board.js";
import { collectBootSummary } from "../core/boot.js";
import { LaneRegistry } from "../core/lanes.js";

export type ShortcutCommandName = "help" | "status" | "board" | "stop" | "resume" | "usage" | "model";

export type ParsedDiscordCommand = {
  readonly name: ShortcutCommandName;
  readonly args: string;
  readonly localZeroToken: boolean;
};

const LOCAL_COMMANDS = new Set<ShortcutCommandName>(["help", "status", "board", "stop", "resume"]);
const ALL_COMMANDS = new Set<string>(["help", "status", "board", "stop", "resume", "usage", "model"]);

/**
 * Parse a Discord owner message starting with `/` or `!` into a known Cataly command.
 */
export function parseDiscordCommand(content: string): ParsedDiscordCommand | null {
  const trimmed = content.trim();
  const match = /^[/!]([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match?.[1]) return null;
  const name = match[1].toLowerCase();
  if (!ALL_COMMANDS.has(name)) return null;
  const cmd = name as ShortcutCommandName;
  return {
    name: cmd,
    args: (match[2] ?? "").trim(),
    localZeroToken: LOCAL_COMMANDS.has(cmd),
  };
}

export type LocalCommandResult = {
  readonly handled: boolean;
  readonly reply?: string;
};

/**
 * Execute zero-token local Discord commands (`/help`, `/status`, `/board`, `/stop`, `/resume`)
 * directly in Node without waking the AI model.
 */
export function runLocalDiscordCommand(
  cmd: ParsedDiscordCommand,
  stateDir: string,
  catalyHome?: string,
): LocalCommandResult {
  if (!cmd.localZeroToken) {
    return { handled: false };
  }

  if (cmd.name === "help") {
    return {
      handled: true,
      reply: [
        "Available Cataly shortcut commands (prefix with `/` or `!`):",
        "",
        "[Local Instant — 0 AI tokens]",
        "- /status : Summary of open worklog items, active lanes, waiting decisions, tracked PRs, and shared board",
        "- /board : Show recent shared board notes",
        "- /board <note> : Post a new informational note to the shared board",
        "- /stop [lane-key] : Pause the specified lane (or all working/not-done lanes if omitted)",
        "- /resume [lane-key] : Resume the specified lane (or all paused lanes if omitted)",
        "- /help : Show this command guide",
        "",
        "[Session-Routed]",
        "- /usage : Inspect live model quota availability and reset times",
        "- /model <name> : Inspect or switch the active session model and reasoning tier",
      ].join("\n"),
    };
  }

  if (cmd.name === "status") {
    const s = collectBootSummary(catalyHome);
    const board = new SharedBoard(stateDir).read({ limit: 3 });
    const lines: string[] = [
      `[${s.agentName} Status Summary] (local instant, 0 tokens)`,
      "",
      `- Open worklog items: ${s.openWorklog.length}`,
      `- Waiting decisions: ${s.openDecisions.length}`,
      `- Active lanes: ${s.activeLanes.length}`,
      `- Tracked PRs: ${s.trackedPrCount}`,
      `- Shared board notes: ${board.head}`,
    ];

    if (s.openWorklog.length > 0) {
      lines.push("", "[Open Worklog]");
      for (const w of s.openWorklog.slice(0, 5)) {
        lines.push(`- [${w.id}] ${w.title}${w.next ? ` (next: ${w.next})` : ""}`);
      }
    }
    if (s.activeLanes.length > 0) {
      lines.push("", "[Active Lanes]");
      for (const l of s.activeLanes.slice(0, 5)) {
        lines.push(`- ${l.key} [${l.status}] ${l.title}${l.lastReport ? ` — ${l.lastReport}` : ""}`);
      }
    }
    if (s.openDecisions.length > 0) {
      lines.push("", "[Waiting Decisions]");
      for (const d of s.openDecisions.slice(0, 5)) {
        lines.push(`- [${d.id}] ${d.question}`);
      }
    }
    if (board.posts.length > 0) {
      lines.push("", "[Recent Board Notes]");
      for (const p of board.posts) {
        const preview = p.text.replace(/\s+/g, " ").slice(0, 100);
        lines.push(`- #${p.seq} [${p.author}] ${preview}`);
      }
    }
    return { handled: true, reply: lines.join("\n") };
  }

  if (cmd.name === "board") {
    const board = new SharedBoard(stateDir);
    if (cmd.args) {
      const created = board.post({ author: "owner", text: cmd.args });
      return {
        handled: true,
        reply: `Posted note #${created.seq} to the shared board.\n\n- Content: ${created.text}`,
      };
    }
    const read = board.read({ limit: 5 });
    if (read.posts.length === 0) {
      return {
        handled: true,
        reply: "No notes on the shared board yet.\n\nUse `/board <note>` to post a new note.",
      };
    }
    const lines = [`[Shared Board: latest ${read.posts.length} of ${read.head}]`, ""];
    for (const p of read.posts) {
      const meta = [p.lane ? `lane:${p.lane}` : "", p.topic ? `topic:${p.topic}` : ""].filter(Boolean).join(", ");
      lines.push(`#${p.seq} [${p.author}${meta ? ` / ${meta}` : ""}]`);
      lines.push(p.text);
      lines.push("");
    }
    return { handled: true, reply: lines.join("\n").trimEnd() };
  }

  if (cmd.name === "stop") {
    const registry = new LaneRegistry(stateDir, catalyHome);
    if (cmd.args) {
      try {
        const paused = registry.pause(cmd.args, "paused via Discord /stop");
        return { handled: true, reply: `Paused lane '${paused.key}'.` };
      } catch (err) {
        return { handled: true, reply: `Failed to pause lane: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const working = registry.list(false).filter((l) => l.status === "working" || l.status === "not-done");
    if (working.length === 0) {
      return { handled: true, reply: "No active working lanes to pause." };
    }
    const keys: string[] = [];
    for (const lane of working) {
      registry.pause(lane.key, "paused via Discord /stop");
      keys.push(lane.key);
    }
    return {
      handled: true,
      reply: `Paused ${keys.length} active lane(s).\n\n- Lanes: ${keys.join(", ")}\n- Run /resume to continue.`,
    };
  }

  if (cmd.name === "resume") {
    const registry = new LaneRegistry(stateDir, catalyHome);
    if (cmd.args) {
      try {
        const resumed = registry.resume(cmd.args, "resumed via Discord /resume");
        return { handled: true, reply: `Resumed lane '${resumed.key}'.` };
      } catch (err) {
        return { handled: true, reply: `Failed to resume lane: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const paused = registry.list(false).filter((l) => l.status === "paused");
    if (paused.length === 0) {
      return { handled: true, reply: "No paused lanes to resume." };
    }
    const keys: string[] = [];
    for (const lane of paused) {
      registry.resume(lane.key, "resumed via Discord /resume");
      keys.push(lane.key);
    }
    return {
      handled: true,
      reply: `Resumed ${keys.length} paused lane(s).\n\n- Lanes: ${keys.join(", ")}`,
    };
  }

  return { handled: false };
}
