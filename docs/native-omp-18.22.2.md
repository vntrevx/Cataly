# Native OMP 18.22.2 port

The native source bundle moves from OMP 18.20.0 (`c308970263ae13744ea15ab67302e3dac840e266`) to the exact 18.22.2 tag commit `e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63`. The original overlay contained 119 hunks across 34 files. This review keeps 37 hunks, drops 58, and ports 24. A ported hunk can contain an upstream-adopted part plus a remaining local delta; the categories are mutually exclusive and count original hunks, not regenerated diff blocks.

The resulting overlay changes 24 files. Most runtime implementations are now upstream: conversation snapshots, owner-scoped eval disposal, 10/50 grep caps with zero default context, multi-target todo parsing/rendering, and cache-bounded sole-call wait backoff. The remaining runtime deltas preserve disabled-tree invalidation, transition/rollback quiescence during stale eval release, bounded grep coverage metadata, invalid-empty-array todo semantics, and browser todo array labels. Additional regression coverage remains local.

Upstream adoption provenance: [conversation snapshots](https://github.com/can1357/oh-my-pi/commit/0086cba6a3a3e64710a6e2743f6c3b8141d19de6), [stale eval ownership](https://github.com/can1357/oh-my-pi/commit/6f4805278c062c7de4ccbb78467fa1db3a9d60dd), [eval session-switch settlement](https://github.com/can1357/oh-my-pi/commit/c0e44f297b8bf6b363695fa29e24304fa21b5b84), [grep defaults/caps](https://github.com/can1357/oh-my-pi/commit/53058a755ced2a9e311f9d8cefe78b6220a9b318), [todo task arrays](https://github.com/can1357/oh-my-pi/commit/f87959c6a687c250f4bace151c1ed91a49fbdef2), and [wait backoff](https://github.com/can1357/oh-my-pi/commit/545b727cdd9303b0596d9549a54d9896dd361cf5).

[`native-omp.lock`](../native-omp.lock) is the authoritative commit, patch digest, resulting tree, postimage digest/mode, version, and launcher record. [`native-omp.patch`](../native-omp.patch) contains the regenerated full-index diff. No old asset hash or lock hash is copied forward manually.

Both artifacts are regenerated and included in this change. This is a port audit, not a deployment checklist; the instructions below reproduce those artifacts. Paths are relative to this document in `docs/`, unless a command specifies the repository root. For Dori's session roles, ULW extension composition, and bound-source installation model, see the [README](../README.md) and [release protocol](releases.md).

## Upstream changes relevant to Dori

References below are pinned to the exact target commit, not a moving branch. The interval includes 18.20.1, 18.20.2, 18.20.3, 18.21.0, 18.22.0, 18.22.1, and 18.22.2; 18.20.0 itself is the baseline. Some 18.22.1 and 18.22.2 changelog entries overlap, so they are summarized once.

| Surface | Upstream changes and Dori implications | Sources |
| --- | --- | --- |
| SDK run lifecycle / extension state | **Breaking:** `AgentSession.agent_end` is final for a run; `agent_pause` means the run can resume. Replace `hasPendingAsyncWork()`, `settleAsyncWork()`, and `suppressAutoResumeUntilPrompt()` with `isRunActive`, `wakeSources`, and `waitForRunEnd()`. `abort()` also ends a paused run. RPC, JSON print, collaboration, and extension streams retain their existing per-loop `agent_end` semantics; do not apply SDK-final semantics indiscriminately to every transport. Dori lane completion and idle/working monitors must be exercised against their actual event source. | [18.21][c1821], [AgentSession][session] |
| RPC | Over-quota 429 bookkeeping is bounded so a terminal `agent_end` is delivered even when usage reporting stalls. RPC login warnings now reach the host as an `extension_ui_request` of method `input`; only `yes` continues risk-acknowledged login. Hosts must not auto-approve it. | [18.22.2][c18222] |
| Extension API / project scope | Adds `session_clear` without changing session ID. Active extension enable/disable changes load without restart; moving or resuming in another project rescopes agents, extensions, custom tools, and MCP servers. `ProviderModelConfig.reasoning` becomes optional for discovery; `acceptImages` also covers form-dialog option notes. Recheck exactly-once Dori/ULW composition and monitor ownership after reload/move. | [18.20.1][c18201], [18.21][c1821], [extension types][extensions] |
| Session persistence / resume | `CURRENT_SESSION_VERSION` remains 3; the source removes `SessionHeader.seanceSource`, the `forkFrom({ seance })` option, and `getSeanceSourceArtifactsDir()`. `SessionManager.isFromRemovedWorktree()` is renamed `isStrandedIn()`. `/continue` handles an unmaterialized empty session from a different cwd correctly; `/restart` re-execs through the original launcher. Existing session compatibility still needs a real continuation smoke, not just a version check. | [session entries][entries], [session manager][manager], [18.20.3][c18203], [18.22.2][c18222] |
| Task / subagent completion | Removes `seance`, `/seance`, and task `sourceSession`. Subagents retain inherited `@upstream` provider pinning; all `task.steps` progress is retained. Adds `task.agentPrewalkAuto`. Schema-less children have no `yield` tool and finish through their final message; empty `yield` only finalizes previously submitted incremental sections. Eval rejects direct/device `yield`. Long-lived child sessions use less CPU/memory, and completion waits for queued child/peer work. Audit completion prompts and the Dori task bridge, including JavaScript/Python eval calls. | [18.20.3][c18203], [18.21][c1821], [18.22][c1822], [18.22.2][c18222] |
| Eval / shell / tools | Linux in-place upgrades retain JS workers from the session's own build. Numeric eval waits are corrected. Overlapping bash calls share shell state at their supported execution boundaries; readiness regexes match line boundaries; `TZ` and slash-containing `rg --glob` work. `xd://` line selectors are corrected. `find` returns unranked literal matches when every judge request fails. Binary analysis moves from standalone `ida`/`ghidra` to `dsm`, with explicit backend setup and shared child database handles. Keep native-job admission separate from extension-managed monitors. | [18.20.3][c18203], [18.21][c1821], [18.22][c1822], [18.22.2][c18222] |
| Prompts / context / browser guidance | Browser task guidance arrives after the first browser call, with safety guidance before it and restoration after compaction/rewind. Native `apply_patch` instructions no longer incorrectly describe a shell command or ban absolute paths. TTSR adds per-rule `repeatMode`; large streamed write/edit arguments remain responsive. Workspace snapshots, task-array semantics, and wait guidance are reviewed individually in the table below. | [18.20.3][c18203], [18.22.1][c18221], [18.22.2][c18222] |
| Browser / computer | **Breaking:** `tab.clickAt({ clickCount })` becomes `count`; scaled screenshot coordinates use displayed image coordinates unless `css: true` is explicit. Children use isolated browser contexts by default rather than the user's browser. Adds mixed label/value/index selects and numeric `setValue`. Fixes stuck-busy calls, stale JS dialogs, modal-covered actions, relay frame interference, WebMCP discovery, WebKit first startup/shutdown, and partial computer output on failure. Browser smoke assumptions must match the new isolation and coordinate rules. | [18.20.3][c18203], [18.22.1][c18221], [18.22.2][c18222] |
| Authentication / provider routing | Adds Antigravity CLI, `auth.unpausedProviders`, and native Kiro login/usage. OAuth shutdown/cancellation no longer incorrectly depletes other sessions sharing an agent directory; broker refresh preserves routing metadata. Adds definitive OAuth failures, risk-acknowledgement metadata, and credential-specific usage reporting. These capabilities do not authorize account switching, credit redemption/reset, top-ups, overage, or quota evasion. | [18.20.1][c18201], [18.20.2][c18202], [AI 18.22.1][ai18221], [AI 18.22.2][ai18222] |
| Settings / cost-sensitive behavior | Adds `providers.webKeyless` (default on), path-scoped bash rules, `bash.allowedEnvVars` and per-rule `env`, `--no-judge`/`--no-spotlight`/`--offline`, memory recall relevance and embedding query options, `todo.midRunNudges`, `tui.renderEmbeds`, and configurable live endpoints/keys/voices. Spotlight's default thinking rises from low to med. Renames `ida.*` settings to `disassembler.*`; `worktree.onExit` gains Force Remove. Review explicit deployments rather than copying new defaults into Dori config. | [18.20.1][c18201], [18.20.3][c18203], [18.21][c1821], [18.22][c1822], [18.22.1][c18221] |
| Model/session replay / compaction | Automatic thinking-capability discovery is cached; registries share discovered-model builds. Claude receives reasoning from earlier non-Claude turns and has a refusal-recovery path; refusal text no longer contaminates later tool replay. Codex `partial_answer` phase is retained. Gateway compaction preserves configured headers, and custom APIs can explicitly opt into Anthropic remote compaction. Exercise sessions across reload/compaction and configured gateways. | [18.21][c1821], [18.22.2][c18222], [AI 18.22.1][ai18221], [agent-core 18.22.1][core18221] |
| Commit helper | **Breaking:** eval `commit` validates unknown/non-object options strictly. It runs configured hooks, handles empty selections/submodules/sparse checkouts more accurately, and rejects merge/rebase/cherry-pick/revert/am or unresolved-conflict states. Hook stdout and hook-modified subjects are preserved. Dori's no-commit/no-push policy remains an authorization boundary independent of helper availability. | [18.20.1][c18201], [18.22.1][c18221], [18.22.2][c18222] |

The source audit searched Dori's `src`, `extension`, and `test/fixtures/omp-native-host/host.ts` for `hasPendingAsyncWork`, `settleAsyncWork`, `suppressAutoResumeUntilPrompt`, `seanceSource`, `sourceSession`, `getSeanceSourceArtifactsDir`, `isFromRemovedWorktree`, and `clickCount`; none has a caller there. The concrete native integration adaptation is to wait for transition settlement before disposing stale eval namespaces, while preserving upstream's newer run lifecycle and removed API surface. ULW prompt/tool composition, lane completion, and monitor delivery are runtime verification surfaces, not inferred from clean patch application. The broader upstream behavior notes are deployment considerations, not claims that every upstream feature was exercised.

## Existing consumer compatibility boundary

This is a source-native pin bump, not a consumer protocol migration. Manifest and installed-state field shapes remain unchanged. The updated controller reads both older protocols, but frozen older controllers still enforce their own native-version allowlists.

The pre-existing gap was reproduced using unmodified production modules and release artifacts built from the exact committed trees: published `v0.1.2` (`f5d34ab98ad040a500689fbeefe507e54281eff3`, native 18.18.8) and pre-bump main (`49cc53c85c662b850caf7fc19f814763a19b6c83`, native 18.20.0). Each producer validated its own artifact; the v0.1.2 consumer also acquired its own complete artifact successfully. Both its `validateReleaseManifest(mainManifest)` and `acquireBundle(mainAssets)` rejected the 18.20.0 artifact with `Release requirements do not match the supported runtime`.

The [v0.1.2 exact-version check](https://github.com/vntrevx/omp-dori/blob/f5d34ab98ad040a500689fbeefe507e54281eff3/src/release/manifest.ts#L142-L156) predates [#56's addition of the 18.20.0 bound-source protocol](https://github.com/vntrevx/omp-dori/commit/0dc0a49378721ac4366b153d34654f31566783e0). Subsequent ULW updates changed commit/overlay identities while retaining native 18.20.0; they did not exercise this native-version boundary. The published v0.1.2 manifest still requires 18.18.8, not 18.20.0.

The same limitation applies to restoring a frozen controller whose installed state contains a later native version in `previous`. New-controller tests reading retained manifests are not evidence that old controllers can read future manifests. Cross-version consumer migration remains out of scope; this change adds neither a migration nor a new cross-version refusal.

## Port decisions and conflicts

Three-way application initially conflicted in 15 files: `docs/context-files.md`, `docs/tools/grep.md`, `docs/tools/wait.md`, the generated viewer manifest, SDK/session/eval-runner code, todo/wait tool code, context-reload/Python-cleanup/grep-pagination/grep-path-list/wait tests, and the shared TUI todo renderer. Conflicts are resolved in the staged overlay; no conflict markers or rejected hunks are intentional output.

- Keep upstream implementations where the feature landed; retain only the remaining edge-case delta or additional regression coverage.
- SDK snapshots retain invalidation even while layout rendering is disabled, and never replace a supplied tree. Stale eval release waits for active eval and in-progress session transitions before choosing the final adopted/restored session.
- Keep grep's upstream multiline/seen-row fixes while retaining bounded-range completeness metadata. Keep todo's upstream exact-name-first parsing and single-start behavior while making explicit empty target arrays errors for done/drop/remove.
- Keep upstream wait runtime and prompts rather than replacing its longer cache explanation. Retain the Dori monitor-admission boundary and stronger wait regressions.
- Preserve every upstream Python lifecycle test alongside the local cross-language tests. Drop all five historical todo assertion relaxations; retain upstream's exact error assertions.
- Regenerate the HTML export viewer after retaining browser todo array labels. Keep upstream historical changelogs unchanged; this document records the local port.

## Full original-hunk disposition

Each file section follows the original `native-omp.patch` order. `Patch line` locates the original hunk in the pre-upgrade patch; `Original range` is its full old/new unified-diff range. Kept means the local intent remains; ported means it was reconciled with a partial upstream implementation or changed context; dropped means upstream owns it, intentionally supersedes it, or the local change is no longer appropriate (historical release-note edits and weakened assertions). Retrieve the exact original patch with `git show 49cc53c:native-omp.patch` from the Dori repository.

### `docs/context-files.md`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 1 / file 1 | 5 | `-184,6 +184,16` | Ported | Keep disabled-rendering invalidation and caller-supplied tree details; upstream already documents ordinary snapshots. |

### `docs/tools/eval.md`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 2 / file 1 | 26 | `-252,7 +252,7` | Kept | Document transition/rollback quiescence and adopted/shared runtime preservation. |

### `docs/tools/grep.md`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 3 / file 1 | 39 | `-29,7 +29,7` | Kept | Keep explicit-context preservation guidance beyond upstream match-only defaults. |
| 4 / file 2 | 48 | `-59,7 +59,7` | Ported | Use upstream zero defaults; retain the original concise settings description. |
| 5 / file 3 | 57 | `-98,7 +98,7` | Dropped | The 10/50 caps and closing notices are upstream. |
| 6 / file 4 | 66 | `-111,7 +111,7` | Kept | Keep line-range recovery guidance for a capped single file. |
| 7 / file 5 | 75 | `-148,11 +148,11` | Ported | Use upstream cap constants and retain explicit nonzero-setting guidance. |

### `docs/tools/todo.md`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 8 / file 1 | 93 | `-12,6 +12,8` | Kept | Document shared parser and browser preview implementation locations. |
| 9 / file 2 | 102 | `-21,10 +23,10` | Kept | Document multiple targets and atomic task operations. |
| 10 / file 3 | 117 | `-34,7 +36,7` | Kept | Document scalar/array schema and exactly-one start. |
| 11 / file 4 | 126 | `-42,6 +44,10` | Kept | Document exact-name precedence, recovered lists, and empty-array errors. |
| 12 / file 5 | 137 | `-70,9 +76,9` | Kept | Document execution targeting and shared removal semantics. |
| 13 / file 6 | 150 | `-100,7 +106,7` | Kept | Distinguish an invalid explicit empty array from omitted targets. |
| 14 / file 7 | 159 | `-147,6 +153,7` | Kept | Document the multiple-start error. |
| 15 / file 8 | 167 | `-164,7 +171,7` | Kept | Document exact identifiers versus list recovery. |

### `docs/tools/wait.md`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 16 / file 1 | 180 | `-17,12 +17,13` | Dropped | Upstream owns the same 5s/10s/30s/1m/4m policy and TUI/headless guidance; keep its fuller cache explanation. |
| 17 / file 2 | 195 | `-33,3 +34,7` | Kept | Retain Dori extension-monitor versus native owned-job admission boundary. |

### `packages/coding-agent/CHANGELOG.md`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 18 / file 1 | 207 | `-2,6 +2,17` | Dropped | Upstream release entries already cover adopted features; local edge cases are recorded here instead of rewriting historical releases. |

### `packages/coding-agent/src/eval/executor-base.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 19 / file 1 | 229 | `-442,6 +442,12` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |

### `packages/coding-agent/src/eval/js/context-manager.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 20 / file 1 | 246 | `-16,6 +16,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 21 / file 2 | 254 | `-122,6 +123,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 22 / file 3 | 262 | `-426,11 +428,13` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 23 / file 4 | 278 | `-439,7 +443,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 24 / file 5 | 287 | `-702,6 +706,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |

### `packages/coding-agent/src/eval/kernel-session-registry.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 25 / file 1 | 299 | `-4,6 +4,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 26 / file 2 | 307 | `-39,6 +40,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 27 / file 3 | 315 | `-93,7 +95,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 28 / file 4 | 324 | `-208,6 +210,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 29 / file 5 | 332 | `-363,11 +366,12` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 30 / file 6 | 347 | `-375,7 +379,9` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |

### `packages/coding-agent/src/eval/py/executor.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 31 / file 1 | 362 | `-9,6 +9,7` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |
| 32 / file 2 | 370 | `-576,8 +577,8` | Dropped | Owner-scoped keepSessionId disposal, session identity, and shared ownership are already upstream (6f4805278c / c0e44f297b). |

### `packages/coding-agent/src/export/html/viewer.generated.json`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 33 / file 1 | 385 | `-1,5 +1,5` | Ported | Regenerate from the current 18.22.2 viewer plus retained browser todo labels; never reuse the old asset digest. |

### `packages/coding-agent/src/prompts/tools/todo.md`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 34 / file 1 | 398 | `-1,5 +1,6` | Kept | Keep non-empty array/entry rules and single-start guidance visible to the model. |

### `packages/coding-agent/src/prompts/tools/wait.md`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 35 / file 1 | 409 | `-4,4 +4,9` | Dropped | The conditional interactive/headless wait prompt is already upstream. |

### `packages/coding-agent/src/sdk.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 36 / file 1 | 423 | `-2067,9 +2067,9` | Dropped | Root-parameterized scanning is upstream. |
| 37 / file 2 | 435 | `-2079,8 +2079,20` | Ported | Preserve upstream conversation snapshots but allow a retained entry without a scan to represent deferred invalidation. |
| 38 / file 3 | 457 | `-4249,6 +4261,15` | Kept | Claim fresh-transcript invalidation before discovery awaits, even when tree rendering is disabled. |
| 39 / file 4 | 473 | `-4391,15 +4412,29` | Ported | Reuse upstream per-conversation scans while honoring the retained invalidation sentinel and caller-supplied trees. |

### `packages/coding-agent/src/session/agent-session.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 40 / file 1 | 516 | `-1411,6 +1411,10` | Dropped | Upstream already tracks transcript epochs. |
| 41 / file 2 | 527 | `-1437,6 +1441,8` | Dropped | Upstream already requests stale release after transitions/rollback. |
| 42 / file 3 | 536 | `-2215,6 +2221,8` | Kept | Give EvalRunner both transition-state and transition-settlement accessors. |
| 43 / file 4 | 545 | `-7138,6 +7146,7` | Dropped | Upstream already increments the epoch on clear. |
| 44 / file 5 | 553 | `-7316,6 +7325,11` | Dropped | Upstream already exposes transcriptEpoch; do not restore the removed suppressAutoResumeUntilPrompt API from old context. |
| 45 / file 6 | 565 | `-12404,6 +12418,7` | Dropped | Upstream already increments the epoch on new. |

### `packages/coding-agent/src/session/eval-runner.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 46 / file 1 | 577 | `-1,6 +1,7` | Dropped | The namespaced JS session import is upstream; avoid a duplicate import. |
| 47 / file 2 | 585 | `-25,6 +26,8` | Kept | Extend the host contract with transition quiescence. |
| 48 / file 3 | 594 | `-42,6 +45,9` | Dropped | The disposal latch and serialized stale-release state are upstream. |
| 49 / file 4 | 604 | `-175,10 +181,50` | Ported | Wait for both active cells and session transitions before selecting adopted namespaces; keep upstream disposal serialization and remove its superseded idle-only helper. |

### `packages/coding-agent/src/tools/grep.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 50 / file 1 | 659 | `-85,10 +85,10` | Dropped | The 10 multi-file / 50 single-file caps are upstream. |
| 51 / file 2 | 672 | `-936,10 +936,24` | Kept | Distinguish exact bounded-range completion from native fetch-cap exhaustion. |
| 52 / file 3 | 698 | `-961,7 +975,7` | Kept | Preserve correct range-filtered limitReached metadata. |

### `packages/coding-agent/src/tools/settings.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 53 / file 1 | 711 | `-488,7 +488,7` | Dropped | Zero before-context default is upstream. |
| 54 / file 2 | 720 | `-507,7 +507,7` | Dropped | Zero after-context default is upstream. |

### `packages/coding-agent/src/tools/todo.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 55 / file 1 | 733 | `-5,6 +5,7` | Dropped | Shared task-target parser import is upstream. |
| 56 / file 2 | 741 | `-59,7 +60,7` | Ported | Use the upstream array schema with clearer exactly-one-start description. |
| 57 / file 3 | 750 | `-284,6 +285,16` | Ported | Reuse the upstream resolver but return task objects directly for shared done/drop/remove targeting. |
| 58 / file 4 | 767 | `-295,10 +306,12` | Ported | Keep upstream multi-target parsing and reject an explicit empty array before phase/list fallback. |
| 59 / file 5 | 783 | `-387,20 +400,9` | Ported | Route remove through the shared target resolver so invalid empty arrays cannot clear a phase/list. |
| 60 / file 6 | 806 | `-410,7 +412,12` | Dropped | Exactly-one start resolution and error handling are upstream. |
| 61 / file 7 | 820 | `-698,9 +705,9` | Ported | Retain original atomic-target error explanation on upstream transactional persistence. |

### `packages/coding-agent/src/tools/wait.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 62 / file 1 | 837 | `-25,9 +25,13` | Dropped | Upstream already has sole-call backoff and the cache-bounded top rung. |
| 63 / file 2 | 853 | `-142,13 +146,42` | Dropped | Upstream already has elapsed-report guidance and top-level sole-call detection. |
| 64 / file 3 | 902 | `-163,7 +196,8` | Dropped | Upstream already documents sole-call backoff. |
| 65 / file 4 | 912 | `-176,7 +210,7` | Dropped | Upstream already renders the description per session. |
| 66 / file 5 | 921 | `-185,11 +219,19` | Dropped | Upstream already derives end-turn behavior from tuiTranscript. |
| 67 / file 6 | 943 | `-256,6 +298,7` | Dropped | Upstream already threads toolCallId into blocking wait. |
| 68 / file 7 | 951 | `-273,6 +316,7` | Dropped | Upstream already declares toolCallId in wait arguments. |
| 69 / file 8 | 959 | `-287,7 +331,11` | Dropped | Upstream already starts at 5s, then selects the top rung for a sole top-level call. |
| 70 / file 9 | 972 | `-411,7 +459,7` | Dropped | Upstream already gives owned-job waits the proper continuation guidance. |
| 71 / file 10 | 981 | `-421,8 +469,8` | Dropped | Upstream already gives reply/service waits the proper continuation guidance. |

### `packages/coding-agent/test/agent-session-context-file-reload.test.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 72 / file 1 | 996 | `-10,8 +10,10` | Ported | Keep the new settings override import; upstream already imports WorkspaceTree. |
| 73 / file 2 | 1007 | `-29,27 +31,35` | Dropped | The reload-session options/helper refactor is upstream. |
| 74 / file 3 | 1056 | `-59,6 +69,24` | Dropped | The reload-session cleanup helper is upstream; avoid duplicate session declarations. |
| 75 / file 4 | 1081 | `-81,8 +109,28` | Dropped | The tree-session setup helper is upstream. |
| 76 / file 5 | 1112 | `-141,3 +189,266` | Ported | Retain upstream snapshot tests and extend with byte equality, disabled-rendering clear/new invalidation, and supplied/disabled-tree regressions. |

### `packages/coding-agent/test/agent-session-python-cleanup.test.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 77 / file 1 | 1383 | `-3,13 +3,22` | Ported | Keep JS execution/snapshot and tool types; reuse upstream ExtensionFactory import. |
| 78 / file 2 | 1406 | `-167,6 +176,34` | Kept | Add JS-cell, namespace-snapshot, and event-loop turn helpers. |
| 79 / file 3 | 1441 | `-761,4 +798,403` | Ported | Append full Python/JS transition, shared-owner, rollback-race, and disposal regressions while preserving every upstream lifecycle test. |

### `packages/coding-agent/test/eval/context-manager-startup.test.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 80 / file 1 | 1849 | `-2,6 +2,7` | Kept | Import owner-scoped VM disposal for lifetime tests. |
| 81 / file 2 | 1857 | `-91,6 +92,88` | Kept | Gate a real isolated worker startup using explicit synchronization. |
| 82 / file 3 | 1946 | `-149,4 +232,54` | Kept | Cover retained live/starting namespaces, shared owners, and ordinary full disposal. |

### `packages/coding-agent/test/eval/kernel-session-registry.test.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 83 / file 1 | 2005 | `-573,3 +573,189` | Kept | Cover owner-scoped lifetime, overlapping startup/disposal, and retained-session ownership. |

### `packages/coding-agent/test/tools/grep-pagination.test.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 84 / file 1 | 2199 | `-43,36 +43,95` | Ported | Retain stronger result metadata and explicit-context/override tests on upstream lowered caps. |
| 85 / file 2 | 2303 | `-80,30 +139,71` | Ported | Add bounded-range completeness and overflow assertions; reuse upstream byte-cap fixtures. |
| 86 / file 3 | 2387 | `-111,21 +211,21` | Ported | Keep explicit-context byte-cap pagination fixtures and original notice assertions against upstream caps. |
| 87 / file 4 | 2417 | `-133,13 +233,19` | Kept | Assert caller total-limit metadata without misleading file pagination. |
| 88 / file 5 | 2441 | `-147,6 +253,41` | Ported | Retain native-total lower bounds and multiline partial-coverage checks alongside upstream pagination assertions. |

### `packages/coding-agent/test/tools/grep-path-lists.test.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 89 / file 1 | 2488 | `-127,7 +127,11` | Ported | Retain explicit before/after context through the existing session settings overlay. |

### `packages/coding-agent/test/tools/todo.test.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 90 / file 1 | 2505 | `-5,6 +5,8` | Kept | Import command-helper and committed-state seams for transaction tests. |
| 91 / file 2 | 2514 | `-56,7 +58,7` | Dropped | Do not carry the historical generic toThrow assertion; retain the exact upstream internal-scheme error assertion. |
| 92 / file 3 | 2523 | `-408,6 +410,347` | Kept | Keep cross-phase arrays, missing/empty/duplicate/exact-name targets, atomicity, and slash-command parity regressions. |
| 93 / file 4 | 2871 | `-436,9 +779,7` | Dropped | Do not carry the historical relaxed duplicate-phase assertion; retain exact upstream error text. |
| 94 / file 5 | 2882 | `-492,7 +833,7` | Dropped | Do not carry the historical relaxed missing-list assertion; retain exact upstream error text. |
| 95 / file 6 | 2891 | `-554,7 +895,6` | Dropped | Do not remove upstream invalid-argument error assertion. |
| 96 / file 7 | 2899 | `-578,7 +918,7` | Dropped | Do not carry the historical relaxed missing-items assertion; retain exact upstream error text. |
| 97 / file 8 | 2908 | `-680,6 +1020,60` | Kept | Keep array/recovered-list touched-phase and exact-name render tests. |
| 98 / file 9 | 2969 | `-731,6 +1125,42` | Kept | Keep plural, partial-array, and sanitized singleton preview tests. |

### `packages/coding-agent/test/tools/wait.test.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 99 / file 1 | 3016 | `-5,6 +5,7` | Dropped | Message import is upstream. |
| 100 / file 2 | 3024 | `-22,16 +23,29` | Dropped | Extended session/context test helpers are upstream. |
| 101 / file 3 | 3055 | `-149,21 +163,21` | Dropped | Upstream already tests the lowered ladder and headless guidance. |
| 102 / file 4 | 3084 | `-189,6 +203,64` | Ported | Extend upstream sole-call tests with minute-away reset, eval non-borrowing, and explicit TUI/ACP distinction. |
| 103 / file 5 | 3149 | `-299,18 +371,23` | Kept | Cover cancellation of a top-rung wait without losing later result delivery. |
| 104 / file 6 | 3176 | `-412,15 +489,25` | Kept | Cover direct-message interruption during the top rung without treating chatter as completion. |
| 105 / file 7 | 3204 | `-431,6 +518,7` | Kept | Assert a message resets the next wait to the 5s floor. |
| 106 / file 8 | 3212 | `-875,13 +963,20` | Kept | Exercise owed-reply sole-call backoff and TUI/headless guidance. |

### `packages/collab-web/CHANGELOG.md`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 107 / file 1 | 3241 | `-2,6 +2,10` | Dropped | Keep upstream historical release notes unchanged; record retained viewer behavior in this port report. |

### `packages/collab-web/src/tool-render/tools/todo.tsx`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 108 / file 1 | 3256 | `-53,6 +53,15` | Kept | Keep scalar/partial-array label normalization. |
| 109 / file 2 | 3272 | `-67,7 +76,7` | Kept | Use array-aware labels in the collapsed summary. |
| 110 / file 3 | 3281 | `-87,7 +96,7` | Kept | Use array-aware labels in expanded operation rows. |

### `packages/collab-web/test/tool-view.test.tsx`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 111 / file 1 | 3294 | `-227,6 +227,62` | Kept | Cover array, scalar, legacy, and partial-stream browser todo previews. |

### `packages/tui/CHANGELOG.md`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 112 / file 1 | 3361 | `-2,6 +2,10` | Dropped | Upstream already ships multi-target todo rendering; do not rewrite its historical release notes. |

### `packages/tui/src/tools/todo.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 113 / file 1 | 3376 | `-126,6 +126,53` | Ported | Keep upstream exact-name-first parser implementation; retain explanatory empty-entry documentation. |
| 114 / file 2 | 3430 | `-235,7 +282,7` | Dropped | The scalar-or-array renderer argument type is upstream. |
| 115 / file 3 | 3439 | `-259,6 +306,25` | Ported | Keep upstream target-count normalization and shared descriptions; retain the original shared-preview comment. |
| 116 / file 4 | 3465 | `-424,8 +490,8` | Dropped | Shared parser-based touched-phase selection is upstream. |
| 117 / file 5 | 3476 | `-540,18 +606,7` | Dropped | Shared text preview descriptions are upstream. |
| 118 / file 6 | 3496 | `-735,14 +790,7` | Dropped | Shared native preview descriptions are upstream. |

### `packages/tui/test/todo-targets.test.ts`

| Hunk | Patch line | Original range | Disposition | Reason |
| --- | ---: | --- | --- | --- |
| 119 / file 1 | 3517 | `-0,0 +1,58` | Kept | Keep exact-name, delimiter, quoting, empty-entry, and partial-list parser regressions. |

## Regeneration and verification

The metadata capture logic is shared by [`source-bundle-update.ts`](../src/release/source-bundle-update.ts): ULW preparation and [`update-native-omp.ts`](../scripts/update-native-omp.ts) use the same full-index patch, postimage digest/mode, and Git tree generator. The native script requires an exact commit and matching package version, stages temporary metadata, and admits that bound checkout before writing either root artifact. Unstaged content or executable-mode drift is rejected; hashes are never hand-edited.

Use a private upstream checkout at the exact target commit, with the reviewed overlay staged. The published patch is that resolved overlay; do not reapply the old conflicting patch to reproduce this result. From the Dori repository root, create a new sibling checkout:

```sh
umask 0022
dori="$PWD"
git clone https://github.com/can1357/oh-my-pi.git ../native-omp-upstream
git -C ../native-omp-upstream checkout --detach e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63
git -C ../native-omp-upstream apply --index "$dori/native-omp.patch"
(
  cd ../native-omp-upstream
  bun install --frozen-lockfile --ignore-scripts
  bun --cwd packages/collab-web scripts/build-export-viewer.ts --write
  git add packages/coding-agent/src/export/html/viewer.generated.json
  chmod go-w .
  git ls-files -z | xargs -0 chmod go-w
  git update-index --refresh
)
```

`--write` permits viewer regeneration even with inherited `CI=true`. The umask keeps newly created export directories/assets private from group/world writes; the chmod steps cover inherited tracked-file permissions. Refreshing index statistics after permission-only changes does not stage content changes. Do not build or regenerate in the live Dori installation/cache.

For a reviewed upstream checkout located at `../native-omp-upstream`, run from the Dori repository root:

```sh
bun scripts/update-native-omp.ts \
  --checkout ../native-omp-upstream \
  --commit e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63 \
  --version 18.22.2
```

Generation is not a substitute for the release checks in [releases.md](releases.md). Run `umask 0022; bun run ci`, then prepare an isolated native/ULW installation and exercise guarded `--version`, native-host code mode, direct/JavaScript/Python task bridges, role=lane completion, extension loading, and monitor event delivery. Measure startup time and memory against the old bound 18.20.0 install, not a stock package with different patches.

The upstream regression set affected by this port is:

```text
packages/coding-agent/test/agent-session-context-file-reload.test.ts
packages/coding-agent/test/agent-session-python-cleanup.test.ts
packages/coding-agent/test/eval/context-manager-startup.test.ts
packages/coding-agent/test/eval/kernel-session-registry.test.ts
packages/coding-agent/test/tools/grep-pagination.test.ts
packages/coding-agent/test/tools/grep-path-lists.test.ts
packages/coding-agent/test/tools/todo.test.ts
packages/coding-agent/test/tools/wait.test.ts
packages/collab-web/test/tool-view.test.tsx
packages/tui/test/todo-targets.test.ts
```

The repository-side generator regression seam is `test/source-bundle-update.test.ts`, including clean native publication and rejection of unstaged content/mode changes without modifying published metadata. This document records reviewed source dispositions and regeneration procedure, not a claim that the runtime checks above have passed.

[c18222]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/coding-agent/CHANGELOG.md#L5-L65
[c18221]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/coding-agent/CHANGELOG.md#L67-L128
[c1822]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/coding-agent/CHANGELOG.md#L130-L159
[c1821]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/coding-agent/CHANGELOG.md#L161-L191
[c18203]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/coding-agent/CHANGELOG.md#L193-L245
[c18202]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/coding-agent/CHANGELOG.md#L247-L251
[c18201]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/coding-agent/CHANGELOG.md#L253-L287
[ai18222]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/ai/CHANGELOG.md#L5-L21
[ai18221]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/ai/CHANGELOG.md#L23-L52
[core18221]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/agent/CHANGELOG.md#L5-L16
[session]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/coding-agent/src/session/agent-session.ts
[extensions]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/coding-agent/src/extensibility/extensions/types.ts
[entries]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/coding-agent/src/session/session-entries.ts
[manager]: https://github.com/can1357/oh-my-pi/blob/e1ae2cc998efd1ca151b46ebefc0e0dab6c23c63/packages/coding-agent/src/session/session-manager.ts
