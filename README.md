# ai-switch

A small Node.js CLI for switching OpenCode accounts using a shared local store.

## Requirements

- `Node.js 20+`
- `npm`

## Install

```bash
git clone <repo-url> ~/ai-switch
cd ~/ai-switch
npm install
ln -sf ~/ai-switch/ai ~/.local/bin/ai
```

Make sure `~/.local/bin` is in your `PATH`.

## Usage

```bash
ai ls
ai status
ai status --all
ai add work
ai login work --no-open
ai list
ai save work
ai use work
ai delete work
```

### Notes

- OpenCode is the only supported platform.
- `add <account>` / `login <account>` starts a local OAuth flow and saves the account directly.
- `add` tries to open your local browser automatically; use `--no-open` to disable that.
- If you complete login on another device, copy the final `http://localhost:1455/auth/callback?...` URL and paste it back into the terminal. The CLI extracts the `code` from that URL and exchanges it for tokens locally.
- `status` queries the ChatGPT Codex usage endpoint for the active OpenCode account.
- `status --all` queries usage limits for every saved account.
- `status` auto-refreshes saved tokens when the usage API returns `401 token_expired`.
- `use` overwrites the active auth file without creating backups.
- `use` refreshes the stored entry for the currently active account before switching.
- Saved accounts are stored as normalized OpenCode snapshots.
- Legacy saved accounts from `~/.codex/credentials` and `~/.codex/credentials/opencode-openai` are discovered automatically.
- `delete` removes a saved account from the shared store.
- Saved writes are atomic and no longer depend on `jq`.

## Storage

Default locations:

- Saved accounts: `~/.local/share/ai-switch/credentials/`
- OpenCode auth: `~/.local/share/opencode/auth.json`

You can override paths with environment variables:

- `AI_SWITCH_HOME` (default `~/.local/share/ai-switch`)
- `OPENCODE_AUTH_FILE`

## Security

This repository is meant to be shared. Do not commit auth files. The `.gitignore`
excludes common secret paths and JSON auth artifacts.
