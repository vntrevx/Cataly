# Cataly Plugin for Google Antigravity

An autonomous AI teammate plugin for Google Antigravity ported from [vntrevx/Cataly](https://github.com/vntrevx/Cataly): lead/lane subagent orchestration, live-verified `Done =` signals, persistent worklog/decisions/lessons/checkpoints/backlog, PR verification & watch, lifecycle hooks, and native Discord v10 integration.

## Included Components

- **Skill**: `cataly-mode` (operating contract, lane & done protocol, consent-first onboarding, writing rules, Discord setup)
- **Subagents**:
  - `cataly-lane`: dedicated lane worker subagent with checkpoint, report, and live `Done =` verification discipline
  - `cataly-responder`: lightweight parallel Discord responder subagent for scoped read-only requests with direct per-message replies
  - `cataly-reviewer`: independent code/PR reviewer outputting `VERDICT: CLEAR` or `VERDICT: BLOCK`
- **Rules**: `rules/AGENTS.md` (evidence over claims, owner authority, one-shot destructive actions, secret hygiene, quota discipline, compaction persistence)
- **MCP Server**: `cataly-core` (42 tools covering boot, config, lanes, live done checks, shared board, worklog, decisions, lessons, checkpoints, reports, backlog, locks, PR verify/watch, and Discord)
- **Hooks**: `SessionStart` (boot summary injection when active state exists) and `Stop` (single-shot guard for bound working lanes)

## State Directory

Persisted under `~/.cataly/` by default (override via `CATALY_HOME`):
- `~/.cataly/config.json`: configuration and onboarding memory
- `~/.cataly/secrets/discord.token`: optional Discord bot token (never logged or returned)
- `~/.cataly/state/`: `worklog.jsonl`, `decisions.jsonl`, `lessons.jsonl`, `board.jsonl`, `lanes/`, `briefs/`, `backlog/`, `locks/`, `attachments/`, `tracked-prs.json`
