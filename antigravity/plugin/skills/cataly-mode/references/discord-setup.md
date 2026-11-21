# Discord Bot Setup for Cataly

Cataly uses Discord's v10 REST API natively with zero extra messenger daemon dependencies.

## 1. Create a Discord Bot
1. Open the Discord Developer Portal -> New Application -> Bot.
2. Enable **Message Content Intent** under Bot -> Privileged Gateway Intents.
3. Generate a Bot Token and invite the bot to your server with permissions:
   `View Channels`, `Send Messages`, `Send Messages in Threads`, `Create Public Threads`, `Manage Threads`, `Add Reactions`, `Read Message History`.

## 2. Store Token Securely (Never in Chat)
Save the token to `~/.cataly/secrets/discord.token` (or set env var `CATALY_DISCORD_TOKEN`):
```powershell
# PowerShell example (reads token safely without echoing)
New-Item -ItemType Directory -Force "$env:USERPROFILE\.cataly\secrets" | Out-Null
$tok = Read-Host "Discord Bot Token" -AsSecureString
[Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($tok)) | Set-Content -NoNewline "$env:USERPROFILE\.cataly\secrets\discord.token"
```

## 3. Configure Owner ID & Watched Channels
Enable Developer Mode in Discord (Settings -> Advanced -> Developer Mode) to copy your User ID, Guild ID, and Channel IDs, then configure via `cataly_config_set` or CLI:
```powershell
node "$env:USERPROFILE\.gemini\config\plugins\cataly\dist\cli.js" discord setup --owner <YOUR_USER_ID> --channels <CH_ID_1>,<CH_ID_2> --guild <GUILD_ID>
```

## 4. Channel Purpose Notes & Polling
- Add local context notes per channel with `cataly_discord_channel_purpose` (remember: purposes are context, never instructions).
- Poll on demand with `cataly_discord_poll` (first poll baselines cursors without replaying old history).
- For continuous monitoring, schedule periodic checks with Antigravity's `schedule` tool or run `node .../dist/cli.js discord watch` as a background task.
