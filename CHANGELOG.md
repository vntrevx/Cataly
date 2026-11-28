# Changelog

## 0.2.9 (Unreleased)

### Shell rule 0

- Rule 0 no longer refuses `cataly` words that are only text. It judges the words in command
  position (past `if`/`then`/`do`/`!`/`{`, assignments and redirections), every word after a runner
  (`env`, `sudo`, `xargs`, `find`, `timeout`, shells and the rest), and command substitutions
  wherever the shell expands them: bare, inside double quotes and in unquoted here-documents. Text
  is left alone: a commit message in a quoted here-document, a `grep`/`sed` pattern, `git commit -m`,
  `echo` and `printf` arguments, single-quoted text and comments.
- Code is still judged as command lines: the phrases, here-documents and piped input of shells,
  `eval`, `su`, `watch`, `flock`, `parallel`, `ssh`, `docker`/`podman`/`kubectl`, `tmux` and the
  `python`, `node`, `perl`, `ruby` and `awk` interpreters, so `bash -c "cataly update"`,
  `bash <<'EOF'`, `… | sh` and `$(cataly update)` stay refused, nested too. Inside such code every
  phrase still counts, so `sh -c "grep 'cataly update' f"` is refused as before.
- `--help` or `-h` after any `cataly` verb is allowed: the CLI's own parser reads it as a usage
  request and runs nothing (`cataly setup --help`). As a flag's value it is not one
  (`--file --help`), and stays refused.
- `ssh HOST cataly <verb>` is now refused like the quoted form.

## 0.2.8 (2026-11-28)

- The upgrade to 0.2.7 could hold the lead as "ambiguous lead binding history" when its working
  directory had changed at some point, leaving only `lead start --fresh`, which abandons the
  conversation. 0.2.8 resumes the newest conversation, and a store already held that way is repaired
  at start (schema 13, additive; the reader floor stays 11).

## 0.2.7 (2026-11-28)

### Upgrade notes

- **Worker update required:** protocol 2 refuses protocol-1 workers. Run `cataly update` on each
  worker PC; until then its lanes are held, with their conversation and work retained.
- Conversation-safe stores require schema reader 11. Older hubs must not open them and bypass
  the resume anchor; retain the new version, or explicitly restore the pre-upgrade store backup
  before a compatible downgrade. The store moves to schema 12: `0011_lead_anchor` (raises the
  reader floor to 11) and `0012_outbox_turns` (additive: a later turn's parts, the floor stays 11).
- **Going back a version can no longer strand the hub.** `cataly version --json` reports
  `store_reader`, the newest store schema the binary reads. `cataly rollback`, an update or install
  that switches versions, and `install.sh` over an existing install (through the installed binary's
  new `cataly install --preflight <binary>`) read the store's `meta.min_reader` read-only and refuse
  a version that cannot open it, before the hub is stopped or any file switched (exit status 6). A
  version without the field uses an exact released-version table: 0.2.0–0.2.5 read schema 9;
  0.2.6 reads schema 10. Unlisted versions fail closed. The message, in `[hub] language`, says the store was upgraded for conversation
  safety and which version cannot read it, and offers staying on the current version or restoring
  the store copy the hub made before that upgrade (named when one exists; updates keep none of their
  own). An `install.sh` or binary already published cannot be taught this check: going back with one
  of them leaves the older hub refusing to open the store, with nothing lost; installing the current
  version again brings it back.
  An unreadable candidate report also refuses an install over retained state; an empty home
  remains installable without a store-reader capability.
  Preflight uses a query-only reader with a 250 ms busy limit; an unreadable floor refuses
  rather than waiting on or changing a running hub's store.
- Automatic update switch-back refuses an old reader after the new hub migrated the store beyond
  its support, leaving the new version selected with an owner-attention explanation.
- After an update, sessions still recovering are reported as recovering, not as a final state,
  by the hub's message and by `cataly update`; a second `update.sessions` message gives the final
  result once they settle.

### Lead resume and startup

- Retain the lead's proven conversation independently of failed launch attempts and history
  retention. Pins select their exact earlier binding; missing, unsafe or unverified transcripts
  hold rather than silently starting fresh. After a failed explicit fresh start, use
  `lead start --fresh` to retry fresh or `lead start` to resume the retained old conversation.
- Bound headless startup from spawn through exact binding by one 60-second deadline, with a
  15-second notice, verified process cleanup, and a durable 300-second recovery episode.
  Retain pre-binding ownership evidence across hub crashes; input stays fenced until the
  validated identity is committed.
  Duplicate same-target starts leave the owned attempt running; a refused busy stop leaves
  recovery intact. Worker termination receipts must match the exact persisted attempt token.
- Recover the lead on its existing session after a transient rpc-ui ready timeout. Retries use the
  lead's existing backoff after verifying the child exited and the session lease is free. Failed
  resume attempts keep their diagnostics without superseding the last bound session
  ([PR #299](https://github.com/vntrevx/Cataly/pull/299), @Momentum96).
- Explicit fresh intent clears a migrated anchor hold. Ordinary A-to-B conversation histories
  resume their newest proven binding, and an owner retry of a first failed start needs no
  `--fresh` when no conversation ever bound. A 0.2.6 binding recorded with a model-mismatch
  fault (as a suffixed model such as `x:high` left on every start) migrates as a binding with
  its model unverified; the model is checked again at the next start. A 0.2.6 start left
  `starting` by a crash, with no startup journal, is failed as 0.2.6 did, not held. Startup
  model mismatch keeps the process open and input fenced until `lead accept-model` durably
  commits the accepted identity; the fenced start ends its recovery episode, so a later exit
  gets a fresh retry window. A model fence also prevents idle sleep, so the session stays
  available for that decision.
- The owner hears directly, in `[hub] language`, when the lead is still starting at 15 s (once
  per recovery) and once per hold, with the reason, what is kept, `cataly lead start` after the
  fix, and that an update does not lift the hold. A hold found again after a hub restart or an
  update is not announced again. `cataly lead status` and `cataly health` show the target, the
  startup phase and elapsed time, attempts and next retry, the last cleanup and lease evidence,
  the inbox counts, and the same hold text; the ops panel shows a recovering lead.
- **A lead woken from sleep or restarted after a crash no longer gets a second start recap.**
  The recap goes in front of a new conversation and of the lead's first connection after a hub
  start; the extension's hello on a resumed or woken session is a connection, not a new
  conversation, so it adds none.
- Tern startup journals retain the block ID and process birth identity; confirmed block close
  or disappearance of that exact process proves termination. Unknown exits remain held.
  A stopped Tern lead or lane is confirmed only once its OMP process is gone: OMP gets 5 s to exit
  after it shut down, then Tern closes the block, and the stop answers when that process has
  ended (5 s more at most; a process still running stays unconfirmed). Before, `lead stop`
  answered while OMP still ran, and a `lead start` right after it could find the session held.
  A hub stopped during a Tern start before the bridge's hello, with no process recorded yet,
  reconciles that attempt by a confirmed close of its recorded block, or Tern's answer that it
  has no such block, instead of holding the lead for good. The block ID is read from what Tern
  prints (`"block": 3`); before, it was never recorded with Tern 0.9.36, so neither this nor the
  block close at a stop could happen.
  Settled startup receipts are pruned only after no anchor, recovery episode or lane references
  them; current and uncertain attempts are never discarded merely because they are old.
  Maintenance collapses only superseded duplicate binding tuples, retaining the current anchor
  and latest evidence for every pinnable identity. A crash before receipt pruning leaves a
  harmless retained receipt that the next prune can remove.
- `lead start` right after `lead stop` is no longer refused with the stop's own reason ("stopped:
  clean") when the hub's supervisor was just checking the lead; only a start that actually ran
  meanwhile answers a waiting one.
- A written message is resent after a restart only when the whole transcript proves it absent.
  The marker search now covers the entire file instead of its newest 8 MiB, and a partial,
  unparsable, oversized or unreadable transcript (or a search out of time) leaves the message in
  doubt for the owner instead of writing it again. A resend still happens at most once, under
  the original delivery ID, into the same session; worker deliveries are never resent
  automatically. Protocol 2 workers answer the hub's search with `absent` or `unknown`.

### Model selectors

- **No more false "model mismatch" for thinking suffixes.** A configured model such as
  `anthropic/claude-opus-5-5:high` is checked against what OMP itself resolves it to: the base
  model at that thinking level. The hub asks the session's bridge with a read-only query within
  the startup deadline; an ID with a colon part of its own (`ollama/qwen:14b`) stays whole, and a
  level OMP clamped is still a mismatch. The lead, lanes, the lane model barrier, `lead model`,
  `lane model` and terminal sessions all use the resolution; neither a terminal `lead model` nor
  `lane model` splits the selector at its first colon, and `lane model x:high` keeps its level
  for the lane's next start. The lane model barrier moves to a new model only once the change is
  confirmed; a refused change leaves the old model flowing. A bridge older than the hub cannot
  answer: the session stays open and fenced
  as "model unverified" at once. A session whose extension never connects is not a failed start
  either: at the end of the startup deadline it binds, fenced the same way. The owner hears once
  (not on every restart) to run `cataly update` or restart the session, or to keep the model with
  `cataly lead accept-model`.

### Lanes

- Failed lane resumes (hub restart, worker reconnect and explicit reopen) keep the exact session,
  run, mailbox and worktree ownership, held with diagnostics rather than rolling back prior work.
  Fresh launch rollback is limited to the attempt's own proven unused allocation.
- Worktree removal now requires a durable close/rollback intent, confirmed writer exit and a fresh
  preservation check. Tracked, untracked and ignored files, unpushed commits, uncertain input,
  published files and unknown checks all keep the worktree; removal failures retain the record
  and appear in its receipt. Remote EOF is not a worker reap acknowledgement. Ignored cache
  disposal is a separate explicit owner action, not part of close or recovery.
- Reopen answers with `resumed`, `recovering` or `held` after its first definite outcome instead
  of blocking the caller for the whole recovery episode. Continuing recovery retains ownership,
  reports its final result to the owner and lane thread, and is cancelled by close, park or hub stop.
- `cataly lane status <key>` shows the named lane. Lane alerts and recovery recaps reach the
  owner's home room directly, even while no lead is available.
- Legacy lanes without startup journals may resume only with their saved identity, no recorded
  attempt ownership and a fresh free-lease check. Recorded unknown ownership still holds.
- Explicit reopen records its recovery episode, run, note and completed step durably. A hub stop
  cancels the live attempt; restart continues that same intent without repeating its run or note.
  Owner-paused or held lanes without a reopen intent stay down. Failed reopen preflight changes
  nothing, and holding an already-held lane preserves the first reason.
- In-doubt input prevents destructive worktree removal, not a safe park or close. The message
  ledger and kept worktree remain available for inspection; uncertain input is never replayed.
- Your answer in a headless lane's thread now reaches a lane that paused its own goal while
  waiting for you. An owner or lead message resumes that goal before delivery only when the
  lane is not owner-held, reopening or in doubt. Reminders and budget blocks never resume it.
  Tern cannot prove who paused its goal, so it stays paused and reports how to continue explicitly
  in the terminal or with `lane.pause` followed by `lane.resume`; no automatic answer-resume
  ([PR #311](https://github.com/vntrevx/Cataly/pull/311), @tknmaxxer).
- A delivery set aside now records the check that refused it (`not ready: the goal is paused`)
  instead of only the session status. While a paused or budget-blocked goal still keeps your or
  the lead's messages out, the lead gets one `messages undelivered` alert naming the reason.
- A terminal (Tern) lane keeps its `cataly_lane` tool when the hub sets its goal right after the
  lane connects. Stock OMP's goal mode reads the enabled tools before it switches and sets them
  after, so a goal entered while the extension was still activating its tool dropped it, and the
  lane could not report. The extension now finishes activating its tools before it runs any hub
  command.
- The lead's answer no longer lands in a lane's new thread before the kickoff when it is ready
  while `lane.open` is still making that thread from your message (on a worker, during the push).
  The thread is the lane's from the moment its creation is recorded, not only once the lane's
  record is saved, so the answer stays in the channel as the lead's pointer.

### Answers and messages

- A background job that finishes while the lead answers you no longer replaces the answer. The
  answer is the lead's final message of the turn your message started; a turn OMP starts by itself
  afterwards, as for the job's result, never takes its place, so the real answer is the reply again
  instead of a one-line "the backup finished". That later turn's text is still posted, after the
  answer and where the answer went (the channel or its thread), as its own message that replies to
  nothing and settles nothing. It is stored before it is posted, like the answer, and a restart
  finds it. Discord, Telegram and Slack alike. An older version posts such stored text like the
  rest of an answer ([PR #313](https://github.com/vntrevx/Cataly/pull/313)).
- A lead with `[lead] idle_sleep` no longer sleeps through the reminders for a message of yours it
  has not answered: while such a message still has a reminder to come (1, 4 and 16 minutes after
  it arrived), the lead stays awake. Once the message is answered or no reminder is left, it may
  sleep as before (from #290, @betive37).
- The 👀 on your message shows while the lead works on it; once the answer is posted a done mark
  replaces it: ✅ on Discord (also when the answer went into a thread), `white_check_mark` on
  Slack, and 👌 on Telegram, as ✅ is not a reaction Telegram lets bots set. The done mark is added
  before the 👀 is removed, so your message never shows neither. An answer in doubt, given up or
  not delivered keeps the 👀. The swap comes after the answer and never holds it up, once per
  message: a restart right after the answer finishes it then, never twice, and a failed step is
  logged once and not tried again. A later turn's text still to follow the answer (a background
  job's result) never holds the done mark up.
- Cataly addresses the owner as "주인님" in Korean and "Master" in English instead of "보스",
  "주인" and "boss"/"the owner": the update notice and message, the closing line of an approval
  card ("주인님이 허용했습니다"), a typed answer ("주인님이 채팅으로 답했습니다") or an answered
  question ("Answered by Master: …"), the refusals of other people's presses ("이 버튼은 주인님만
  누를 수 있어요."), and the lead's and lanes' guidance.

### Hosted-tool policy

- One hosted-tool policy hides and denies `eval` and its unavailable helper instructions, keeps
  debug/LSP offered, and reports trusted owner-installed MCP/extension tools at startup. Stock-OMP
  contracts gate PRs and releases against both the minimum and latest versions; the documented shell
  and reset guards prevent accidents, not arbitrary spending. Thanks to @Momentum96 in
  [PR #300](https://github.com/vntrevx/Cataly/pull/300) for finding the eval mismatch.
- Every hosted OMP launch now sets `PI_PY=0` and `PI_JS=0` last. Stock OMP refills unset or empty
  variables from project, agent and home `.env` files, so a `.env` line could turn the eval
  kernels back on. The variables come from a table derived from OMP's settings schema, and a stock
  contract fails when OMP adds or renames a binding for a pinned setting.
- The OMP probe keeps reading OMP's output until OMP exits. With an MCP server configured, stock
  OMP 19.1.1 could still write after the probe's last request and then exit with an error on the
  closed pipe, so the probe failed and the lead never started.

### Ops panel

- The ops panel names why it is not green after its summary, the most serious first
  (`🔴 확인이 필요해요: 디스크 여유 3 GB`, `🟡 Worth a look: anthropic limit 100%`). The host
  line names the alert's cause ("과부하"/"overloaded" for load only, "메모리 부족"/"low memory",
  "디스크 부족"/"low disk"), and so do the alert post and its recent line: a low disk at 20 % load
  showed as "과부하" and "서버 부하가 5분 넘게 높아요". `pressure.alert` carries a `cause` field.
  A cause that has passed shows as recovering until the pressure job's next tick clears the
  alert, and the load margin now applies only once the load itself was over the line. A lead
  restarting on its kept conversation is named too ("리드 복구 중"/"lead recovering").
- The ops panel's pictures are sharper: the banner is 1024×341 and the thumbnail (also on job
  notifications) 512×512, cut from the same originals with the same framing, instead of 768×256
  and 160×160 at heavy compression.
- A channel dropped with the Watched channels picker is out from the moment the picker answers.
  Before, a message sent there within the next moment, while the running intake had yet to follow
  the new list, could still reach the lead and be answered.
- A hub stopped during a voice call waits for the call to finish its accounting before it exits.
  Before, a ledger write cut off by the exit held voice ("ledger write failed: … was cancelled"),
  so voice stayed off after the restart or update until `cataly voice restart`.

## 0.2.6 (2026-11-27)

- The npm/Bun `cataly` launcher now takes signals before it starts the binary. On a busy machine a
  stop signal sent right after the start (as a service manager or a terminal's Ctrl-C may do) could
  end the launcher by default, leaving the binary running without its parent (#297, @betive37).
- The lead can create the owner notes with `profile.create` when the owner asks for them. The op
  takes the owner's message and is refused without one; the message becomes the first change-log
  line of the new file. The notes check refuses email or token-shaped citations before any file
  is created. Creating them twice is still refused (#295, @tknmaxxer).
  Before, `profile.save` refused until the owner ran `cataly lane profile-create` in a terminal,
  even after asking the lead to make them.
- The lead's `question.ask` posts in the Discord thread it names (`thread: "discord:<id>"`) when
  no `room` is given, instead of the home channel. A `room` that is not a Discord channel ID is
  refused instead of silently posting in the home channel, and so is a definitely rejected post.
  An uncertain post stays in the ledger and is reported as in doubt, never as a reason to post
  again. The owner's reply to the lead's open question goes to the lead even in a thread an open
  lane owns (#281, @betive37).
- A question the lead records (`cataly_lead` op `question.ask`) now has one button per option
  on Discord, labelled with its number; the recommended one is highlighted but never chosen by
  itself. Your press answers the question exactly like a reply with that number: the ledger
  records it and the lead is told which question and option (event `question.answered`). Anyone
  else's press, and a press on a question already answered or withdrawn, gets a private refusal.
  However the question is settled (button, reply, or the lead's `question.answer`, `choose` or
  `withdraw`), its message then says so and loses its buttons. Replying with a number or free
  text works as before. Buttons come only when presses reach Cataly over the Gateway (the same
  condition as for OMP's questions); otherwise the question is text only, as before (#292, @betive37).
- The Watched channels picker accepts readable channels again: its single bounded permission
  check now requests two archived threads, Discord's minimum, instead of one (which Discord
  rejects with HTTP 400 / error 50035). The fake Discord enforces archived-thread limits of
  2–100 and message-history limits of 1–100 so invalid page sizes fail in CI.
- Discord voice now joins when you enter the configured voice channel and leaves when you leave,
  including after hub starts, updates and voice restarts. Silence closes only the paid session
  while you remain; status and the ops panel distinguish waiting for you, in the call and held.
- Answers go into owner-started Discord threads and lead work threads outside lanes, with typing
  in the same destination. Lane-owned threads keep the kickoff first and the lead's pointer in the
  channel. Each part's destination and uncertainty are durable before posting: restart resumes at
  the current destination, and an uncertain part never moves even when its thread closes. Only a
  definite refusal permits fallback, with a continuation note for a partially moved answer
  (#284, @betive37).

## 0.2.5 (2026-11-27)

- The lead can open lanes again: `cataly_lead` now declares every parameter its operations read,
  with its real JSON type, so a model that follows the schema sends `checks` as a list of signal
  objects, `worktree` as `{path, branch, base}`, `ceilings` as an object and the lane fields
  (`key`, `brief`, `brief_file`, `thread_from`, `kickoff`, `cwd`, `model`, `origin`, `look_only`,
  `worker`, `priority`, `after`, `expires_hours`, `preview`, `request_id`) typed. One table in
  `src/params.rs` builds both tools' schemas and every operation reads its input through it, so the
  schema cannot fall behind the operations; a test walks each tool's operations from its entry and
  fails on a parameter that is read but not declared, declared with another type, or offered and
  never read. Onboarding's consent and tool answer is now `reply`, because the lane dialog's
  `answer` is an object and one name cannot be two types. The bridge's facts about a report's calls
  travel under `facts`, so they no longer overwrite a step's `evidence`.
- **Remote workers, phase 1 (enrolment and connection).** `cataly worker add user@host[:port]`
  makes one ed25519 key for that machine and prints the `cataly worker init --hub-key '…'` line
  to run there. `worker init` writes a `restrict,command="… cataly worker serve --hub <id>"` line
  into the worker's `~/.ssh/authorized_keys` (with `from=` when given), checks `omp`, `git` and the
  bridge link, says plainly that lanes run tools with that user's rights, and prints the host-key
  fingerprint. `worker add … --host-key SHA256:…` pins that key in Cataly's own `known_hosts`,
  connects with `ssh -F none` (no agent, no forwarding, no config file, no ProxyJump), refuses a
  worker where the forced command did not apply (the marker command `cataly-worker-v1` ran), and
  writes `[workers.<name>]` through the shared config writer. `--tailscale` resolves the machine
  with `tailscale ip` and refuses addresses off the tailnet. `worker list`, `worker doctor` and
  `worker remove` ask the hub; `cataly status` and the ops panel show each worker's state. A
  worker with another worker or bridge protocol is refused as incompatible, naming
  `cataly update` on that machine.
- **Remote workers, phase 2 (lanes on workers).** `lane.open` takes `worker` (a configured
  name) and the lane record keeps it; `lane.workers` lists each worker's platform, state, lanes in
  use and repositories. The lead sets `worker` only from evidence: the owner names the machine or
  a platform only it has, or the repository's origin is listed for that worker; never by default.
  The worker keeps its own bare clone per Git origin under its root (never a folder of its user),
  fetches, checks that the commit is on the origin ("push it first, or open the lane here") and
  adds a worktree per lane at that commit. Uncommitted edits of the hub checkout stay behind; the
  open's reply and the thread's kickoff line say where the lane runs, at which commit, and that.
  The worker's own OMP runs the session over the worker stream (no hub credentials, its own
  logins), its session file stays on the worker, and delivery and resume checks of that file run
  there with the hub's parsers. `command` and `file` checks run on the worker, `pr_merged`,
  `issue_closed`, `web` and `pr_policy` on the hub; a worker lane's receipt names where each ran.
  Bridge connections travel as channels of the worker stream and are accepted only for lanes on
  that worker: never the lead, never another worker's lane, never the control protocol. A lane
  whose worker drops is lost; its OMP ends there, and the lane comes back by itself on the same
  session file through the hub-restart path once the worker answers. A message the drop left
  unconfirmed is then found in that file or ends in doubt: never resent (a local lane's message
  whose process ended is resent once; a worker's process ends out of the hub's sight), the lane's
  `lane.send` fenced until the lead releases it, and the lead and the owner told once. A lane for
  an offline worker is queued and starts by itself once the worker is reachable. The ops panel's
  worker line shows each worker online, idle, offline, reconnecting (lost lanes wait for it),
  refused or incompatible, with its lanes in use. Remote lanes are headless only and count toward
  `[lanes] max` and the worker's `lanes`, not toward `[sessions] cap`; their spend is not read on
  the hub yet.
- A lane message that ends in doubt after it was written (no session-file entry within 30 s, or
  an unanswered write) now fences the lane and tells the lead and the owner; before, only the
  delivery record said so.
- One base64 encoder and decoder (`sys::base64`) replaces the two copies.
- A Telegram, Slack or Discord message read live is no longer handed to the lead by a round that
  finds it queued before its arrival finished. Such a hand-off lost the message's wake from
  `cataly stats` (`*_wake_latency`) and left its read time in the hub's memory for good. The
  round now waits for the arrival, and no read time outlives its message, also when the message
  leaves the queue without a hand-off (a reset, a channel leaving scope).

## 0.2.4 (2026-11-27)

- The ops panel has a **📡 Watched channels** button. It opens a private Discord channel picker
  with the watched channels already chosen. On submit the hub checks that the bot may view and
  read the history of each newly picked channel (one call each) and refuses the whole pick,
  naming the channel and the missing permission, if not. Then it writes `[discord] channels`
  into the config file as it is at that moment (keeping your other lines, moving `home` to a
  watched channel when needed, dropping unwatched channels from `others`), checks it as
  `cataly config check` does and applies it as `cataly config reload` does. Only
  `[discord] owner` may use it, from `[discord] guild`; an invalid result or a failed write
  changes nothing. Channels past the picker's 25 are kept.
- A change of `[discord] channels`, `home` or `others` alone, from the panel or
  `cataly config reload`, now applies on the running Gateway connection: a new channel is read
  from the moment the change was applied and catch-up after a reconnect covers it; a dropped one
  stops being read at once. Before, any `[discord]` change restarted intake and opened a new
  connection.
- A watched channel the bot cannot read no longer stops Discord intake for every channel: it
  leaves intake alone with one `relay.held` notice naming the missing permission, at start, on a
  channel change or when a catch-up read meets it.
- The lead sleeps when it has been fully idle for `[lead] idle_sleep` (default `2h`; `0s` turns it
  off): no turn, no message waiting or in doubt, no open card or owner question and no open lane
  (quiet notes wait through the sleep and go with the first turn after it). The hub
  stops its OMP the orderly way and keeps the session; an owner message (typed or spoken), an
  urgent event, a lane report or `cataly lead send` resumes the same session, and the message is
  delivered once it is accepted. `cataly status`, `cataly lead status`, `cataly health` and the
  ops panel show `asleep`; an update keeps a sleeping lead asleep.
- The lead hands work to lanes. It does work likely to take 5 minutes or less itself in the
  channel; longer work, development in a repository and work worth running beside other work go
  to a lane in a thread under the owner's message, with a brief, done checks and a one-line
  kickoff (`lane.open` `kickoff`, posted first in the new thread), and the lead answers with one
  line naming the thread. An owner message in a lane's thread that asks to split a task out
  becomes a second lane in a new thread beside the first (Discord nests no threads, so
  `thread_from` a message inside a lane thread starts the thread in its channel).
- A lane opened with `worktree` now works in that worktree. Before, its session, its done checks
  and its brief's directory were the repository it was cut from, so lanes meant to edit in
  parallel all edited the main checkout.
- `cataly setup --voice on` turns on Discord voice calls in one command. It fills in every
  `[voice]` key the config does not set yet: a voice channel (`--voice-channel <id|name>`, else
  the server's only one, else `General`/`일반`, else a `Cataly` voice channel found or created),
  the lead's home channel for the text, the models, voice and prices the live voice test uses, the
  system time zone, the caps (30 minutes and 3 USD a day unless `--voice-daily-minutes` or
  `--voice-cap-usd` say otherwise) and the key file (`--voice-key-file`, else
  `secrets/voice-key`; without one setup stops before enabling anything). Keys you set are kept.
  The summary says that calls cost money on your OpenAI key and shows the caps. `--voice off` turns
  voice off and keeps the other keys. `cataly config check` now warns when voice is enabled but
  would stay off, and names why. Before enabling voice, setup checks that the bot may view, connect
  and speak in the voice channel; if not, it stops and prints a fresh invite link or names the
  channel overwrite to fix.
- The bot's invite link now also asks for Connect and Speak, which voice calls need
  (`permissions=2252126234414160`). A bot invited before keeps its old role until you open the new
  link.
- Usage no longer holds session starts. The `quota` job keeps its alerts (one warning per level,
  `levels` default `[70, 85, 95]`, and one note when a limit falls back below every level), and
  the ops panel keeps its usage bars and turns amber at 90 % for a provider a live session uses.
  `cataly quota`, `cataly quota lift`, the `quota.hold` and `quota.released` events and the
  held-lead lines of `cataly lead status`, the panel and the update message are gone; `cataly
  limits` shows usage. `alerts.quota` now posts a usage alert (`quota.level`).
- A quota job's `hold` setting no longer does anything. The hub removes its line at start, keeps
  the file as it was in `config.toml.before-0.2.4` and records a `config.cleaned` event; a file it
  cannot write keeps the line, ignored, and `cataly health` and `cataly config check` name it.
- An owner job's one-off server or network failure (HTTP 5xx, 429, a timeout) is retried on the
  next tick and becomes a `job.failed` event, and so a note for the lead, only when it happens
  twice in a row; a 404, 401 or bad setting is reported at once as before.
- The planner no longer logs "planner pass failed" when it skips a pass that is not due yet.
- On macOS the CLI now reports a control connection the hub closed without an answer as "the hub
  closed the connection", as on Linux, instead of "Invalid argument (os error 22)". macOS can
  report such a close as EINVAL or ENOTCONN rather than end of stream; these, like EPIPE and
  ECONNRESET, count as closed without an answer on every platform, so `cataly update` and
  `cataly rollback` count the stop once the hub has ended.
- An OMP that is slow to exit after end of input on a loaded host no longer fails the OMP probe
  when it ends at TERM; only a failed exit or one that needs KILL does. At hub shutdown each lane
  now gets the same 27 s as the lead, so a slow exit keeps its full TERM grace before any KILL.
- Voice no longer fails and holds itself right after a pass to the lead with "provider error
  unknown_parameter: Unknown parameter: 'delegation_id'". Continuing the backend after a tool
  result sent `delegation_id` on `response.create`, which takes only `type` and `event_id`. The
  fake realtime server in the tests now rejects every field the Live API does not document for an
  event, with the API's error shape.
- Lead replies are now spoken in a live call, and a quiet call closes after the idle time. The
  provider streams output audio all the time, silence included, and every chunk counted as
  output, so voice never saw a pause: no reply piece was offered and idle close never came. Only
  audible audio (at or above -55 dBFS) now counts as output.
- After a provider failure or a voice cap, the summary post says what the owner and the
  assistant said and what the tools did, instead of only "no summary: the session failed". No
  model call is made, and voice stays held until `cataly voice restart`.
- A quiet owner no longer logs "voice receive stalled; stream restarted" every 10 to 15 s. Discord
  sends no audio during silence and reports speaking once, so silence was taken for a stall; a
  stall is now owner audio that keeps arriving but does not decode.

## 0.2.3 (2026-11-27)

- `cataly update` and `cataly rollback` no longer report a stopping hub as held. A hub that
  accepts the orderly stop now writes its acceptance before it begins to stop; before, a hub
  that stopped quickly could close the connection first, and the update said "held: the hub did
  not stop ... nothing changed" while the hub ended and was not started again. A connection
  closed without an answer now counts as a stop only once the hub has ended within the minute,
  and the new hub is started only once the old one has released its lock.
- Installing or updating with `install.sh` no longer fails when Linux briefly refuses to start
  the staged binary for its version report ("Text file busy"); the start is retried for up to
  1 s.
- A lead in a Tern terminal no longer has a message put in doubt ("the bridge did not answer
  deliver within 10 s") when its session starts or compacts while a message is on its way. The
  hub handed the lead its recap on the bridge connection itself and read nothing more from it
  until then, so the bridge's answer waited behind a recap that waited for that answer. Seen on
  the first message after a start on slow Intel Macs.

## 0.2.2 (2026-11-26)

- The source and the releases now live together in vntrevx/Cataly.
- Releases for macOS and Linux on arm64 and x64: `linux-x64`, `linux-arm64`, `darwin-arm64`
  (Apple Silicon) and `darwin-x64` (Intel Macs). `install.sh`, `cataly update` and the npm and
  Bun packages (`cataly-<target>`) pick the binary for the host. Windows is not supported.
- On macOS, `cataly setup` makes a launchd agent (`~/Library/LaunchAgents/dev.cataly.hub.plist`)
  where Linux gets a systemd user unit.
- The store's bundled SQLite is 3.54 (rusqlite 0.41), past RUSTSEC-2026-0459.
- Cataly sends no telemetry. The opt-in usage counts and the `[usage]` config table are gone; a
  config that still has a `[usage]` table is refused, so delete it.

## 0.2.1 (2026-11-26)

- Cataly is now open source under AGPL-3.0-only, with commercial licences available from vntrevx;
  the source is public at https://github.com/vntrevx/cataly-core.
- The quota gate holds new sessions only, as documented. Resuming an existing session no longer
  waits for it: the lead's last session and parked or live lanes come back after a hub restart,
  `cataly update` or `cataly rollback`, and `cataly lead start` without `--fresh` resumes. A
  fresh lead (`lead start --fresh`, or a first lead with no session yet) and new lanes still wait.
- When the gate holds the lead, the hub says so: the `lead.refused` alert, `cataly lead start`,
  `cataly lead status`, the ops panel, the `cataly update` line and the update message (Korean
  and English) name the provider, the limits with their reset times and `cataly quota lift`.
- `cataly update` and the update message no longer wait out the full minute when the hub does
  not start the lead: a refused start is reported at once with its reason, and a hub that does
  not answer in time is reported instead of said nothing about.

## 0.2.0 (2026-11-26)

The first public release. Releases now come from `github.com/vntrevx/Cataly`, for Linux x64
(macOS arm64 follows once its build is published).

- Install with npm or Bun as well as `install.sh`: `npm install --global cataly` or
  `bun add --global cataly`. The package runs the same binary; the hub links its OMP extension
  when it starts, and `cataly setup` makes the user service as before.
- `cataly update` on an npm or Bun install updates through that package manager, with the same
  ordered stop, restart, wait and lead resume as an `install.sh` install; if the new version does
  not come up, the earlier one is installed again. The service it runs keeps working across
  upgrades. `cataly rollback` and `cataly uninstall` say which package-manager command to use.
- `install.sh`, `cataly update`, `cataly check` and the daily release notice take the newest
  stable Cataly release: prereleases, drafts and other software's releases in the repository are
  skipped, and a release without this host's files is refused with its name and what it lacks.
- Everything from 0.1.x carries over: one-command `cataly setup`, the lead and lanes resuming
  across updates and restarts, the `#cataly-ops` status panel and alerts, watch jobs, Discord,
  Telegram and Slack rooms, and Discord voice.

## 0.1.5 (2026-11-26)

- A held provider that no live session uses no longer turns the ops panel amber, and its spent
  limit no longer counts as a high limit: with nothing else wrong the panel is green, with the
  held-provider line and the per-provider ⛔ marks still shown.
- A usage limit turns the panel amber only at 90 % or more, not 70 %. `[quota] levels` alerts
  are unchanged.

## 0.1.4 (2026-11-26)

- The ops panel, `cataly limits` and quota events name every provider as OMP reports it, an
  extension provider such as `devin` included, instead of "unknown".
- The panel's session count includes the lead, and the `max_sessions` check on a lane start now
  counts the lead too, so both use the same number.
- A held provider that no live session uses turns the panel amber, not red, and a line under the
  summary names the held providers and says sessions on other providers start normally. The
  panel turns red when a live session's provider is held or the lead is held.
- The panel says when it was last updated as a relative time under the summary; the footer shows
  the version with the update time beside it.

## 0.1.3 (2026-11-26)

- The ops panel tries again to pin itself when a pin fails: right after the hub starts, then at
  most once an hour until it works, so granting the bot Pin Messages later is enough. While the
  bot may not pin, the panel footer says so. Once pinned, an unpin by hand is left alone until the
  hub restarts.
- A failed OMP probe is tried again by itself after 5 s, 15 s and 45 s, then every 5 minutes,
  instead of waiting until the OMP executable changes. Just after an OMP update the first start
  can take longer than the probe allows; the lead now starts as soon as a later probe works.
  `cataly status` and `cataly health` say when the next try runs.
- The limits a Discord form checks (number ranges, text lengths, required fields) are worded in
  your language (`[hub] language`), in the Fill in placeholder, a refused Fill in and a refused
  Submit, like the rest of the question card.
- Voice over WebRTC no longer stops at the start of a call. Setting up a WebRTC session takes the
  provider a few seconds, and voice used to give up as soon as more than 3 s of your audio was
  waiting; it now keeps the newest 3 s until the session is up and sends them then.
- `cataly update` and `cataly rollback` rewrite the user service Cataly created (systemd unit or
  launchd agent) with the definition of the version they switch to, and have the service manager
  read it again before they start the hub, so a new definition (such as the single malloc arena)
  needs no `cataly service enable`. The new `cataly service refresh` does this; a version from
  before it keeps the definition as it is.

## 0.1.2 (2026-11-26)

- The lead resumes after an update or restart even when its session was started in another folder
  than today's default: it reopens in the folder its session recorded. OMP's per-session folder
  next to the session file never blocks a resume.
- The message after an update and the `cataly update` line say how the lead came back: resumed, or
  started fresh with the reason. Lanes that run again are named.
- `#cataly-ops` is a status panel instead of a stream of one-line notices: one pinned embed in
  your language with the host, usage per provider, the lead and lanes, job health and the last
  three events, edited in place at most once a minute. Owner-only buttons refresh it, show the
  full usage table and mute alerts for an hour. Alerts are separate small posts only for what is
  worth a ping (the host over the alert level for five minutes, a quota hold, a job failing twice,
  a refused backup, GitHub news, new mail), at most one per kind an hour, edited to "resolved"
  when the condition clears. `[ops]` sets the room, the mute length and which alerts post.
- The pressure job raises its alert after five minutes over the line, and ready, busy and alert
  states change only once the load crosses back 10 points, so a load near a line no longer
  flips them every tick.
- Setup also gives the Discord application Cataly's avatar as its icon, under the same rule as
  the bot's images: an icon you set yourself is kept until `cataly setup --profile`.
- No more approval requests for Cataly's own tools: the lead and lanes call them directly, and
  OMP runs them without asking. A shell line that names them is refused at once with a pointer
  to the direct call, instead of asking you.
- Approvals follow your own OMP settings (decision 19): Cataly no longer forces OMP's
  `always-ask` and keeps no list of its own, so OMP asks exactly when your OMP configuration (or
  its default) says so. Read-only shell commands run without a prompt under OMP's default, and
  every dialog OMP does open still reaches you in Discord.
- The Discord approval card speaks your language (`[hub] language`): "권한 요청", the tool and the
  command in a code block, long commands cut cleanly, buttons "이번만 허용" / "거부".
- On a Discord question card, the option OMP marks as recommended says so in your language
  ("(추천)" or "(recommended)") on its button or menu option and in the card text; a long option
  is cut to fit, never the mark. Nothing is added when OMP recommends none.
- Typed answers to question cards: the hints and replies around them follow your language, and a
  card with several questions or fields takes a typed reply to one question's part (or to the
  only part still open), as an option number, a label or, where OMP allows, your own text; the
  other parts stay open and the menus still work.
- Setup's Discord invite asks for Pin Messages, so the ops panel can pin its message; without it
  the panel still posts and edits in place, unpinned.

## 0.1.1 (2026-11-26)

- One-command setup: `cataly setup` runs the whole first run (owner-only folders, the Discord
  steps, defaults, the home backup, the user service) after one summary and one yes; a re-run
  changes nothing, and a home backup you turned off stays off.
- Bot avatar and banner: setup gives the bot Cataly's images and keeps ones you set yourself.
- Per-provider quota gate: a provider near its quota holds only the work that uses it.
- The lead's tool is `cataly_lead`, so OMP's tool command no longer shadows the `cataly` CLI and
  the lead can record through it from its shell.
- Update notice: a newer release is announced once in your Discord home room, in your language
  (`[hub] language`, `ko` or `en`), with an optional `[update] template`.
- Plain `cataly update` works while the hub runs: it stops the hub in order (never a busy
  session; after 60 s it says which session it waits for), switches, starts the new hub the way
  the old one ran and switches back if it does not answer within 30 s. The lead and lanes resume
  on their own session files with their history and goals. `--no-restart` installs without
  touching the hub; `cataly rollback` restarts the same way.
- After an update or a rollback the hub says so once in your home room, with the sessions it
  resumed (`[update] updated_template` changes the update's wording).
