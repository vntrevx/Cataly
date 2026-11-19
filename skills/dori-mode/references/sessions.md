# Sessions (lanes)

A lane is one agent session doing one job in its own herdr tab or hc terminal. You launch it, track it in the registry, answer it when it is stuck, and close it when its work is proven done.

## Launching

```sh
dori launch fix-login --title "Fix the login redirect loop" \
  --brief ~/briefs/fix-login.md --done "merged acme/app#412; closed acme/app#398" \
  --thread "telegram:<chat>/<topic>" --model anthropic/claude-opus-5-5
```

`launch` checks the key and the `Done =` line, appends a footer to the brief, opens a tab in `laneWorkspace`, starts the agent, and after 20 seconds checks the start: `STARTUP_ERROR` on a known failure (missing module, no API key, rate limit, quota), also when one shows on an idle agent during the goal wait, `STARTUP_OK` only when the runtime reports the agent idle or working and it shows a goal (checked again every 10 seconds until `startupWaitSeconds`, 180 by default, after the start; an agent that has not reported a status yet is waited for too), `STARTUP_NO_GOAL` when it still shows no goal after that, `STARTUP_DONE <key>` when the session is gone and the lane already finished (closed, verified-done or reported done; exit 0, nothing to do), `STARTUP_UNCONFIRMED` otherwise. On `STARTUP_ERROR`, relaunch on another model; on `STARTUP_NO_GOAL`, tell the lane to set its goal, since a lane without one stops after its first turn; on `STARTUP_UNCONFIRMED`, look at the pane before doing anything else.

Write the brief like a careful prompt:

- open with the keywords you would type yourself (for example `ulw set goal and work`);
- where the code is and what has been learned so far;
- the ideal end state, from the point of view of whoever uses the result;
- what not to touch;
- how and when to report.

**Why the `Done =` line has to be checkable:** the watcher closes lanes on its own, so it can only trust what it can read back itself. `launch` and `adopt` refuse any signal outside this list. Signals are joined with `;`, and every one has to pass.

| Signal | Passes when |
|---|---|
| `merged <owner/repo>#N` | the PR is merged and has a merge commit |
| `closed <owner/repo>#N` | the issue is closed |
| `published <pkg>@<version>` | npm has that exact version |
| `command ["argv","as","json"] [stdout~"regex"]` | the command exits 0 when the watcher runs it, and stdout matches if a regex is given |
| `file <path> [sha256=<hex>] [json:.a.b=<json value>]` | the file exists, its sha256 matches, and the JSON field equals the value |
| `url <http(s) url> [status=200] [body~"regex"]` | a GET returns that status, and the body matches if a regex is given |

The last three are for work that never lands as a PR: a local setup, a QA pass, a running service. Write the check so that it can fail. `command ["bun","test"] stdout~" 0 fail"` is a real check, while `command ["true"]` checks nothing. The watcher runs commands itself, in the lane's directory, as a plain argv with no shell. They have a 2-minute limit. It never trusts the lane's own report that something passed. Relative file paths resolve from the lane's directory, and `~` is your home. JSON values compare as JSON, so `json:.n=3` and `json:.n="3"` are different checks.

Example for a QA-only lane:

```
Done = command ["bun","test"] stdout~" 0 fail"; file qa/report.json json:.passed=true; url http://localhost:3000/health body~"ready"
```

Work no script can check (a design review, a judgement call) stays in the lane's own plan. You judge it yourself before the claim.

## The registry

One JSON file per lane under `<stateDir>/lanes/`, written atomically (temp file + rename), so two writers never leave a half-written file. Each lane records:

| Field | Meaning |
|---|---|
| `thread` | where its updates go, as `platform:thread` (or `none`) |
| `sessionRef` | its session: the runtime (`herdr` or `hc`) and the id; `pane` and `tab` mirror the id and the herdr tab (none on hc). A record from before runtimes existed is read as herdr |
| `session` | the agent's own session id, so a closed job can be reopened later |
| `status` | `working`, `done-claimed`, `verified-done`, `not-done`, `closed` |
| `claim`, `objection`, `history` | what was claimed, what was objected, every status change |

`dori sync` compares the registry with live panes and prints drift (a pane that is gone, a session id that changed, an empty `Done =` line). It never deletes anything. With `--write` it stores the session ids it found.

How the session id is found for a pane, in order:

1. the role-gated OMP extension's record under `<stateDir>/sessions/<encoded runtime id>.json`, trusted only when its PID belongs to the current session's live agent process;
2. an OMP session file in `sessionsDir` whose timestamp matches that process, using OMP's temporary, home-relative and legacy directory encodings.

The extension updates its record when the agent switches sessions. A stale PID, wrong terminal or approval-pending record never becomes permission to type into another process. On hc, OMP reports native OSC 7501 status so the runtime's conditional send gate remains active; unknown status stays held.

When the owner writes in a closed lane's thread, use `dori reopen <key> [--note TEXT]`. It starts the exact saved OMP session in a new pane, verifies its live identity and paused goal, then confirms `/goal resume` through extension state. It preserves the original thread, Done signals and history, clears the old claim/receipt, and starts a new supervision interval. A missing saved session or working directory, existing old pane, already-running session, or non-OMP command refuses reopening. An advanced `agentCommand` must end in a positional `{prompt}` and contain no preselected session. A startup/readback failure leaves one registered paused lane for inspection, never silently starts another. A failed start that left a confirmed bare shell can be ended with `close --abandon --reason TEXT`, then explicitly reopened; a foreign or unverified agent still holds. Ordinary `resume` verifies the recorded session identity before sending input. An optional note is sent once; exit 3 can mean its delivery is unconfirmed, so never repeat it automatically.

## Pause, park and abandon

- `pause` / `resume` retain their existing short-wait behavior: keep the pane and verify native goal state.
- `dori park <key> --note TEXT [--resume-when TEXT]` is long-term suspension for an OMP lane. It verifies the exact saved session and goal pause before closing only that lane's pane, keeps all worktrees (including unpushed work), and records `status: closed` with `receipt.outcome: parked`, not a successful completion. An unconfirmed pause or failed pane close leaves the lane open/paused and exits 3.
- `dori close <key> --abandon --reason TEXT` explicitly ends unfinished work without claiming Done. It pauses a live working/not-done lane before closing its pane, or records an already absent pane. Worktrees are retained and the receipt says `abandoned`. Both terminal operations accept working, not-done or paused lanes; a pending done claim must first be resolved. Neither runs `threadDone`, removes worktrees, or creates a success lesson. Ordinary `close` still checks every Done signal and records `outcome: done`.
- Both terminal commands hold before pausing or closing a native lane while its accepted Discord messages are still pending. Parking or abandoning a live OMP agent also requires its previously recorded session identity; inspect and bind the correct session with `dori sync --write` before proceeding if it is unbound.
- `dori holds [--thread REF]` and `dori boot` show paused/parked lanes with their reasons and resume conditions. Conditions are descriptive; passing time or a prerequisite never resumes the lane. Only an explicit `resume` or `reopen` does. A parked lane does not count as open, and the normal done watcher does not settle it.
- Parked and abandoned lanes do not count as completed samples in `dori eta`.

Parking records the saved session, original reason and resume condition before closing the pane. If interrupted after that close, repeating the same terminal command finishes the stored intent without replacing its reason or condition. For an interrupted park, `dori reopen <key>` instead restores the same saved session when its old pane is absent, including when accepted Discord work must still be delivered. It never discards that work to finish parking.

Reopening uses the delivery lock shared with pause, resume, tell and close. Concurrent reopen attempts cannot create two agents. Older completed lanes can resolve an exact recorded session ID in `sessionsDir` when no path was saved. Deleted completed worktrees are not recreated implicitly. The reopened registry generation starts current progress afresh, even if writing the reopen journal event is interrupted. Old reports and cost receipts remain on disk.

`dori sync --write` still reports identity drift; it cannot replace the exact binding of a prepared or reopened lane.

Ordinary Done close of a reopened lane verifies the saved session's current foreground and records the close intent before removing its pane. Objections can still win before the intent is recorded. After that point, another claim, objection or delivery cannot change that decision. If pane-close readback is interrupted, retry `dori close` or let the active Done watcher confirm the saved intent. A missing pane without a saved intent is not treated as a completed close.

## Messaging a session

Before you type into a pane:

1. check it runs a live agent (`herdr pane process-info --pane <id>` / `hc get <t>`), not a shell, a stopped agent or a startup screen;
2. read it (`herdr pane read <id> --source recent-unwrapped --lines 40` / `hc read <t> --lines 40`) and confirm the input line is empty and no approval or question prompt is open;
3. send once, as one argument (the scripts' `sendVerified` does this);
4. confirm delivery from a state change: the agent's status moving to working (herdr's `agent_status`, or the status the agent reports on hc), or the message showing up in the session record. Never press Enter again because of what the screen shows; if no change shows up, treat the send as unconfirmed.

Exit code 0 and echoed input are not proof the agent got the message. A reply from the session, or its record of handling the message, is.

For a registered lane, `dori tell <key> --text TEXT` does steps 1, 3 and 4 through `sendVerified`; the runtime's delivery holds on an open OMP approval or an unknown status. `TOLD` (exit 0) means the agent moved to working. `TELL_UNCONFIRMED` (exit 3) means the text may be in the session but no status change was seen, which is always the case for an agent that was already working: do not send it again; wait for the lane to answer, or read the pane (step 2) and, if the text still sits in the input, press Enter only. `TELL_FAILED` (exit 2) means nothing was sent: a shell, a stopped agent, an approval prompt, an unreadable status, on hc a `blocked` or `error` agent (answer its question in the pane), a paused lane (resume it first), a lane without a session, or text with a backtick or `$(`; a refusal by the runtime ends with the status read after it. An unknown or closed key exits 1.

An unconfirmed dispatch now keeps a private, durable local request ID. It fences later `tell` messages, automatic nudges, and claim/objection notifications even after restart; a rejected later message is not queued. `dori tell <key> --status` shows that record. Only `dori tell <key> --resolve REQUEST_ID --note REASON` ends that exact hold: it does not prove the action ran, cancel the original input, or resend anything. Inspect the original session and obtain the operator's decision before releasing it. Ordinary activity cannot clear a hold. Explicit pause/resume remains available, and releasing a hold does not resume a paused lane. See the scripts reference for statuses, errors and concurrency.

This hold covers Dori automation, not direct native owner input. Native Discord owner messages and native ASK replies retain their existing admission rules so the owner can still control the session. They do not release the uncertain record; later tells, nudges and claim/objection notices remain held until an exact-ID release. Explicit `reopen --note` is also operator control: it attempts the note once under its existing session/goal checks without creating or clearing a `.delivery` record. An unconfirmed reopen note is not resent automatically.

## Watching

- Sessions that turn blocked or ask a question: answer them or bring them to the owner.
- Sessions that report a bug: reproduce it before it counts, then give it its own thread.
- `dori dead-panes` reports agent sessions that stopped; reopen the recorded OMP session with `omp --resume=<id>` unless its work is finished.
