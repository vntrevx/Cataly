# Cataly

**Understand the intent. Read the context. See the work through.**

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [Deutsch](README.de.md) | [Italiano](README.it.md) | [中文](README.zh.md)

Cataly is an AI teammate for turning a goal into finished work. Tell it what you
want to accomplish; it takes ownership of the next steps, considers the surrounding
context, and follows through with a result you can check.

The ambition is not just to follow instructions. It is to exercise good judgment:
notice what matters, connect the details, and handle the work without needing to
be managed one step at a time.

## The philosophy

- **Own the outcome.** Work toward the goal, not a checklist of activity.
- **Understand the context.** Keep the conversation, project conventions,
  constraints, and the user's preferences in view.
- **Take thoughtful initiative.** Handle routine decisions independently. Ask when
  a real tradeoff or missing permission needs the user's judgment.
- **Follow through.** Investigate, implement, verify, and report what actually
  happened. A convincing explanation is not a substitute for a working result.

That is the standard Cataly is built around: capable enough to act, attentive
enough to understand, and accountable for the result.

## How it works

Cataly connects messenger conversations to a native coding-agent runtime and
tracked work lanes:

- The lead handles small requests directly and gives longer jobs a brief,
  dedicated session, and accountable owner.
- Worklogs, checkpoints, and registries keep progress inspectable across restarts.
- Discord intake carries reply context and attachment metadata into the work.
- Process-bound session and approval records guard delivery to the intended agent.
- Completion checks can verify concrete signals such as passing commands,
  matching files, merged pull requests, or published versions.
- Optional scheduling, monitors, and supervision support ongoing work when
  explicitly enabled.

The implementation brings together
[dori-superagent](https://github.com/sisyphuslabs/dori-superagent),
[oh-my-pi](https://github.com/can1357/oh-my-pi), and
[omp-ulw](https://github.com/dbc-hbin/omp-ulw). Their authors, licenses, and source
provenance remain part of the project.

## Start here

Cataly is the project name. The existing `dori`, `omp-dori`, and `omp` commands,
installation homes, and published asset names have not been renamed.

### Work from source

Install git, Bun 1.4.4+, and herdr or hc first; see the
[source prerequisites](docs/releases.md#current-source-bundle).

Use a separate checkout, not a running installation or a frozen consumer release:

```bash
git clone https://github.com/vntrevx/Cataly.git "$HOME/src/Cataly" || exit 1
cd "$HOME/src/Cataly" || exit 1
DORI_INSTALL_MODE=side DORI_NO_PULL=1 DORI_SRC="$PWD" bash scripts/install-source.sh
```

The source installer prepares the bound, patched OMP 18.22.2 and ULW overlay;
a stock `omp` on `PATH` is not a substitute. Side mode defaults to `~/.omp-dori`,
keeps its own wrappers and configuration, and leaves the primary `~/.dori`
installation alone. Installation starts no agent, messenger receiver, or service.

Read the [source installation guide](docs/releases.md#source-checkouts-for-maintainers)
for isolation, configuration, and explicit startup. Native sessions
use your own provider authentication and allowance.

### Use a published release

The existing **v0.1.2 prerelease** has an immutable Linux x64 / herdr / Discord
contract. A repository rename does not upgrade those assets or establish support
for new platforms.

Follow the [verified exact-release walkthrough](docs/releases.md#prerequisites-and-trust).
It covers prerequisites, checksums, installation, your own authentication,
explicit startup, and opt-in Discord monitors. Do not substitute an arbitrary
`main` installer for an exact release.

The consumer implementation also supports isolated macOS arm64 / hc profiles
when a verified release manifest declares them. That is not a claim that a macOS
release has been published. Slack and Telegram remain source features.

## Operating principles

Cataly works with the accounts and permissions you supply. External effects need
the applicable authorization; it does not gain permission by deciding an action
would help. Enable only the sessions, monitors, and services you intend to run.

Verification has boundaries. A passing completion signal is evidence of that
signal, not a guarantee about every outcome. Reports should distinguish observed
results, remaining uncertainty, and work that was not performed.

Keep credentials, private conversations, and account data out of public patches
and reports. Optional telemetry can be disabled with `DORI_TELEMETRY=0` or
`DO_NOT_TRACK=1`.

## Documentation

- [Installation, support, updates, and rollback](docs/releases.md)
- [Skill and operating rules](skills/dori-mode/SKILL.md)
- [Messenger setup](skills/dori-mode/references/setup.md)
- [Runtime adapters and session contracts](docs/runtime.md)
- [Container setup](docs/container.md)
- [Scheduling and backlog](docs/hourly-loop.md)
- [Shared locks and lane priority](docs/locks.md)
- [Opt-in Discord voice assistant (paid)](docs/discord-voice.md)
- [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Licenses and source attribution](LICENSE) · [Licensing guide](LICENSING.md) · [Modified-copy notice](NOTICE)

## Contribute

Bring a clear goal, a focused change, and evidence that it works. Start with the
[contribution guide](CONTRIBUTING.md), check
[existing issues](https://github.com/vntrevx/Cataly/issues) and
[pull requests](https://github.com/vntrevx/Cataly/pulls), and preserve the context
that made the change necessary.

## License

Licensing follows the source of each component. The dori-superagent-derived
material retains [Sustainable Use License 1.0](LICENSE); the pre-existing OMP
integration retains its [MIT license and copyright notices](LICENSE.omp-dori).
Other components keep their own terms. The MIT notice does not relicense the
whole repository. [NOTICE](NOTICE) records the imported revisions and modified-copy
attribution.
