# Lanes & Verifiable `Done =` Signals

A **lane** is one scoped job owned by a dedicated `cataly-lane` Antigravity subagent and tracked in `~/.cataly/state/lanes/<key>.json`.

## Supported `Done =` Signals

Join multiple signals with `;`. Every signal must pass live verification for a lane to close.

| Signal | Live Verification |
| :--- | :--- |
| `merged <owner/repo>#N` | `gh pr view` confirms `state == MERGED` with a non-empty `mergeCommit.oid` |
| `closed <owner/repo>#N` | `gh issue view` confirms `state == CLOSED` |
| `published <pkg>@<version>` | `npm view <pkg>@<version> version --json` confirms the exact version exists |
| `command ["argv","..."] [stdout~"regex"]` | Executes argv directly (no shell, 120s timeout), exit code 0, optional stdout regex match |
| `file <path> [sha256=<hex>] [json:.a.b=<json>]` | File exists, optional exact SHA-256 match, optional exact JSON field comparison |
| `url <http(s) url> [status=200] [body~"regex"]` | HTTP GET returns expected status code and optional body regex match |

## Launching a Lane (Lead Workflow)

1. Write a clear brief describing: goal, code location, evidence so far, ideal end state, and what not to touch.
2. Call `cataly_lane_create` with `key`, `title`, `cwd`, `done`, `briefBody`, `priority` (1–9), and optional `worklogId`/`thread`.
3. Call `invoke_subagent` with:
   - `TypeName`: `"cataly-lane"`
   - `Role`: `"Cataly Lane: <key>"`
   - `Prompt`: the `renderedBrief` returned by `cataly_lane_create`
4. Call `cataly_lane_attach` with `key` and the returned `conversationId`.
5. When the subagent completes or messages back, inspect its claim and run `cataly_lane_verify_close`.

## Thin Always-Listening Head + Parallel Subworker Fan-Out

When Discord reactive intake (`discord wait --timeout 0`) is active, Head operates as a thin, non-blocking dispatcher so the owner never waits behind an in-flight research or coding task.

### Worker Selection

| Worker Type | Use When | Replies to Discord | State Tracking |
| :--- | :--- | :--- | :--- |
| **Head (direct)** | 1-turn confirmations, decision matching, `/usage`, `/model`, lane pause/resume | `cataly_discord_send` with `replyTo` | Worklog / Decisions |
| **`cataly-responder`** | Scoped read-only requests: Q&A, web search, codebase/PR inspection, concise summaries | Direct via CLI `discord send --to <ch> --reply <msgId> --stdin` (or `--text-file`) | Per-message obligation receipt + 2–4 line summary to Head |
| **`cataly-lane`** | Code edits, builds, PRs, migrations, or multi-step work needing verifiable `Done =` signals | Head relays milestones & verified completion (or dedicated thread) | `cataly_lane_create` -> `cataly_lane_attach` -> `cataly_lane_verify_close` |

### Immediate Re-Arm & Multi-Message Burst Triage

1. **Burst coalescing**: `discord wait --timeout 0` buffers rapid multi-line owner messages for `--debounce-ms 700` (capped at `2000ms`), fires instant `👀` + typing for each message, sorts them chronologically by Snowflake ID, and flushes slash commands immediately (`--debounce-ms 0` disables coalescing).
2. **Same-turn fan-out + re-arm**: In the exact same turn that `INBOUND_MESSAGES=[...]` arrives, spawn all required `cataly-responder` / `cataly-lane` subagents AND immediately re-arm `discord wait --timeout 0`.
3. **Merge vs. fan-out vs. steer**:
   - **Merge** fragmented lines of a single thought into **one** worker, passing the anchor/latest `messageId` for `--reply`.
   - **Fan out** independent questions or tasks into **parallel** workers.
   - **Steer** follow-ups, clarifications, or cancellations for an already in-flight worker via `send_message` to its `conversationId` instead of spawning duplicates.
4. **Repository edit isolation**: When multiple lanes target the same git repository concurrently, isolate edits using `Workspace: "share"` (or dedicated git worktrees) and coordinate shared resources via `cataly_lock_manage`.
5. **Per-message obligation hygiene**: Both `cataly_discord_send(..., replyTo)` and `cli.js discord send --reply <messageId>` call `markMessageReplied(messageId)` so parallel workers clear only their own pending obligation without clearing concurrent messages in the same channel. On Windows PowerShell, always send multi-line or non-ASCII text via `--stdin` or `--text-file` with UTF-8 encoding.
