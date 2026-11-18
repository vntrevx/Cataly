# Public releases and support

## Current source bundle

Current source `main` and newly built release manifests use a bound source toolchain by default, not an independently installed stock OMP. Install git, Bun 1.4.4+ and the selected session runtime yourself. No `omp` on `PATH`, Cargo, provider credentials or global native-cache changes are needed to prepare this default.

`native-omp.lock` and `native-omp.patch` bind upstream [oh-my-pi](https://github.com/can1357/oh-my-pi) commit `c308970263ae13744ea15ab67302e3dac840e266` (18.20.0), the patch SHA-256, resulting Git tree and modified-file SHA-256/modes. The home-local cache is `~/.cache/omp-dori/native-<platform>-<arch>-<full-source-identity>`. Preparation installs frozen upstream dependencies and the separately frozen official `@oh-my-pi/pi-natives@18.20.0` package from `native-addon/`. It probes the actual addon and copies those version-matched bytes through the existing workspace loader seam; receipts bind the actual addon, Bun and launcher bytes. Rust is unchanged. The addon release stamp establishes its release compatibility, **not** the source delta or binary equivalence to a rebuilt OMP executable.

Bun and addon SHA-256 checks read every byte through a fixed 1 MiB buffer, both when creating a receipt and when revalidating it. Hashing remains synchronous and serial; no timestamp cache or skipped integrity check is used.

The default command remains literally named `omp`. It validates the bound source, then executes upstream `packages/coding-agent/scripts/omp` through the recorded Bun, retaining that launcher's empty-cwd/preload protection. Every tracked source file and the expected overlay index tree are independently checked; a stock 18.20.0 image, version-only receipt, unchanged launcher hash, malformed patch or partial cache cannot satisfy this bundle. Drift holds installation/reuse/launch instead of fetching around it or falling back to stock.

`omp-ulw.lock` retains the upstream repository/commit protocol and selects [33b375dc8d289d6fec944a8a5ee8f2db721a8c34](https://github.com/dbc-hbin/omp-ulw/tree/33b375dc8d289d6fec944a8a5ee8f2db721a8c34). `omp-ulw.overlay.lock` plus `omp-ulw.patch` bind the reviewed overlay and resulting file hashes/tree. Fetching keeps upstream HEAD and gitlinks intact; the staged index records only the expected overlay. Reuse accepts that exact overlay, not arbitrary dirty source. Native and ULW patch files are consumed during preparation, not stored as inert archives.

Primary source sessions use `~/.dori/bin/omp`; side sessions use `omp-dori omp`. Both generated `agentCommand` defaults use their guarded source wrapper. Consumer releases provide their own `<home>/bin/omp` and resolve their frozen wrapper/dependency on update and rollback without rewriting existing config bytes; already loaded release code stays pinned to its own release, including its isolated discovery overlay. Managed deployment omits `promotion.deployment.omp` for the source default, prepares both bundles before admission and retains their identities in toolchain receipts. Its per-process extension selection consumes the prepared ULW dependency exactly once.

Explicit overrides remain advanced contracts: `DORI_OMP` for source installation, an absolute custom `agentCommand`, `promotion.deployment.omp`, external `ompUlwPath`/`OMP_ULW_SRC`, or an existing standalone primary ULW extension select user-owned code. A managed external native receipt is marked `nativeOverride`, never presented as patched-source proof. Source `OMP_ULW_REF=main` or an explicit branch/tag/commit selects an unpatched custom checkout; its selected profiles and code-mode handlers are the ones loaded. `OMP_ULW_REPO` can supply a mirror for the exact locked commit or a repository for an explicit custom ref. Preserve these explicit choices when reinstalling; a custom native/ULW override is not evidence for the complete bundled default.

Public ULW scope is read from the explicit process-local `OMP_ULW_SCOPE_FILE` when supplied, otherwise from `~/.omp/agent/dsh-unbound/route-scope.json` under that process's HOME. For isolated temporary-HOME sessions, pass an absolute scope-file path in that child environment only. Missing/empty/invalid explicit values retain ULW's loader-default behavior rather than reading another user's policy. No private policy contents, model/auth settings or global configuration are shipped or rewritten.

The immutable published `v0.1.2` assets below predate this protocol and are **not** replaced by this source change. Their 18.18.8 independent-native contract remains readable, including retained rollback; a new 18.20.0 manifest must carry the complete bound payload and cannot use that older no-lock route. New source, real isolated installation, exact-head CI, fresh review and publication are separate evidence.

## Preview support boundary

This guide covers the `v0.1.2` GitHub **prerelease** for **Linux x64, herdr and Discord**. The project retains the full messenger skill, harness and OMP extension; retained features and CI jobs do not expand this preview's live consumer support scope.

The immutable `v0.1.0` and `v0.1.1` tags are superseded unpublished release attempts with zero release assets, not stable published releases. See the [release history](../CHANGELOG.md#superseded-unpublished-tags) for the draft-identity and first-upload failures.

| Component | Minimum requirement | Tested preview baseline |
|---|---|---|
| OS / architecture | Linux x64 | Ubuntu 24.04 x64, clean non-root consumer home |
| Bun | 1.4.4 | 1.4.4 |
| Native OMP | 18.18.8 | 18.18.8 |
| Session runtime | herdr, with its OMP integration | herdr 0.9.5 |
| Messenger | Discord, using your own bot | Discord |

Newer Bun or OMP versions meeting the minimum are not automatically tested combinations. The consumer release implementation also supports an isolated macOS arm64/hc profile when a release manifest explicitly declares it; this does not claim that such a release has been published or that a macOS rollout has been exercised. A manifest without capabilities is legacy Linux x64/herdr only. Unsupported host/runtime combinations and releases without the selected capability hold rather than activate. Slack and Telegram remain source features. The maintainer source-container recipe is separate from the public release installer; it is not a published consumer image.

Linux x64 identifies the platform and architecture, not a tested matrix of Linux distributions. Qualify the specific distribution and toolchain against the release's actual clean-consumer evidence; other Linux distributions remain compatibility targets with unverified consumer behavior.

Preview support does not imply an independent external-user beta, exhaustive provider testing or universal compatibility. Exact-head CI, isolated install/recovery checks, native runtime behavior and real messenger intake/reply are distinct evidence. Check the evidence attached to the particular release before treating any of those as exercised. This guide describes the contract and operating procedure; it is not a test-run receipt.

## Prerequisites and trust

For the historical `v0.1.2` assets below, install git, Bun, native OMP and herdr yourself and put their binaries on `PATH`. New bound-source builds use the prerequisites and materialization contract above instead. The download example also uses Bash, curl, tar and `sha256sum`. [Bun](https://bun.sh), [OMP](https://github.com/can1357/oh-my-pi) and [herdr](https://github.com/herdrdev/herdr) document their own installation and authentication.

Consumers need neither the GitHub CLI nor GitHub write permission to install, check, update or roll back Dori. These operations do not call porting/review models or change global provider settings. Later AI sessions use your own configured provider and quota; Discord uses your own application/bot account and token. No maintainer credentials, private session history or model authentication ship in the assets.

Use the canonical repository **https://github.com/vntrevx/omp-dori** and the exact tag **`v0.1.2`**. Its intended canonical release path is **https://github.com/vntrevx/omp-dori/releases/tag/v0.1.2**. Check the repository owner, tag and release commit there before downloading. Do not substitute a fork, an arbitrary `main` script or an unverified mirror.

Each release has four fixed assets:

| Asset | Purpose |
|---|---|
| `omp-dori-v0.1.2.tar.gz` | Public source archive, rooted at `omp-dori-0.1.2/` |
| `release-manifest.json` | Product/version/tag, commit/tree, archive digest/size, public source manifest, requirements and exact public omp-ulw dependency |
| `SHA256SUMS` | SHA-256 checksums for the release payload files |
| `install.sh` | Release bootstrap, separate from the source-checkout installer |

Checksums establish consistency with the files downloaded from that trusted release. They are not an independent signature or a substitute for verifying the publishing repository. The installer also validates the manifest bindings, archive digest and extracted source manifest. Tar entries are checked before extraction; links, special files and unsafe paths are not admitted. The public source manifest excludes `ref/omp-ulw`; the separately fetched dependency must match `omp-ulw.lock` exactly.

## Install the exact preview

After publication, use an account with its own home and no existing running Dori. First inspect an existing installation rather than installing over its source or state.

```sh
download_dir="$(mktemp -d)" || exit 1
cd "$download_dir" || exit 1
release_url="https://github.com/vntrevx/omp-dori/releases/download/v0.1.2"
for asset in install.sh release-manifest.json SHA256SUMS omp-dori-v0.1.2.tar.gz; do
  curl --proto '=https' --tlsv1.2 -fL "$release_url/$asset" -o "$asset" || exit 1
done
sha256sum --check SHA256SUMS || exit 1
bash ./install.sh --version v0.1.2 --from "$download_dir" || exit 1
"$HOME/.dori/bin/dori" --version
export PATH="$HOME/.dori/bin:$PATH"
```

Only run the installer after every checksum passes. Preserve the PATH export in your shell configuration if desired; `~/.dori/bin/dori` is the explicit invocation and does not depend on global `bun link` registration. With that checked installer, `bash ./install.sh --version v0.1.2` or `DORI_RELEASE=v0.1.2 bash ./install.sh` fetches the exact network release instead. A request without an explicit version selects a stable release only; it does not silently opt into this preview.

`--from DIRECTORY` is a supported local release-asset input for the bootstrap and for consumer `check`/`install`. Copy the four matching assets together. It is **not** a completely air-gapped first-install promise: git may still need anonymous network access to obtain the exact public omp-ulw commit. A previously provisioned, owned dependency is reused only after validation. There is no separate opaque dependency bundle format.

## Isolated macOS arm64/hc consumer

Use this procedure only with a verified release asset set whose source-bound `release-capabilities.json` declares `darwin`/`arm64`/`hc`. The manifest includes that file's SHA256 in its source inventory; capabilities are validated after archive verification, before installation. The `v0.1.2` Linux example above is not evidence that such assets exist. Install git, Bun 1.4.4+ and hc on `PATH`, verify all four matching assets and their checksums using the release's instructions, then run its checked bootstrap. A new 18.20.0 manifest provisions the bound native source and frozen addon described above; it does not require or substitute a stock `omp`. An older 18.18.8 manifest with this capability still requires an independently installed native OMP 18.18.8+ outside Dori wrappers.

```sh
bash ./install.sh --from "$download_dir" --home "$HOME/.omp-dori" --runtime hc
"$HOME/.omp-dori/bin/dori" update status --home "$HOME/.omp-dori" --runtime hc
```

The bootstrap defaults to side mode and `~/.omp-dori`/`hc` on Darwin, and primary `~/.dori`/`herdr` on Linux. `--home` selects an absolute installation path; `--runtime hc|herdr` selects the runtime, and `DORI_RUNTIME` supplies its default when set. `DORI_INSTALL_MODE=side` selects a separate side home, with `OMP_DORI_HOME` overriding its default; bootstrap ignores inherited `DORI_HOME`. A side home must be outside `~/.dori`. Installed update commands select explicit `--home`, otherwise the loaded release's own home; an ordinary source CLI falls back to `DORI_HOME`, then `~/.dori`. Their runtime is explicit `--runtime`, otherwise the home config's runtime or the platform default.

The isolated home contains `bin/dori`, `bin/dori-harness`, `bin/omp`, `bin/omp-dori` and `omp.yml`. Its renamed `omp-dori-mode` skill and discovery overlay are retained per release under `releases/consumer-discovery/<release-id>/`. The wrapper resolves the active source pointer before selecting both the extension and that release's skill, so a held or interrupted activation cannot mix their versions. Use local paths such as `"$HOME/.omp-dori/bin/omp-dori" omp --dori-role dori` or `"$HOME/.omp-dori/bin/omp-dori" hc ...`; the wrapper loads the local Dori extension with `--no-extensions`, with the pinned ULW imported for roles. It binds the selected config, clears inherited state/runtime overrides, and defaults state inside that home while preserving an explicitly configured state directory. Each side home has distinct hc and herdr namespaces; foreign terminal identities are cleared when switching namespaces, while terminals already in that home's namespace retain theirs. There are no global command, skill or extension links and no global discovery of this installation. Configure the local home and authenticate deliberately before launching; installation itself launches nothing.

The manifest and installed-state schema remain compatible with older consumer CLIs, including after a primary Linux rollback. A release without the source-bound capability file is legacy Linux/herdr primary-only: its CLI predates home selection, so bootstrap, update and rollback refuse it in isolated homes.

Explicit install, reinstall and rollback refresh unchanged owned launchers to the running Bun. Source-bound releases retain their authenticated native source/addon/Bun receipts; a changed native toolchain holds rather than accepting stock OMP or rewriting those receipts. Older independent-native releases refresh their owned wrapper to the native OMP found outside Dori wrappers on `PATH`. The isolated OMP dispatcher reads the active release's retained manifest to select that protocol, extension and discovery together, including during interrupted activation. Owner-modified launchers remain held. If an older independent-native release's Bun path has disappeared, run its verified bootstrap using the new toolchain against the same consumer home. A bound native cache still requires its recorded Bun identity; preserve that executable and use it for recovery. Do not hand-edit wrappers or use the source installer to take over a consumer home.

To migrate from source, first install into a separate fresh release home and preserve the source installation untouched. Stop the source Dori and its monitors before any deliberate, user-authorized copying of selected configuration, state or authentication, reconfiguration and launch in the new home. Review paths and runtime settings for the new home. Never overwrite a live source home or automatically copy secrets. Source-owned homes are held rather than taken over.

## Installation layout and preserved data

The primary Linux consumer installation uses:

- `~/.dori/bin/dori`: the stable launcher.
- `~/.dori/src`: the single active source pointer.
- `~/.dori/releases/releases/<commit>-<public-source-hash-prefix>`: verified retained release directories; the hash prefix has 16 hexadecimal characters.
- `~/.dori/releases/consumer-dependencies/omp-ulw-<commit>`: owned dependency caches for each retained release's public pin.
- `~/.agents/skills/dori-mode` and `~/.omp/agent/extensions/omp-dori`: stable references through the active source pointer.
- `~/.dori/config.json`: an example is created only if this file is absent.

The consumer keeps its own installed-state and activation journal under the release root, separately from maintainer managed-deployment journals. It stages and verifies a candidate before switching the source pointer and retains the previous source for rollback. Treat a release directory as frozen: edit your configuration or use a separate source checkout rather than changing installed product files.

Existing config, authentication, work records, sessions, history and explicit model choices are preserved. The installer does not copy another user's authentication or replace global model settings.

For code loaded from a retained consumer release, managed `ompUlwPath` entries follow that loaded source's own lock. Older caches use `omp-ulw-<40-hex-commit>`; new caches append the full overlay identity. New native defaults similarly resolve the loaded release's guarded `scripts/consumer/omp`, even if the active pointer moves. Update and rollback do not rewrite config bytes. Exact source/patch/result identities are checked before a new bound dependency is used; paths outside these managed shapes remain explicit user choices.

An existing real directory at `~/.dori/src`, an unmanaged pointer, or a conflicting non-link skill/extension/launcher destination holds installation rather than overwriting it. Keep the old installation and its data intact. Continue its source-checkout workflow or plan an explicit stopped migration with backups; the first preview does not silently convert arbitrary legacy layouts. Do not delete an existing installation to bypass a hold.

## Your authentication and explicit startup

An existing consumer `config.json` must explicitly select `"runtime": "herdr"` on Linux x64 or `"runtime": "hc"` on macOS arm64. Bootstrap (including older released CLIs), check, install and rollback hold when that key is absent, even with `--runtime`; the installer preserves owner configuration rather than silently replacing runtime auto-detection. Add the matching key deliberately before retrying. A fresh installation creates it automatically. Ordinary source installations retain their existing runtime auto-detection.

Configure the selected installation's `config.json` for your own environment: `runtime: "herdr"` for Linux primary or `"hc"` for macOS side, `leadPane` in its runtime namespace, `laneWorkspace`, `defaultCwd`, a provider-qualified `defaultModel` available to your account, and messenger hooks. An explicit update `--runtime` does not override a conflicting preserved config; correct that configuration deliberately before retrying. Authenticate OMP with your own provider account. Create/invite your own bot through the [Discord Developer Portal](https://discord.com/developers/applications), granting the chosen channel's View Channel/Read Message History permissions and the send/thread permissions you intend to use. Enable **Message Content Intent** on the Bot page for ordinary owner text. See the [setup reference](../skills/dori-mode/references/setup.md) and [Discord's content-intent requirements](https://docs.discord.com/developers/events/gateway#message-content-intent). Native Dori handles this supported bot text flow; Node, agent-messenger, a user-account token and an external watch script are not prerequisites.

Choose the installation before preparing authentication or monitors. For Linux primary use `export DORI_HOME="$HOME/.dori"`; for the default macOS side home use `export DORI_HOME="$HOME/.omp-dori"` (substitute its actual path for a custom home). The side wrapper binds this variable to its own home. The recipes below require it and never fall back to another installation.

Keep that installation's bot token alone in an owned regular `$DORI_HOME/discord-token` file with mode `0600`. Load it as `DORI_DISCORD_TOKEN` only within the opted-in native monitor child environment. Do not put its value in chat, command arguments, source, monitor specifications, release assets or support reports, and do not export it into the parent OMP session.

For Linux primary, install herdr's OMP integration explicitly:

```sh
herdr integration install omp
```

Before starting OMP, enable Discord's Developer Mode to copy your own user ID and the exact channel ID (or the thread's own ID). Keep these as positive decimal strings. They are non-secret and can be inherited by the native monitor children:

```sh
read -r -p "Your Discord user ID: " DORI_DISCORD_OWNER_ID
read -r -p "Discord channel or thread ID: " DORI_DISCORD_CHANNEL_ID
export DORI_DISCORD_OWNER_ID DORI_DISCORD_CHANNEL_ID
```

For Linux primary, start `omp --dori-role dori` inside herdr with the selected `DORI_HOME` exported. For macOS side, start the lead in that home's separate hc namespace:

```sh
"$DORI_HOME/bin/omp-dori" hc run --name omp-dori-lead -- "$DORI_HOME/bin/omp-dori" omp --dori-role dori
```

Then say "Dori mode" and complete the name, messenger destination and permitted-tool onboarding. This is an explicit AI session start and can use provider quota. The harness is an additional opt-in surface: `dori harness up` starts real lead/duty sessions and loops. Do not start a duplicate against the same runtime and state.

Installation, update, rollback and `dori boot` do not start a provider, inbound watcher, Gateway presence process, systemd service or harness. Enable only the monitors you intend to operate. Resuming a previously active OMP session can restore that session's recorded monitor intent; a fresh installation creates none, and an explicitly stopped monitor must remain stopped.

### Discord owner intake

The receiver is **`dori inbound discord [--loop MINUTES] [--gateway]`**. Required child environment is `DORI_DISCORD_TOKEN` plus `DORI_DISCORD_OWNER_ID` and at least one channel through `DORI_DISCORD_CHANNEL_ID` or `DORI_DISCORD_CHANNEL_IDS`, unless `DORI_DISCORD_SCOPE=all` is selected. Only the configured owner's text in the watched channels is admitted. Bots, the bot itself, other users, webhooks and system messages are excluded. A thread is watched by configuring its own channel ID.

More channels are opt-in and leave a single `DORI_DISCORD_CHANNEL_ID` setup unchanged: `DORI_DISCORD_CHANNEL_IDS=ID,ID,...` adds channels or threads (all explicit IDs must be readable, or startup fails), and `DORI_DISCORD_SCOPE=all` additionally discovers readable guild text channels, active threads and the owner's DM with the bot. Discovered channels that return 403/404 are skipped, including an unavailable owner DM; authentication, rate-limit and server failures still propagate. The set is refreshed on every Gateway READY/RESUMED, or every 100 REST polls. Every watched channel has its own cursor.

With the protected token file prepared above and the non-secret IDs inherited from the owning OMP session, explicitly start one native `monitor` using these `argv` values and filter `^INBOUND`:

```json
["bash", "-c", "set -eu; base=\"${DORI_HOME:?Select this installation home}\"; DORI_DISCORD_TOKEN=\"$(cat \"$base/discord-token\")\"; export DORI_DISCORD_TOKEN; exec \"$base/bin/dori\" inbound discord"]
```

The token value never appears in this argv or its monitor receipt: only the child shell reads and exports it. No private helper, external watch script, Node or agent-messenger is needed. A different token-file path is an explicit local choice; keep it owned, regular and mode `0600`.

By default the command polls continuously every **three seconds**. `--loop` uses **minutes**: `--loop 0.1` means six seconds, and `--loop 0` runs once. Append those flags after `inbound discord` in the opted-in argv when needed.

Startup validates bot authentication, application Message Content Intent and View Channel/Read Message History access before `INBOUND_READY discord owner=<id> channel=<id[,id...]|all> bot=<id>` (`mode=gateway` is appended with `--gateway`). Each channel without a stored cursor baselines its latest message ID without replaying history; an empty channel starts at `0`. This also applies to channels first found by a later REST discovery. In scope `all`, a channel first seen through a live dispatch starts just before that message, so earlier history in that channel is skipped. Existing stored cursors resume instead of baselining again. **Wait for readiness, then send a fresh owner message.** Subsequent owner messages appear as `INBOUND discord <channel> <message> from=owner ref=<id|-> <JSON text>` for native monitor delivery to the owning OMP session.

Attachment-only and Discord voice messages keep the text `""` on that unchanged `INBOUND discord` line. Available reply context follows as `INBOUND_REPLY`; each attachment follows as `INBOUND_ATTACHMENT` with its filename, optional content type, size, exact signed URL and optional voice/duration metadata ([record format](../skills/dori-mode/references/scripts.md#dori-inbound-discord---loop-minutes---gateway)). Reply context is data, not a new owner request; a deleted target retains only `ref=`. Signed URLs expire, so use them promptly for an explicitly chosen download or `dori transcribe <url>`. Metadata delivery itself starts no transcription or inference. REST and Gateway use the same formatter and one emit per message before cursor commit; a malformed attachment/list or throwing emitter leaves that message uncommitted.

The cursor is committed under `<stateDir>/discord-inbound/<channelId>.json` in a private owned directory with mode-0600 atomic cursor files. Later polls page back to the cursor, deduplicate and emit owner messages chronologically, advancing state as items are handled. Explicitly restarting the monitor resumes its committed cursor. Do not delete the cursor to simulate successful intake. This is new-message intake with reply/media metadata; edit and delete events are not delivered.

Only a remote history-read 403/404 removes an unavailable discovered channel; explicitly configured targets still fail on those responses. Content conversion, delivery and local cursor failures are not permission loss. In Gateway mode they stop intake before later queued messages can advance past the failed message. If an already watched channel's cursor disappears, intake reports the missing-state error rather than silently dropping live messages or recreating a baseline. First-seen scope-all channels still seed their new cursors as described above.

#### Real-time Gateway mode

Add `--gateway` to receive owner messages live instead of on the next poll. The receiver keeps one Gateway connection that subscribes only to `GUILD_MESSAGES`, `DIRECT_MESSAGES` and `MESSAGE_CONTENT`; it sends no presence update. **`MESSAGE_CONTENT` is a privileged intent: enable Message Content Intent for the bot in the Developer Portal**, otherwise Discord closes the connection with code 4014 and intake stops with an error naming it. After every `READY` and `RESUMED`, REST reads each watched channel from its cursor before queued live messages run. Both paths share that cursor, so outage history, live copies and resumed replays emit once and in ascending order per channel. **`--gateway` ignores `--loop`, including `--loop 0`; it runs until stopped.** A transient backfill failure (HTTP 429, real HTTP 5xx or an unreachable API, after the usual request retries) is retried every 2 s doubling to 30 s with `DISCORD_GATEWAY_BACKFILL_RETRY` lines while live messages wait. Locally detected malformed responses, channel mismatches and non-advancing pagination stop intake with a sanitized error; they are not treated as transient server responses. A failed delivery, other non-transient backfill failure or terminal close code also exits nonzero; restarting resumes the committed cursors. Gateway progress uses `DISCORD_GATEWAY_READY`, `DISCORD_GATEWAY_RECONNECT` and `DISCORD_GATEWAY_STOPPED` lines, outside the `^INBOUND` filter. Those lines contain no message text, and cursor files hold only message IDs.

Gateway shutdown stops connection/retry scheduling and drops queued dispatches. It drains any already active REST backfill, including its deliveries and cursor commits, before the command finishes. Shutdown is a drain boundary, not cancellation of an in-flight HTTP request.

To select Gateway delivery in the monitor recipe above, append `--gateway` after `inbound discord` in its argv. It is opt-in; installation and updates select neither Gateway intake nor scope `all`. Intake and `dori presence discord` use separate Gateway sessions even with the same bot token; sharing the connection implementation does not share their session or lifecycle.

Maintainer tooling `bun scripts/bench-discord-intake.ts --runs 1 --seed 1 --scenarios a` compares the immutable pre-Gateway `f5d34ab98ad040a500689fbeefe507e54281eff3` intake with single/multi-channel REST and Gateway variants. It requires that Git object in a source checkout. `--base REF` selects another commit with the earlier single-channel intake API. This is an **OFFLINE synthetic benchmark** against loopback HTTP/WebSocket stand-ins, with synthetic IDs and no Discord credentials or external Discord requests; its output measures local intake logic, not real Discord service latency.

Startup auth, permission, intent and state errors exit nonzero with sanitized output. Later poll failures produce `WARN` and retry on the polling loop. Inspect those errors and actual fresh owner delivery before claiming setup works; readiness alone is not an intake/reply receipt. SIGINT/SIGTERM stops REST intake. It does not set online presence, and stopping it does not stop the separately enabled Gateway presence monitor.

### Discord online presence

Discord REST inbound polling and message sending alone do not keep a bot online. For an online indicator while Dori is in use, explicitly run **`dori presence discord`** under the owning OMP session's native **`monitor`** supervision. Supply `DORI_DISCORD_TOKEN` only in that child's environment. Keep the presence command running alongside the separately enabled native `dori inbound discord` monitor; neither replaces the other.

For an explicitly enabled presence monitor, use these native monitor `argv` values and filter `^PRESENCE_`. The protected token file is read inside the child shell; the monitor specification contains only its path, never the token:

```json
["bash", "-c", "set -eu; base=\"${DORI_HOME:?Select this installation home}\"; DORI_DISCORD_TOKEN=\"$(cat \"$base/discord-token\")\"; export DORI_DISCORD_TOKEN; exec \"$base/bin/dori\" presence discord"]
```

Presence logs distinguish actual Gateway state:

- `PRESENCE_READY discord event=READY` or `event=RESUMED` follows that genuine Gateway dispatch, not merely opening a socket.
- `PRESENCE_ACK discord seq=<number|->` records only the first actual heartbeat acknowledgement of each connection; later routine acknowledgements update lifecycle state silently.
- `PRESENCE_RECONNECT discord reason=... code=... retry_in=...s` describes reconnecting, not readiness.
- `PRESENCE_STOPPED discord` records an explicit SIGINT/SIGTERM stop; sockets, timers and retries are stopped and the bot goes offline.

An authentication, configuration or intent failure exits nonzero with a sanitized Gateway error. Inspect that error and your bot setup; do not treat successful REST sends as evidence of presence. Intentionally stopping the native presence monitor means the bot should go offline. Restart that monitor only when you explicitly want presence again. Do not restore unrelated paused watchers or the maintainer updater to fix an offline indicator.

## Updates and rollback

The consumer API runs before normal Dori config loading. Use the local `bin/dori` for an isolated home:

```text
dori update <check|install|status|rollback|cache> [--version TAG] [--from DIST] [--home PATH] [--runtime hc|herdr]
```

For example, after obtaining a compatible asset set in `download_dir`:

```sh
"$HOME/.omp-dori/bin/dori" update check --from "$download_dir" --home "$HOME/.omp-dori" --runtime hc
"$HOME/.omp-dori/bin/dori" update install --from "$download_dir" --home "$HOME/.omp-dori" --runtime hc
"$HOME/.omp-dori/bin/dori" update status --home "$HOME/.omp-dori" --runtime hc
"$HOME/.omp-dori/bin/dori" update rollback --home "$HOME/.omp-dori" --runtime hc
```

The commands below remain explicit operations. New builds also include the launch-time automatic path described next; historical releases do not acquire it merely because `main` changes. Neither installation nor update enables watchers, services, messenger intake or presence. A stopped activation remains stopped. Each retained release uses its own exact manifest-bound omp-ulw pin and cache across update and rollback.

| Command | Behavior and options |
|---|---|
| `dori update check --version v0.1.2` | Inspect an exact release without activating it; `check` also accepts `--from DIST` |
| `dori update install --version v0.1.2` | Verify and install the selected release; `install` also accepts `--from DIST` |
| `dori update status` | Inspect installed state and reconcile an interrupted activation journal |
| `dori update rollback` | Verify and restore the retained previous release |
| `dori update rollback --version v0.1.2` | Assert that the retained rollback target is exactly this tag |
| `dori update cache [--reference DIR]...` | Report native cache identities, references and exclusive bytes; removes nothing (`--prune` is refused) |

`cache` prints `"removes": "nothing"`. It scans the current platform/architecture under the user home cache, sources and files under the primary/side homes and explicit reference roots, receipts, symbolic links, process arguments and same-user working directories (`/proc` on Linux, `lsof` elsewhere). Unreadable locks, unresolved links, unscanned linked directories and unavailable working directories are reported conservatively in `protectedBy`; unreadable reference files or a failed process listing fail the report. References outside the scanned roots and process uses other than arguments/working directories are not covered. Root working directories are not inspected. `bytes` counts logical inode bytes whose hard links all lie within the entry, not allocated filesystem blocks. The scan takes no writer lock: an empty `protectedBy` is a point-in-time observation, never permission to remove an identity. No cache directory is removed or quarantined.

`status` and `rollback` do not accept `--from`. Rollback is a retained-source operation; use `install --from DIST` to select a local candidate. Network `check`/`install` without `--version` selects stable latest only. No consumer command ports upstream, runs review models, fetches arbitrary `main`, publishes GitHub changes or grants repository write access.

**Activation holds while a live Dori is detected, even when it is idle.** Plan a maintenance window. Explicitly stop the monitors you own, end the owning Dori session using normal runtime controls, inspect `dori update status`, then retry the install or rollback. The installer and release commands never kill or restart Dori, consume an approval, alter a paused monitor or pretend a busy hold succeeded.

Failed download, integrity verification or preparation leaves the previously active source and user data in place. Rollback validates the previous release identity and source before switching; it does not undo external work, rewrite config or resume providers/monitors. There must be a valid retained previous release to roll back to. Following an interruption, the next `status`, `install` or `rollback` reconciles the pointer/state journal before continuing. Preserve those records for diagnosis instead of manually replacing pointers or deleting journals.

## Automatic ULW delivery through verified releases

New consumer builds check the canonical **stable Dori release** channel before an ordinary primary or isolated `omp` launch, at most once per 24 hours per installation. They install a strictly newer compatible release through the same verified bundle, consumer lock, staging, activation journal and rollback path as `dori update install`. That release supplies its own exact ULW commit, overlay, native source and Dori code together. There is no separate mutable ULW checkout, arbitrary-upstream execution, prerelease opt-in, downgrade or native OMP self-updater. The launch resolves the selected source again before building extension arguments.

The first eligible launch checks immediately; later launches check only when the saved deadline has elapsed. There is no always-running daemon or in-session timer: leaving one session open for days does not update its code. Network release discovery/downloads share a 15-second budget; verified dependency preparation can take longer under the existing bounded preparation commands. A live Dori **or lane**, or another guarded OMP launch/session, holds automatic activation, including a session that appears while staging. Short PID/start-identity launch leases serialize admission with reference/pointer publication, without holding a startup gate over downloads. Independent admissions compute their bound Git trees through private index copies rather than contending on a shared Git index lock. Nothing kills/restarts those sessions. Failed/offline checks retain a verified current install and record a daily retry deadline. Local source, dependency, receipt or pointer drift still blocks launch rather than being repaired silently.

```sh
dori update auto status                  # last result, next check, enabled state
dori update auto disable                 # persistent per-installation opt-out
dori update auto enable                  # re-enable and make the next launch eligible
DORI_AUTO_UPDATE=0 omp                    # pause only this launch
# For a separate home, use its bin/dori or append --home /absolute/installation
```

An explicit rollback pauses automatic updates until `dori update auto enable`; it does not immediately reinstall the release you rejected. Version/help probes, prepared `--no-extensions` launches and managed startup do not start a network check. Explicit native/ULW overrides remain user choices rather than automatic targets. Existing config, authentication and model choices are not rewritten by the automatic path; the native wrapper's update fence remains in force. Primary user-owned `omp.yml` bytes are preserved. An isolated consumer's generated `omp.yml` is an existing hash-owned reference: owner edits hold instead of being overwritten, even with automatic checks disabled. Resolve that ownership conflict deliberately rather than deleting admission checks.

**Distribution boundary:** this only applies after installing a release containing the launch hook. Older clients, source-owned homes and custom source/ref/path installations are not silently migrated. The published `v0.1.2` prerelease does not contain this hook and is not a stable-channel candidate. A merged PR alone does not publish a release or update installed clients; until a compatible newer stable release exists, an eligible launch keeps its current installation. Source users continue their explicit source-install/update procedure.

For an isolated home upgrading from an older client, run the verified **new release's bootstrap** with the same `--home` and `--runtime`, while stopped. An older client's `dori update install` can select new source while retaining its old generated `bin/omp`; source selection alone does not prove the launch hook was installed. If that older updater was used, rerun the verified new bootstrap (or the newly selected `bin/dori update install` for that same exact bundle/version) to publish the new wrappers. Modern installers render isolated references from the fully verified selected release, including on rollback, rather than keeping the updater's newer template. Missing or changed renderer source fails closed; the existing reference receipts, settings ownership and launch gates still apply.

### Maintainer ULW candidates

The canonical repository's `ULW update candidate` workflow checks upstream `dbc-hbin/omp-ulw` main daily at **03:17 UTC** (GitHub scheduling may be delayed), or on explicit workflow dispatch. It resolves one exact commit, requires a fast-forward from the current pin, reconstructs the admitted old overlay, normalizes its Git blob identities and attempts a three-way application in a disposable checkout. It generates only `omp-ulw.lock`, `omp-ulw.overlay.lock` and `omp-ulw.patch`, verifying the new patch/tree/file identities with the existing source-bundle checks. It never executes upstream code during preparation or touches an installed cache.

A separate trusted job with publication permissions creates a deterministic **draft PR** containing only those three files and dispatches the existing CI workflow on that branch's exact head. The preparation job has no write token, and the publication job executes only trusted `main` tooling, not candidate code. Closed candidates are not reopened; changed branches are never force-pushed. If main advances between preparation/publication, a patch conflicts, history rewinds or identity verification fails, the workflow holds instead of overwriting anything. Repository Actions settings must permit GitHub Actions to create pull requests; if disabled, the workflow reports that failure rather than changing permissions.

A clean three-way merge is not a compatibility review. Maintainers must inspect upstream behavior and local-overlay preservation, satisfy exact-head CI and independent review, then use the existing verified release publication procedure. This workflow neither auto-merges nor tags/publishes a release. Once such a compatible stable release is published, upgraded consumers receive its ULW pin on their next eligible idle launch. This separation prevents unreviewed upstream code from becoming an automatic consumer update.

For local read-only preparation from committed source (the output directory must not already exist):

```sh
bun scripts/update-ulw.ts --out /absolute/new-candidate-directory
```

The output is a review artifact, not an installed update. A conflict requires a reviewed port; do not delete integrity checks, drop the overlay or substitute raw upstream main to make preparation pass.

## Troubleshooting and support reports

- **No stable latest release:** after publication, select the preview explicitly with `--version v0.1.2`. A prerelease is not an automatic latest fallback.
- **Missing/wrong toolchain:** compare `bun --version`, `omp --version` and `git --version` with the baseline, and check that herdr is on `PATH`. Correct your toolchain yourself; the bootstrap does not replace global tools.
- **Checksum/manifest/archive failure:** stop using that download. Retain the error, confirm the canonical owner/tag, and download the complete matching asset set again. Do not disable checks or combine files from different releases.
- **Live actor, unmanaged source or path collision:** keep the existing source/state intact and resolve the reported ownership or session condition. A hold is a nonzero result, not an installed update.
- **Interrupted activation:** run `~/.dori/bin/dori update status` and retain the release state/journal if it reports an unresolved inconsistency. Do not hand-edit the active pointer to manufacture success.
- **Discord messages work but the bot is offline:** inspect the opt-in Gateway presence monitor, its genuine READY/RESUMED and heartbeat logs, your token/intents and the actual Discord indicator. REST success alone proves none of these.

For a support report, include the exact tag, release commit/source hash shown by the manifest or status, OS/architecture, Bun/OMP versions, selected runtime, command and sanitized output. State whether the input was a canonical network release or `--from`. Report checksum failure, skipped checks and unexercised behavior honestly. Exclude tokens, auth files, private session transcripts and project data. Use the repository's [issues](https://github.com/vntrevx/omp-dori/issues) after reviewing what you are submitting.

## Source checkouts for maintainers

Source installation is separate from public release installation. Use an ordinary checkout outside the frozen consumer release directories:

```sh
git clone https://github.com/vntrevx/omp-dori.git "$HOME/src/omp-dori"
cd "$HOME/src/omp-dori"
DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" bash scripts/install-source.sh
```

The checkout installer lives at **`scripts/install-source.sh`**; root `install.sh` remains the consumer release bootstrap. Source installation retains fast-forward-only checkout updates when pulling is enabled and frozen root/skill/extension package installation. `DORI_NO_PULL=1` installs the selected checkout as it is. `DORI_SRC` selects an ordinary source checkout. Keep the full sibling source layout rather than copying the skill alone.

Source omp-ulw defaults to `OMP_ULW_REF=lock`: the exact upstream commit plus its bound overlay is prepared under the home cache, and `<install-home>/omp-ulw` links to it. Reinstall reuses only an identical checked result. `OMP_ULW_REF=main` or an explicit branch/tag/commit instead selects a separate `<install-home>/omp-ulw-custom` checkout, with its actual latest/custom profiles and code-mode handlers loaded by the wrapper. `OMP_ULW_REPO` supplies a mirror or explicitly selected repository. `OMP_ULW_SRC` or an existing custom `ompUlwPath` reuses that external checkout without fetching it. A legacy real default checkout is preserved and held rather than silently reset or called patched; keep it as an explicit override or move it aside before selecting the managed bundle.

Source configuration uses `ompUlwPath: ""`, leaving OMP to load the selected dependency once. Primary mode reuses a standalone extension or links `OMP_EXTENSIONS_DIR/omp-ulw`; adding a standalone later removes only the marked source home's default dependency link, preserving foreign links and directories. Conflicting standalone choices hold before source updates. This primary source extension serves every globally discovering OMP session, including plain sessions. Side mode uses only explicit wrapper loading and leaves discovered extensions alone. Nonempty consumer/custom import paths keep their existing role-gated extension behavior.

`DORI_INSTALL_MODE=side` uses `OMP_DORI_HOME` (default `~/.omp-dori`) for its own config, state, generated skill and wrappers. Source lives there unless `DORI_SRC` is explicit; bound dependencies live in the home-local cache, with a side-home ULW link. It changes no primary `~/.dori` files, global `dori` command, `dori-mode` skill link or global OMP extension links. Only `omp-dori` is linked in `OMP_DORI_BIN_DIR` (default `${BUN_INSTALL:-$HOME/.bun}/bin`). Side homes and path overrides must remain separate from the primary home.

The side `bin/{dori,omp,omp-dori}` wrappers source `env.sh`, set `DORI_HOME`, `DORI_CONFIG`, `DORI_STATE_DIR`, `DORI_AGENT_ARGV` as a JSON array containing their owned `bin/omp`, and the side `PATH`. They clear inherited command and ULW overrides, retain the process-local `OMP_ULW_SCOPE_FILE`, and use `HC_SESSION=omp-dori` by default (`OMP_DORI_HC_SESSION` overrides it). The harness quotes every selected argument for shell execution; argv consumers preserve the complete command. A new config's `stateDir` stays inside the side home and `agentCommand` uses its `bin/omp`. `omp-dori omp` passes `--no-extensions -e <src>/extension -e <omp-ulw> --config <home>/omp.yml`; the generated overlay hides `dori-mode` and discovers the renamed `omp-dori-mode` skill. No globally discovered extension is loaded. Generated wrappers, overlay and skill copy refresh on reinstall; existing config choices remain except for the emptied source `ompUlwPath`. The `.omp-dori-ulw` symlink retains an external side checkout choice, and the `.omp-dori` marker keeps later runs in side mode without a prompt. These paths and configured checkout aliases are checked before source/package mutations.

`DORI_INSTALL_MODE=primary` retains the unmanaged source workflow in `~/.dori`, including global skill/extension links. After frozen dependency installation, it links the executable skill CLI directly as `dori` in `OMP_DORI_BIN_DIR` (default `${BUN_INSTALL:-$HOME/.bun}/bin`), without Bun global package registration. `SKILLS_DIR` and `OMP_EXTENSIONS_DIR` select the skill and extension link locations. When taking over another unmanaged Dori or replacing a foreign `dori` symlink, the previous config, when present, and link targets (including `dori` on `PATH`) are saved under `~/.dori/backups/omp-dori-install-*` after a successful source pull and before link/config changes. An existing regular `dori` file is preserved and stops installation; move it aside or select another `OMP_DORI_BIN_DIR`. A foreign default `~/.dori/src` stops before changes; failed fetch/fast-forward attempts leave no backup. Without an explicit mode, another unmanaged Dori prompts in a terminal with side as the default, and holds without a terminal or on EOF. Earlier unmanaged omp-dori installs are recognized by the marker, source files rather than remote names, or their extension link; a home holding only `omp-ulw/` or `state/` remains eligible for primary installation.

Primary mode also generates `~/.dori/bin/omp`; start the lead through that wrapper rather than a pre-existing stock `omp` on PATH. Both modes migrate only the default `agentCommand` executable (`omp`, or an absent command) to their wrapper, preserving the remaining arguments and explicit custom commands. Their default wrappers check the selected bound ULW before exec. Source installation never replaces the global native OMP executable.

Consumer control records (`consumer-owner.json`, `consumer-installed.json`, `consumer-journal.json` under the release root) and the managed source pointer protect a consumer home before source checkout or package changes. The source marker or omp-dori extension link never overrides that protection. Primary source installation holds there: use its `dori update check|install|status|rollback` commands. A selected side home that directly names or aliases any consumer home also holds, including incomplete consumer control state. Choose a separate ordinary checkout and side home; this installer performs no consumer migration or repair.

Use a separate messenger bot/channel and runtime namespace for experiments. After configuring the side home, the hc source workflow starts a lead with `omp-dori hc run --name omp-dori-lead -- omp-dori omp --dori-role dori`; installation starts no messenger, watcher or hc server. On macOS, privacy permissions follow the process that first starts that hc server. The [container recipe](container.md) is another advanced source-development example. Source fixtures, real OMP skill/extension loading, provider runs and messenger QA establish separate facts; these instructions make no new live QA claim. [CONTRIBUTING.md](../CONTRIBUTING.md) records source checks and contributor conventions.

Maintainer upstream porting uses:

```text
dori upstream <check|stage|watch|status|snapshot|restore|recover|restart> --config FILE
```

This is the former porting updater, with no legacy `dori update stage/watch` alias. Its worker/reviewer models, checks, promotion policy, recovery and external supervisor remain documented in the [staged-update reference](../skills/dori-mode/references/scripts.md#staged-dori-updates). Maintainers supply their own model/provider authentication and, only when publishing, repository permissions. A ready source candidate is not a consumer release or an automatic live deployment.

## Building and publishing releases

The root `package.json.version` is canonical. From the actual committed release source, build the first preview with:

```sh
bun scripts/release.ts build --out ./dist --prerelease
```

The general interface is `bun scripts/release.ts build --out DIST [--prerelease]`. The producer packages actual committed HEAD, rather than uncommitted worktree bytes or an arbitrary private source snapshot. It preserves executable bits, excludes `ref/omp-ulw`, binds the public source manifest to the commit/tree and writes the four fixed assets listed above. For another version, archive and root names are derived as `omp-dori-v<version>.tar.gz` and `omp-dori-<version>/`. A public source hash describes `ulwPresent:false`; the exact public dependency pin remains separate.

Before publication, maintainers perform isolated real-binary install/update/failure-recovery QA without personal HOME/auth/history mounts, review the change freshly and obtain the required CI evidence for the exact release commit. Report the actual results separately: source checks or a historical port replay are not a future clean-consumer run, a provider test or an independent external-user beta.

The `.github/workflows/release.yml` tag workflow validates the tag against the canonical package version. It requires successful **`check`**, **`e2e-herdr`** and **`e2e-hc`** results for that exact commit from the repository's own CI workflow and the trusted GitHub Actions app **15368**. A tag push alone does not prove `ci.yml` ran. The first release is explicitly marked prerelease. Existing tags, releases and assets must not be overwritten; publication needs maintainer permissions and consumers need none.

Every maintainer release-metadata mutation names the tag and commit identity explicitly and reads back the known release ID rather than re-resolving a draft by tag; a body-only draft update can drop that draft's tag binding. The local producer publication path uses the GitHub CLI and needs a `gh` that supports `--paginate` together with `--slurp` for paginated API reads, including release-asset listing, which the trusted Actions runner provides; an older host `gh` without `--slurp` is not a supported producer environment. This is a maintainer tool requirement only: consumer install, check, update and rollback still need no `gh`.

Each binary asset upload sends an exact `Content-Length` from the existing payload's `byteLength`, as required by the [GitHub release asset API](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28#upload-a-release-asset). The stateful producer fixture rejects missing, malformed or mismatched lengths against the actual stdin bytes with HTTP 400.

After publishing, read back the actual release metadata/assets, checksums and tag/commit identity before claiming publication complete. Add the actual QA/CI evidence to the release notes. This procedure makes no claim that an unrun check or an unpublished asset already exists. [LICENSE](../LICENSE), [LICENSE.omp-dori](../LICENSE.omp-dori), [NOTICE](../NOTICE) and third-party pin/notices remain in force; the source-available upstream license has not been replaced.
