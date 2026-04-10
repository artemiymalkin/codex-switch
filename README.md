# ai-switch

A small CLI for switching OpenAI accounts between Codex and OpenCode using a
shared local store. It keeps one saved profile per account name and can apply
it to both platforms.

## Requirements

- `bash`
- `jq`

## Install

```bash
git clone <repo-url> ~/ai-switch
ln -sf ~/ai-switch/ai ~/.local/bin/ai
```

Make sure `~/.local/bin` is in your `PATH`.

## Usage

```bash
ai ls
ai list
ai save work
ai use work
ai usage
ai delete work
ai --platform codex save work
ai --platform opencode use work
```

### Notes

- Without `--platform`, `save` and `use` apply to all available platforms.
- Missing platforms are skipped with a warning unless explicitly requested.
- `use` overwrites active auth files without creating backups.
- `use` refreshes the stored entry for the currently active account before switching.
- `delete` removes a saved account from the shared store.
- `usage` shows Codex limits and requires `codex` CLI plus `tmux`.

## Storage

Default locations:

- Saved accounts: `~/.local/share/ai-switch/credentials/`
- Codex auth: `~/.codex/auth.json`
- OpenCode auth: `~/.local/share/opencode/auth.json`

You can override paths with environment variables:

- `AI_SWITCH_HOME` (default `~/.local/share/ai-switch`)
- `CODEX_HOME` (default `~/.codex`)
- `CODEX_AUTH_FILE`
- `OPENCODE_AUTH_FILE`

## Security

This repository is meant to be shared. Do not commit auth files. The `.gitignore`
excludes common secret paths and JSON auth artifacts.
