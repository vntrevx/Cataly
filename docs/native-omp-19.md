# Native OMP 19 port

The bound source moves from 18.20.0 (`c308970263ae13744ea15ab67302e3dac840e266`) to the exact `v19.0.0` tag commit [`57771ae562b9345e0579bceb2d68d585e3e6927e`](https://github.com/can1357/oh-my-pi/tree/57771ae562b9345e0579bceb2d68d585e3e6927e). The 18.22.2 work from Cataly #103 supplies the intermediate port audit, not a new dependency. The original 119 hunks across 34 files become 55 hunks across 18 files. Original-hunk dispositions are **20 kept, 23 ported, 76 dropped**. These count original hunks, not the differently partitioned regenerated diff.

[`native-omp.lock`](../native-omp.lock) is authoritative for version, exact upstream commit, patch digest, result tree, postimage hashes/modes and launcher. The separately frozen official addon and genuine SDK fixture are 19.0.0. No version-only receipt, stock executable, hash copied from the previous release, or Cargo build substitutes for these identities.

This is a maintainer review record, not an end-user installation guide. Cataly is the Dori agent-harness integration; OMP is its upstream agent host. The native overlay is Cataly's source patch. Bound source means the exact upstream commit plus patch, tree, launcher and addon are authenticated together; a postimage is a patched file's resulting bytes. The genuine SDK fixture is the published host package, not a test double. hc lanes are terminal-backed worker sessions; ULW is the bound agent workflow extension; ASK and voice are the existing form/message and audio adapters. Role receipts are session identity/state files. Retained installations and frozen controllers mean old releases kept for authenticated rollback, not upgraded in place.

## OMP 19 compatibility

The [pinned release notes](https://github.com/can1357/oh-my-pi/blob/57771ae562b9345e0579bceb2d68d585e3e6927e/packages/coding-agent/CHANGELOG.md#1900---2026-11-18) and checked source define the following migration.

| Change | Cataly handling |
| --- | --- |
| `createAgentSession.cacheWarming`: boolean to `off` / `streaming` / `idle` mode cap | Change the genuine required-source SDK fixture to `"off"`. Isolated runtime smoke disables warming explicitly; no user settings are rewritten. |
| `artifact://N` becomes `local://N.log` | No caller in Cataly runtime/extension/fixture sources. Preserve historical session text; upstream does not migrate old links. Do not rewrite saved transcripts. |
| `session.handoff(focus)` becomes `session.compact(focus, { mode: "handoff" })` | No Cataly SDK caller. Harness handoff checkpoint files are a different interface and remain unchanged. |
| One per-user daemon; `omp ps --json` becomes `{daemon, reports}`, `--global` removed | Cataly uses OS process identity and role receipts, not OMP process-report JSON. Older daemons are not adopted. Isolated homes/runtimes must not reuse the live installation's daemon state. |
| `deferSkillDescriptionCompression` / `startSkillDescriptionCompression` become `deferHintCompression` / `startHintCompression` | No Cataly caller. Published 19.0.0 declarations supply contributor typechecking. |
| Every back-to-back native wait uses 5s then 4m; reply waits can follow cache lifetime | Keep the upstream implementation and its new tests. Remove obsolete sole-call/eval ladder assumptions from local regressions. Preserve interruption and TUI/ACP behavior. |
| Todo requires a named task, `items`, or phase for done/drop/rm | Preserve upstream refusal of omitted targets and its `items` fallback. Retain empty-task-array protection when no items are supplied. Prompt and tests match this contract, not the historical whole-list fallback. |
| JS kernel recreation reports lost state | Assert the complete new notice on the first post-disposal call and its absence on the second; still require the old variable to be `undefined`. |
| ASK form and speech daemon changes | Keep Cataly's extension hooks, Discord ASK route and separate voice adapter; they are not native patch hunks. Local suites and isolated native smoke are distinct from a live Discord/voice round trip. |
| External OMP 19 / Ultrafast (#144) | Preserve explicit executable/model/config selection. The bound runtime is now also 19, but this change neither installs the Codex 500k extension nor selects a paid tier. Native `--goal` guidance applies to fresh 19 sessions; retained 18 installations keep their contract. |

The consumer protocol remains authenticated bound source, not a new manifest schema. The current controller reads retained 18.20.0 and stable 19.x bound releases plus the legacy 18.18.8 independent-native protocol. Unknown majors and prereleases are rejected. A stable 19.x stamp is eligibility for candidate review, not proof that upstream is compatible. Frozen old controllers retain their old version allowlists. On 19.x-to-18.20.0/18.18.8 rollback, omit the unreadable newer `previous` pointer while retaining authenticated sources, manifests and caches. This makes the restored controller launchable but removes that transition's immediate redo pointer; a current controller is needed for an explicit reinstall of 19. Same-generation rollback still toggles normally. No frozen controller bytes are rewritten.

## Structural reduction and upstream candidates

Every remaining hunk is general-purpose upstream material: **55 upstreamable, 0 safely replaceable by a public extension hook/config, 0 Dori-specific**. Documentation-only changes and equivalent comments were removed from the native overlay. The only Dori-specific native documentation, the extension-monitor versus native-job distinction, now lives in [runtime.md](runtime.md#omp-identity-goal-and-approval-records). Role selection, lane state, ASK, voice, monitors and ULW already live outside the native patch.

OMP 19 exposes `session_switch`, `session_clear`, `before_agent_start`, `tool_call`, `tool_result` and `registerTool` extension seams. They do not expose the SDK's retained per-conversation scan map, EvalRunner's in-flight transition/disposal ownership, grep's pre-filter native counts, or the built-in browser renderer. Replacing those with prompt rewriting, result guessing, duplicated native tools or a role-only guard would change non-Dori SDK and slash-command behavior. Those are not equivalent replacements. No new extension shim is introduced.

The patch text for the following upstream submissions is the corresponding full-index file sections of [`native-omp.patch`](../native-omp.patch), against the exact tag above. Split by the files listed in the remaining-hunk inventory and regenerate the viewer for its candidate; do not submit downstream lockfiles or this audit upstream. These are draft submission texts, not claims that an upstream PR has been opened.

- **fix(sdk): retain workspace invalidation while tree rendering is disabled.** Claim a fresh transcript boundary before asynchronous discovery, retain a scan-less invalidation entry for the conversation, and scan when rendering resumes. Preserve supplied trees and byte-stable same-transcript prompts. Include context-file reload regressions covering clear/new, switching and disabled/supplied trees.
- **fix(eval): wait for transition settlement before stale-owner disposal.** Wait for both active cells and session transitions, then synchronously select adopted/restored namespaces. Keep shared owners and disposal cancellation. Include Python/JS ownership, delayed transition, rollback and startup tests; the new kernel-loss notice is asserted exactly once.
- **fix(grep): report completeness for bounded line ranges.** Distinguish an exhausted native fetch cap from an exactly completed requested range using pre-filter per-file counts and every requested range end. Keep upstream multiline, total-cap and explicit-context semantics. Include pagination and path-list regressions.
- **fix(todo): reject empty target arrays without losing named items.** Resolve selected task objects once for done/drop/remove, keep upstream `items` targeting and omitted-target rejection, and prevent an empty task array from clearing a named phase. Include atomicity, exact-name precedence, duplicates, slash-command parity and parser/render tests. Align the model-facing prompt.
- **fix(collab): render todo target arrays in summaries and rows.** Keep valid partial-stream labels and scalar compatibility in both views. Include browser render tests and regenerate the HTML export viewer from the same source.
- **test(wait): cover top-window cancellation and message interruption.** Preserve delivery and reset behavior on OMP 19's uniform 5s/4m policy, including ACP versus actual interactive TUI semantics. No wait runtime override is proposed.

A conflict-free upgrade cannot be guaranteed while these source deltas remain. Stock external OMP is already an explicit override, not the authenticated default. Making it the default requires upstream adoption or equivalent public seams for the five correctness/rendering fixes (the sixth candidate adds wait tests only), stock-host regression parity, an explicit source-receipt/no-overlay migration, addon/export compatibility, and the same lane/monitor/ASK/voice/ULW checks. Preserve old authenticated caches and rollback; never silently treat a stock version stamp as the patched identity. The [native update plan](native-omp-updates.md) covers candidate automation rather than claiming these upstream decisions are finished.

## Original-hunk disposition

Original numbering and patch lines refer to `git show e6b60c9:native-omp.patch` in Cataly: this is the pre-port main commit bound to 18.20.0, not the intermediate 18.22.2 checkout. The first number is the line in that original patch; the range is its hunk header. Bare upstream commit IDs in the reasons belong to `can1357/oh-my-pi`. Kept retains local intent, ported reconciles it with changed upstream behavior, and dropped means upstream adoption/supersession or an explicitly removed documentation-only delta. No historical weakened assertion is carried over.

| Original hunk | File | Patch line / original range | Disposition | Reason |
| ---: | --- | --- | --- | --- |
| 1 | `docs/context-files.md` | 5 / `-184,6 +184,16` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 2 | `docs/tools/eval.md` | 26 / `-252,7 +252,7` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 3 | `docs/tools/grep.md` | 39 / `-29,7 +29,7` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 4 | `docs/tools/grep.md` | 48 / `-59,7 +59,7` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 5 | `docs/tools/grep.md` | 57 / `-98,7 +98,7` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 6 | `docs/tools/grep.md` | 66 / `-111,7 +111,7` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 7 | `docs/tools/grep.md` | 75 / `-148,11 +148,11` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 8 | `docs/tools/todo.md` | 93 / `-12,6 +12,8` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 9 | `docs/tools/todo.md` | 102 / `-21,10 +23,10` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 10 | `docs/tools/todo.md` | 117 / `-34,7 +36,7` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 11 | `docs/tools/todo.md` | 126 / `-42,6 +44,10` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 12 | `docs/tools/todo.md` | 137 / `-70,9 +76,9` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 13 | `docs/tools/todo.md` | 150 / `-100,7 +106,7` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 14 | `docs/tools/todo.md` | 159 / `-147,6 +153,7` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 15 | `docs/tools/todo.md` | 167 / `-164,7 +171,7` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 16 | `docs/tools/wait.md` | 180 / `-17,12 +17,13` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 17 | `docs/tools/wait.md` | 195 / `-33,3 +34,7` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 18 | `packages/coding-agent/CHANGELOG.md` | 207 / `-2,6 +2,17` | Dropped | Upstream release entries already cover adopted features; local edge cases are recorded here instead of rewriting historical releases. |
| 19 | `packages/coding-agent/src/eval/executor-base.ts` | 229 / `-442,6 +442,12` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 20 | `packages/coding-agent/src/eval/js/context-manager.ts` | 246 / `-16,6 +16,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 21 | `packages/coding-agent/src/eval/js/context-manager.ts` | 254 / `-122,6 +123,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 22 | `packages/coding-agent/src/eval/js/context-manager.ts` | 262 / `-426,11 +428,13` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 23 | `packages/coding-agent/src/eval/js/context-manager.ts` | 278 / `-439,7 +443,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 24 | `packages/coding-agent/src/eval/js/context-manager.ts` | 287 / `-702,6 +706,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 25 | `packages/coding-agent/src/eval/kernel-session-registry.ts` | 299 / `-4,6 +4,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 26 | `packages/coding-agent/src/eval/kernel-session-registry.ts` | 307 / `-39,6 +40,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 27 | `packages/coding-agent/src/eval/kernel-session-registry.ts` | 315 / `-93,7 +95,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 28 | `packages/coding-agent/src/eval/kernel-session-registry.ts` | 324 / `-208,6 +210,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 29 | `packages/coding-agent/src/eval/kernel-session-registry.ts` | 332 / `-363,11 +366,12` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 30 | `packages/coding-agent/src/eval/kernel-session-registry.ts` | 347 / `-375,7 +379,9` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 31 | `packages/coding-agent/src/eval/py/executor.ts` | 362 / `-9,6 +9,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 32 | `packages/coding-agent/src/eval/py/executor.ts` | 370 / `-576,8 +577,8` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 33 | `packages/coding-agent/src/export/html/viewer.generated.json` | 385 / `-1,5 +1,5` | Ported | Regenerate OMP 19 export viewer from retained browser todo-array rendering; no historical asset hash reused. |
| 34 | `packages/coding-agent/src/prompts/tools/todo.md` | 398 / `-1,5 +1,6` | Kept | Keep non-empty array/entry rules and single-start guidance visible to the model. |
| 35 | `packages/coding-agent/src/prompts/tools/wait.md` | 409 / `-4,4 +4,9` | Dropped | The conditional interactive/headless wait prompt is already upstream. |
| 36 | `packages/coding-agent/src/sdk.ts` | 423 / `-2067,9 +2067,9` | Dropped | Root-parameterized scanning is upstream. |
| 37 | `packages/coding-agent/src/sdk.ts` | 435 / `-2079,8 +2079,20` | Ported | Preserve upstream conversation snapshots but allow a retained entry without a scan to represent deferred invalidation. |
| 38 | `packages/coding-agent/src/sdk.ts` | 457 / `-4249,6 +4261,15` | Kept | Claim fresh-transcript invalidation before discovery awaits, even when tree rendering is disabled. |
| 39 | `packages/coding-agent/src/sdk.ts` | 473 / `-4391,15 +4412,29` | Ported | Reuse upstream per-conversation scans while honoring the retained invalidation sentinel and caller-supplied trees. |
| 40 | `packages/coding-agent/src/session/agent-session.ts` | 516 / `-1411,6 +1411,10` | Dropped | Upstream already tracks transcript epochs. |
| 41 | `packages/coding-agent/src/session/agent-session.ts` | 527 / `-1437,6 +1441,8` | Dropped | Upstream already requests stale release after transitions/rollback. |
| 42 | `packages/coding-agent/src/session/agent-session.ts` | 536 / `-2215,6 +2221,8` | Kept | Give EvalRunner both transition-state and transition-settlement accessors. |
| 43 | `packages/coding-agent/src/session/agent-session.ts` | 545 / `-7138,6 +7146,7` | Dropped | Upstream already increments the epoch on clear. |
| 44 | `packages/coding-agent/src/session/agent-session.ts` | 553 / `-7316,6 +7325,11` | Dropped | Upstream already exposes transcriptEpoch; do not restore the removed suppressAutoResumeUntilPrompt API from old context. |
| 45 | `packages/coding-agent/src/session/agent-session.ts` | 565 / `-12404,6 +12418,7` | Dropped | Upstream already increments the epoch on new. |
| 46 | `packages/coding-agent/src/session/eval-runner.ts` | 577 / `-1,6 +1,7` | Dropped | The namespaced JS session import is upstream; avoid a duplicate import. |
| 47 | `packages/coding-agent/src/session/eval-runner.ts` | 585 / `-25,6 +26,8` | Kept | Extend the host contract with transition quiescence. |
| 48 | `packages/coding-agent/src/session/eval-runner.ts` | 594 / `-42,6 +45,9` | Dropped | The disposal latch and serialized stale-release state are upstream. |
| 49 | `packages/coding-agent/src/session/eval-runner.ts` | 604 / `-175,10 +181,50` | Ported | Wait for both active cells and session transitions before selecting adopted namespaces; keep upstream disposal serialization and remove its superseded idle-only helper. |
| 50 | `packages/coding-agent/src/tools/grep.ts` | 659 / `-85,10 +85,10` | Dropped | The 10 multi-file / 50 single-file caps are upstream. |
| 51 | `packages/coding-agent/src/tools/grep.ts` | 672 / `-936,10 +936,24` | Kept | Distinguish exact bounded-range completion from native fetch-cap exhaustion. |
| 52 | `packages/coding-agent/src/tools/grep.ts` | 698 / `-961,7 +975,7` | Kept | Preserve correct range-filtered limitReached metadata. |
| 53 | `packages/coding-agent/src/tools/settings.ts` | 711 / `-488,7 +488,7` | Dropped | Zero before-context default is upstream. |
| 54 | `packages/coding-agent/src/tools/settings.ts` | 720 / `-507,7 +507,7` | Dropped | Zero after-context default is upstream. |
| 55 | `packages/coding-agent/src/tools/todo.ts` | 733 / `-5,6 +5,7` | Dropped | Shared task-target parser import is upstream. |
| 56 | `packages/coding-agent/src/tools/todo.ts` | 741 / `-59,7 +60,7` | Ported | Upstream already accepts task arrays; retain the precise single-target start description instead of implying every array is forbidden for start. |
| 57 | `packages/coding-agent/src/tools/todo.ts` | 750 / `-284,6 +285,16` | Ported | Port the shared resolver onto upstream 19 and return TodoItem objects directly; phase-bearing hits are unnecessary for shared removal. |
| 58 | `packages/coding-agent/src/tools/todo.ts` | 767 / `-295,10 +306,12` | Ported | Preserve upstream named items and omitted-target refusal; reject an explicit empty task array only when no items are supplied. |
| 59 | `packages/coding-agent/src/tools/todo.ts` | 783 / `-387,20 +400,9` | Ported | Use the same validated target set for done/drop/remove while preserving upstream 19 named items and omitted-target errors. |
| 60 | `packages/coding-agent/src/tools/todo.ts` | 806 / `-410,7 +412,12` | Dropped | Exactly-one start resolution and error handling are upstream. |
| 61 | `packages/coding-agent/src/tools/todo.ts` | 820 / `-698,9 +705,9` | Kept | Retain the operation-level atomicity comment; the old batch wording is inaccurate for the retained single-operation API. |
| 62 | `packages/coding-agent/src/tools/wait.ts` | 837 / `-25,9 +25,13` | Dropped | OMP 19 supersedes the local ladder with uniform 5s/4m job waits and cache-lifetime reply waits; keep its implementation. |
| 63 | `packages/coding-agent/src/tools/wait.ts` | 853 / `-142,13 +146,42` | Dropped | OMP 19 retains elapsed-report guidance but removes the obsolete sole-top-level-call detector. |
| 64 | `packages/coding-agent/src/tools/wait.ts` | 902 / `-163,7 +196,8` | Dropped | OMP 19 documents uniform back-to-back wait escalation; the sole-call documentation is superseded. |
| 65 | `packages/coding-agent/src/tools/wait.ts` | 912 / `-176,7 +210,7` | Dropped | Upstream already renders the description per session. |
| 66 | `packages/coding-agent/src/tools/wait.ts` | 921 / `-185,11 +219,19` | Dropped | Upstream already derives end-turn behavior from tuiTranscript. |
| 67 | `packages/coding-agent/src/tools/wait.ts` | 943 / `-256,6 +298,7` | Dropped | OMP 19 no longer needs toolCallId for the removed sole-call detector; retain its current blocking-wait signature. |
| 68 | `packages/coding-agent/src/tools/wait.ts` | 951 / `-273,6 +316,7` | Dropped | The old toolCallId argument supported sole-call detection, which OMP 19 supersedes with uniform escalation. |
| 69 | `packages/coding-agent/src/tools/wait.ts` | 959 / `-287,7 +331,11` | Dropped | OMP 19 starts at 5s and takes the top window for every back-to-back idle wait, not only a sole top-level call. |
| 70 | `packages/coding-agent/src/tools/wait.ts` | 972 / `-411,7 +459,7` | Dropped | Upstream already gives owned-job waits the proper continuation guidance. |
| 71 | `packages/coding-agent/src/tools/wait.ts` | 981 / `-421,8 +469,8` | Dropped | Upstream already gives reply/service waits the proper continuation guidance. |
| 72 | `packages/coding-agent/test/agent-session-context-file-reload.test.ts` | 996 / `-10,8 +10,10` | Ported | Keep the new settings override import; upstream already imports WorkspaceTree. |
| 73 | `packages/coding-agent/test/agent-session-context-file-reload.test.ts` | 1007 / `-29,27 +31,35` | Dropped | The reload-session options/helper refactor is upstream. |
| 74 | `packages/coding-agent/test/agent-session-context-file-reload.test.ts` | 1056 / `-59,6 +69,24` | Dropped | The reload-session cleanup helper is upstream; avoid duplicate session declarations. |
| 75 | `packages/coding-agent/test/agent-session-context-file-reload.test.ts` | 1081 / `-81,8 +109,28` | Dropped | The tree-session setup helper is upstream. |
| 76 | `packages/coding-agent/test/agent-session-context-file-reload.test.ts` | 1112 / `-141,3 +189,266` | Ported | Retain upstream snapshot tests and extend with byte equality, disabled-rendering clear/new invalidation, and supplied/disabled-tree regressions. |
| 77 | `packages/coding-agent/test/agent-session-python-cleanup.test.ts` | 1383 / `-3,13 +3,22` | Ported | Keep JS execution/snapshot and tool types; reuse upstream ExtensionFactory import. |
| 78 | `packages/coding-agent/test/agent-session-python-cleanup.test.ts` | 1406 / `-167,6 +176,34` | Kept | Add JS-cell, namespace-snapshot, and event-loop turn helpers. |
| 79 | `packages/coding-agent/test/agent-session-python-cleanup.test.ts` | 1441 / `-761,4 +798,403` | Ported | Retain lifetime/race regressions and assert the new OMP 19 kernel-restart notice exactly once, followed by clean state. |
| 80 | `packages/coding-agent/test/eval/context-manager-startup.test.ts` | 1849 / `-2,6 +2,7` | Kept | Import owner-scoped VM disposal for lifetime tests. |
| 81 | `packages/coding-agent/test/eval/context-manager-startup.test.ts` | 1857 / `-91,6 +92,88` | Kept | Gate a real isolated worker startup using explicit synchronization. |
| 82 | `packages/coding-agent/test/eval/context-manager-startup.test.ts` | 1946 / `-149,4 +232,54` | Ported | Retain lifetime/race regressions and assert the new OMP 19 kernel-restart notice exactly once, followed by clean state. |
| 83 | `packages/coding-agent/test/eval/kernel-session-registry.test.ts` | 2005 / `-573,3 +573,189` | Kept | Cover owner-scoped lifetime, overlapping startup/disposal, and retained-session ownership. |
| 84 | `packages/coding-agent/test/tools/grep-pagination.test.ts` | 2199 / `-43,36 +43,95` | Ported | Retain stronger result metadata and explicit-context/override tests on upstream lowered caps. |
| 85 | `packages/coding-agent/test/tools/grep-pagination.test.ts` | 2303 / `-80,30 +139,71` | Ported | Add bounded-range completeness and overflow assertions; reuse upstream byte-cap fixtures. |
| 86 | `packages/coding-agent/test/tools/grep-pagination.test.ts` | 2387 / `-111,21 +211,21` | Ported | Keep explicit-context byte-cap pagination fixtures and original notice assertions against upstream caps. |
| 87 | `packages/coding-agent/test/tools/grep-pagination.test.ts` | 2417 / `-133,13 +233,19` | Kept | Assert caller total-limit metadata without misleading file pagination. |
| 88 | `packages/coding-agent/test/tools/grep-pagination.test.ts` | 2441 / `-147,6 +253,41` | Ported | Retain native-total lower bounds and multiline partial-coverage checks alongside upstream pagination assertions. |
| 89 | `packages/coding-agent/test/tools/grep-path-lists.test.ts` | 2488 / `-127,7 +127,11` | Ported | Retain explicit before/after context through the existing session settings overlay. |
| 90 | `packages/coding-agent/test/tools/todo.test.ts` | 2505 / `-5,6 +5,8` | Kept | Import command-helper and committed-state seams for transaction tests. |
| 91 | `packages/coding-agent/test/tools/todo.test.ts` | 2514 / `-56,7 +58,7` | Dropped | Do not carry the historical generic toThrow assertion; retain the exact upstream internal-scheme error assertion. |
| 92 | `packages/coding-agent/test/tools/todo.test.ts` | 2523 / `-408,6 +410,347` | Ported | Keep atomic target regressions; adopt upstream 19 refusal of unqualified whole-list operations and test its items fallback with unused empty task arrays. |
| 93 | `packages/coding-agent/test/tools/todo.test.ts` | 2871 / `-436,9 +779,7` | Dropped | Do not carry the historical relaxed duplicate-phase assertion; retain exact upstream error text. |
| 94 | `packages/coding-agent/test/tools/todo.test.ts` | 2882 / `-492,7 +833,7` | Dropped | Do not carry the historical relaxed missing-list assertion; retain exact upstream error text. |
| 95 | `packages/coding-agent/test/tools/todo.test.ts` | 2891 / `-554,7 +895,6` | Dropped | Do not remove upstream invalid-argument error assertion. |
| 96 | `packages/coding-agent/test/tools/todo.test.ts` | 2899 / `-578,7 +918,7` | Dropped | Do not carry the historical relaxed missing-items assertion; retain exact upstream error text. |
| 97 | `packages/coding-agent/test/tools/todo.test.ts` | 2908 / `-680,6 +1020,60` | Kept | Keep array/recovered-list touched-phase and exact-name render tests. |
| 98 | `packages/coding-agent/test/tools/todo.test.ts` | 2969 / `-731,6 +1125,42` | Kept | Keep plural, partial-array, and sanitized singleton preview tests. |
| 99 | `packages/coding-agent/test/tools/wait.test.ts` | 3016 / `-5,6 +5,7` | Dropped | Message import is upstream. |
| 100 | `packages/coding-agent/test/tools/wait.test.ts` | 3024 / `-22,16 +23,29` | Dropped | Extended session/context test helpers are upstream. |
| 101 | `packages/coding-agent/test/tools/wait.test.ts` | 3055 / `-149,21 +163,21` | Dropped | OMP 19 owns uniform-backoff and headless-guidance tests; keep its new expectations instead of the old multi-rung ladder. |
| 102 | `packages/coding-agent/test/tools/wait.test.ts` | 3084 / `-189,6 +203,64` | Ported | Drop superseded sole-call/eval ladder assumptions: OMP 19 always uses 5s then 4m. Retain explicit TUI-versus-ACP/headless coverage. |
| 103 | `packages/coding-agent/test/tools/wait.test.ts` | 3149 / `-299,18 +371,23` | Ported | Keep cancellation/message interruption and floor-reset assertions on upstream 19 uniform backoff; remove obsolete latest-turn detection fixtures. |
| 104 | `packages/coding-agent/test/tools/wait.test.ts` | 3176 / `-412,15 +489,25` | Ported | Keep cancellation/message interruption and floor-reset assertions on upstream 19 uniform backoff; remove obsolete latest-turn detection fixtures. |
| 105 | `packages/coding-agent/test/tools/wait.test.ts` | 3204 / `-431,6 +518,7` | Ported | Keep cancellation/message interruption and floor-reset assertions on upstream 19 uniform backoff; remove obsolete latest-turn detection fixtures. |
| 106 | `packages/coding-agent/test/tools/wait.test.ts` | 3212 / `-875,13 +963,20` | Dropped | Upstream 19 owns reply backoff and cache-lifetime tests; preserve them instead of restoring obsolete sole-call assertions. |
| 107 | `packages/collab-web/CHANGELOG.md` | 3241 / `-2,6 +2,10` | Dropped | Keep upstream historical release notes unchanged; record retained viewer behavior in this port report. |
| 108 | `packages/collab-web/src/tool-render/tools/todo.tsx` | 3256 / `-53,6 +53,15` | Kept | Keep scalar/partial-array label normalization. |
| 109 | `packages/collab-web/src/tool-render/tools/todo.tsx` | 3272 / `-67,7 +76,7` | Kept | Use array-aware labels in the collapsed summary. |
| 110 | `packages/collab-web/src/tool-render/tools/todo.tsx` | 3281 / `-87,7 +96,7` | Kept | Use array-aware labels in expanded operation rows. |
| 111 | `packages/collab-web/test/tool-view.test.tsx` | 3294 / `-227,6 +227,62` | Kept | Cover array, scalar, legacy, and partial-stream browser todo previews. |
| 112 | `packages/tui/CHANGELOG.md` | 3361 / `-2,6 +2,10` | Dropped | Upstream already ships multi-target todo rendering; do not rewrite its historical release notes. |
| 113 | `packages/tui/src/tools/todo.ts` | 3376 / `-126,6 +126,53` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 114 | `packages/tui/src/tools/todo.ts` | 3430 / `-235,7 +282,7` | Dropped | The scalar-or-array renderer argument type is upstream. |
| 115 | `packages/tui/src/tools/todo.ts` | 3439 / `-259,6 +306,25` | Dropped | Remove documentation/comment-only overlay; downstream behavior and operating notes are recorded in this audit, not patched into upstream prose. |
| 116 | `packages/tui/src/tools/todo.ts` | 3465 / `-424,8 +490,8` | Dropped | Shared parser-based touched-phase selection is upstream. |
| 117 | `packages/tui/src/tools/todo.ts` | 3476 / `-540,18 +606,7` | Dropped | Shared text preview descriptions are upstream. |
| 118 | `packages/tui/src/tools/todo.ts` | 3496 / `-735,14 +790,7` | Dropped | Shared native preview descriptions are upstream. |
| 119 | `packages/tui/test/todo-targets.test.ts` | 3517 / `-0,0 +1,58` | Kept | Keep exact-name, delimiter, quoting, empty-entry, and partial-list parser regressions. |

## Every remaining hunk

All rows are upstream candidates (U); none is an extension replacement (E) or Dori-only patch (D). Numbering and ranges refer to the regenerated `native-omp.patch`; the number after each file is its one-based hunk index and Purpose maps it to the submission draft above; the generated viewer belongs to the browser-rendering change, not an independent feature.

| Hunk | File / file hunk | Range | Class | Purpose |
| ---: | --- | --- | --- | --- |
| 1 | `packages/coding-agent/src/export/html/viewer.generated.json` / 1 | `-1,5 +1,5` | U | Browser todo rendering |
| 2 | `packages/coding-agent/src/prompts/tools/todo.md` / 1 | `-1,5 +1,6` | U | Todo target atomicity |
| 3 | `packages/coding-agent/src/sdk.ts` / 1 | `-2152,7 +2152,6` | U | Workspace snapshot invalidation |
| 4 | `packages/coding-agent/src/sdk.ts` / 2 | `-2161,10 +2160,10` | U | Workspace snapshot invalidation |
| 5 | `packages/coding-agent/src/sdk.ts` / 3 | `-4449,6 +4448,15` | U | Workspace snapshot invalidation |
| 6 | `packages/coding-agent/src/sdk.ts` / 4 | `-4592,27 +4600,19` | U | Workspace snapshot invalidation |
| 7 | `packages/coding-agent/src/session/agent-session.ts` / 1 | `-2280,6 +2280,8` | U | Eval transition ownership |
| 8 | `packages/coding-agent/src/session/eval-runner.ts` / 1 | `-26,6 +26,8` | U | Eval transition ownership |
| 9 | `packages/coding-agent/src/session/eval-runner.ts` / 2 | `-183,14 +185,8` | U | Eval transition ownership |
| 10 | `packages/coding-agent/src/session/eval-runner.ts` / 3 | `-198,10 +194,15` | U | Eval transition ownership |
| 11 | `packages/coding-agent/src/session/eval-runner.ts` / 4 | `-237,14 +238,6` | U | Eval transition ownership |
| 12 | `packages/coding-agent/src/tools/grep.ts` / 1 | `-1024,10 +1024,24` | U | Bounded grep completeness |
| 13 | `packages/coding-agent/src/tools/grep.ts` / 2 | `-1051,7 +1065,7` | U | Bounded grep completeness |
| 14 | `packages/coding-agent/src/tools/todo.ts` / 1 | `-60,7 +60,7` | U | Todo target atomicity |
| 15 | `packages/coding-agent/src/tools/todo.ts` / 2 | `-286,17 +286,13` | U | Todo target atomicity |
| 16 | `packages/coding-agent/src/tools/todo.ts` / 3 | `-316,8 +312,12` | U | Todo target atomicity |
| 17 | `packages/coding-agent/src/tools/todo.ts` / 4 | `-407,20 +407,10` | U | Todo target atomicity |
| 18 | `packages/coding-agent/src/tools/todo.ts` / 5 | `-724,9 +714,9` | U | Todo target atomicity |
| 19 | `packages/coding-agent/test/agent-session-context-file-reload.test.ts` / 1 | `-10,6 +10,7` | U | Workspace snapshot invalidation |
| 20 | `packages/coding-agent/test/agent-session-context-file-reload.test.ts` / 2 | `-189,13 +190,13` | U | Workspace snapshot invalidation |
| 21 | `packages/coding-agent/test/agent-session-context-file-reload.test.ts` / 3 | `-249,7 +250,7` | U | Workspace snapshot invalidation |
| 22 | `packages/coding-agent/test/agent-session-context-file-reload.test.ts` / 4 | `-257,7 +258,85` | U | Workspace snapshot invalidation |
| 23 | `packages/coding-agent/test/agent-session-context-file-reload.test.ts` / 5 | `-267,7 +346,6` | U | Workspace snapshot invalidation |
| 24 | `packages/coding-agent/test/agent-session-context-file-reload.test.ts` / 6 | `-306,6 +384,7` | U | Workspace snapshot invalidation |
| 25 | `packages/coding-agent/test/agent-session-context-file-reload.test.ts` / 7 | `-317,4 +396,58` | U | Workspace snapshot invalidation |
| 26 | `packages/coding-agent/test/agent-session-python-cleanup.test.ts` / 1 | `-3,6 +3,12` | U | Eval transition ownership |
| 27 | `packages/coding-agent/test/agent-session-python-cleanup.test.ts` / 2 | `-11,6 +17,8` | U | Eval transition ownership |
| 28 | `packages/coding-agent/test/agent-session-python-cleanup.test.ts` / 3 | `-168,6 +176,34` | U | Eval transition ownership |
| 29 | `packages/coding-agent/test/agent-session-python-cleanup.test.ts` / 4 | `-936,4 +972,406` | U | Eval transition ownership |
| 30 | `packages/coding-agent/test/eval/context-manager-startup.test.ts` / 1 | `-2,6 +2,7` | U | Eval transition ownership |
| 31 | `packages/coding-agent/test/eval/context-manager-startup.test.ts` / 2 | `-91,6 +92,88` | U | Eval transition ownership |
| 32 | `packages/coding-agent/test/eval/context-manager-startup.test.ts` / 3 | `-149,4 +232,57` | U | Eval transition ownership |
| 33 | `packages/coding-agent/test/eval/kernel-session-registry.test.ts` / 1 | `-586,3 +586,189` | U | Eval transition ownership |
| 34 | `packages/coding-agent/test/tools/grep-pagination.test.ts` / 1 | `-43,38 +43,95` | U | Bounded grep completeness |
| 35 | `packages/coding-agent/test/tools/grep-pagination.test.ts` / 2 | `-82,21 +139,57` | U | Bounded grep completeness |
| 36 | `packages/coding-agent/test/tools/grep-pagination.test.ts` / 3 | `-104,16 +197,13` | U | Bounded grep completeness |
| 37 | `packages/coding-agent/test/tools/grep-pagination.test.ts` / 4 | `-121,10 +211,7` | U | Bounded grep completeness |
| 38 | `packages/coding-agent/test/tools/grep-pagination.test.ts` / 5 | `-134,13 +221,11` | U | Bounded grep completeness |
| 39 | `packages/coding-agent/test/tools/grep-pagination.test.ts` / 6 | `-148,13 +233,19` | U | Bounded grep completeness |
| 40 | `packages/coding-agent/test/tools/grep-pagination.test.ts` / 7 | `-165,8 +256,41` | U | Bounded grep completeness |
| 41 | `packages/coding-agent/test/tools/grep-path-lists.test.ts` / 1 | `-127,11 +127,11` | U | Bounded grep completeness |
| 42 | `packages/coding-agent/test/tools/todo.test.ts` / 1 | `-5,6 +5,8` | U | Todo target atomicity |
| 43 | `packages/coding-agent/test/tools/todo.test.ts` / 2 | `-474,6 +476,364` | U | Todo target atomicity |
| 44 | `packages/coding-agent/test/tools/todo.test.ts` / 3 | `-746,6 +1106,60` | U | Todo target atomicity |
| 45 | `packages/coding-agent/test/tools/todo.test.ts` / 4 | `-797,6 +1211,42` | U | Todo target atomicity |
| 46 | `packages/coding-agent/test/tools/wait.test.ts` / 1 | `-198,17 +198,20` | U | Wait interruption coverage |
| 47 | `packages/coding-agent/test/tools/wait.test.ts` / 2 | `-322,18 +325,23` | U | Wait interruption coverage |
| 48 | `packages/coding-agent/test/tools/wait.test.ts` / 3 | `-435,15 +443,25` | U | Wait interruption coverage |
| 49 | `packages/coding-agent/test/tools/wait.test.ts` / 4 | `-454,6 +472,7` | U | Wait interruption coverage |
| 50 | `packages/coding-agent/test/tools/wait.test.ts` / 5 | `-998,7 +1017,7` | U | Wait interruption coverage |
| 51 | `packages/collab-web/src/tool-render/tools/todo.tsx` / 1 | `-53,6 +53,15` | U | Browser todo rendering |
| 52 | `packages/collab-web/src/tool-render/tools/todo.tsx` / 2 | `-67,7 +76,7` | U | Browser todo rendering |
| 53 | `packages/collab-web/src/tool-render/tools/todo.tsx` / 3 | `-87,7 +96,7` | U | Browser todo rendering |
| 54 | `packages/collab-web/test/tool-view.test.tsx` / 1 | `-227,6 +227,62` | U | Browser todo rendering |
| 55 | `packages/tui/test/todo-targets.test.ts` / 1 | `-0,0 +1,58` | U | Todo target atomicity |

## Reproduce and verify

Start with a clean private upstream checkout at the exact target. First apply Cataly's committed `native-omp.patch` with `git apply --index`; then install frozen upstream dependencies with `--ignore-scripts` and build/check the export viewer with `bun packages/collab-web/scripts/build-export-viewer.ts --write`. The resulting reviewed overlay is already staged before the capture command below; that command records it and does not apply or resolve it. New directories and tracked files must not be group/world writable; start with `umask 0022`. Do not repair permissions or regenerate assets in a live installed cache.

From Cataly's repository root, capture a reviewed sibling checkout:

```sh
bun scripts/update-native-omp.ts --checkout ../native-omp-upstream \
  --commit 57771ae562b9345e0579bceb2d68d585e3e6927e --version 19.0.0
```

The shared generator captures full-index patch bytes, result tree and postimage digests/modes, then admits the checkout before publishing metadata. Follow [CONTRIBUTING.md](../CONTRIBUTING.md#run-the-gates) for `umask 0022; bun run ci` with genuine fixtures. Verify a side installation in a new HOME, actual hc lane/Dori status and monitor delivery, and both locked ULW `code-mode-host-check` and `code-mode-task-host-check` scripts. Run every native test file retained in the inventory above. Runtime evidence must identify synthetic loopback providers separately from real provider or messenger behavior.

For performance, compare this candidate against the pre-port main checkout `e6b60c9` with bound 18.20.0, separate homes, the same Bun/host, and alternating measurements. Guarded `--version` startup time and GNU time peak RSS are not interactive-model latency or aggregate daemon memory. This document specifies contracts and source decisions; the PR evidence records actual command outcomes and limits.

The native regression command runs in that upstream checkout and covers the ten distinct test files present in the remaining-hunk inventory, not the entire upstream suite:

```sh
bun test packages/coding-agent/test/agent-session-context-file-reload.test.ts \
  packages/coding-agent/test/agent-session-python-cleanup.test.ts \
  packages/coding-agent/test/eval/context-manager-startup.test.ts \
  packages/coding-agent/test/eval/kernel-session-registry.test.ts \
  packages/coding-agent/test/tools/grep-pagination.test.ts \
  packages/coding-agent/test/tools/grep-path-lists.test.ts \
  packages/coding-agent/test/tools/todo.test.ts \
  packages/coding-agent/test/tools/wait.test.ts \
  packages/collab-web/test/tool-view.test.tsx \
  packages/tui/test/todo-targets.test.ts
```

Test gates require zero failures. The side wrapper must report the exact lock version after its identity guard passes; both lane roles must return to done, the monitor must deliver its event and disappear after stop, and both ULW host scripts must print their PASS results. The startup/RSS comparison is descriptive, with no pre-agreed performance pass threshold: report observed regressions rather than declaring performance parity.
