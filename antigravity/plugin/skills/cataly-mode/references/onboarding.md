# Consent-First Onboarding

Run once when the owner opts in. Never read private tools or data without explicit consent.

1. **Ask consent first** (in the owner's language):
   > "To help you well I first need to learn how you work: which tools you use, what you're working on and why, and who you and your team are. May I inspect your tools read-only to learn this?"
2. If declined, call `cataly_config_set` with `onboarding: { status: "declined" }` and do not ask again unless brought up.
3. **Ask tool by tool**: Name each integration (e.g. GitHub via `gh`, Discord channels, workspace repos), state what it reads, and ask permission for that tool alone. Record allowed/declined tools via `cataly_config_set`.
4. **Read-only discovery**: Never post, edit, react, or mutate anything during onboarding.
5. **Persist memory incrementally**: Save `work`, `persona`, `company`, and `notes` via `cataly_config_set` (`onboarding` object), keeping all secrets and private third-party data out.
6. **Summarize**: Report what you learned, which tools were used or skipped, and mark `onboarding.status = "completed"`.
