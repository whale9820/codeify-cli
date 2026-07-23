# Using Codeify

## Interactive mode

Codeify runs in the current working directory. The header shows session state and loaded context; the editor accepts prompts, file references, and shell commands.

| Input | Behavior |
| --- | --- |
| `@path` | Attach a text or image file to the prompt |
| `!command` | Run a shell command and include its output |
| `!!command` | Run a shell command without adding output to model context |
| `Shift+Enter` | Insert a new line |
| `Escape` | Cancel the active operation |
| `Ctrl+C` | Cancel; press twice to leave |

## Slash commands

| Command | Description |
| --- | --- |
| `/login`, `/logout` | Manage Codeify OAuth or API-key credentials |
| `/model` | Switch the active model |
| `/thinking [level]` | Select or set reasoning effort |
| `/effort [level]` | Alias for `/thinking` |
| `/scoped-models` | Configure models available to Ctrl+P cycling |
| `/settings` | Change reasoning, theme, delivery, transport, and other preferences |
| `/resume` | Browse and resume a previous session |
| `/new` | Start a new session |
| `/name <name>` | Set the session display name |
| `/session` | Show session file and usage details |
| `/tree` | Navigate to an earlier point in the session |
| `/trust` | Save project trust for the current directory |
| `/fork` | Fork a session from an earlier user message |
| `/clone` | Duplicate the current branch into a new session |
| `/compact [prompt]` | Compact context with optional instructions |
| `/copy` | Copy the last assistant message |
| `/export [file]` | Export a session to HTML or JSONL |
| `/import <file>` | Import a JSONL session |
| `/share` | Create a private share link when configured |
| `/reload` | Reload keybindings, skills, prompts, themes, and context files |
| `/hotkeys` | Show keyboard shortcuts |
| `/quit` | Leave Codeify |

## Sessions

```bash
codeify -c
codeify -r
codeify --session <path-or-id>
codeify --fork <path-or-id>
codeify --no-session
```

Sessions are stored under `~/.codeify/agent/sessions/` by default. Project session directories are derived from the working directory.

## CLI reference

```text
codeify [options] [@files...] [messages...]
```

| Option | Description |
| --- | --- |
| `--provider <name>` | Provider name; defaults to `codeify` |
| `--model <pattern>` | Model ID or pattern, optionally with `:<thinking>` |
| `--api-key <key>` | Runtime API-key override |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |
| `--models <patterns>` | Comma-separated model patterns for Ctrl+P |
| `--tools <list>` | Built-in tool allowlist |
| `--exclude-tools <list>` | Disable selected tools |
| `--no-tools` | Disable all tools |
| `--print`, `-p` | Process one prompt and exit |
| `--mode json` | Emit JSON event lines |
| `--mode rpc` | Run the RPC interface over stdin/stdout |
| `--continue`, `-c` | Continue the most recent session |
| `--resume`, `-r` | Select a session to resume |
| `--session <path-or-id>` | Use a specific session |
| `--session-dir <dir>` | Override session storage |
| `--no-session` | Do not save the session |
| `--name <name>` | Set a session name |
| `--export <file>` | Export a session and exit |
| `--list-models [search]` | List available models |
| `--no-context-files` | Disable `AGENTS.md` and `CLAUDE.md` loading |
| `--offline` | Disable startup network operations |

## Environment

| Variable | Purpose |
| --- | --- |
| `CODEIFY_API_KEY` | API key for non-interactive use |
| `CODEIFY_BASE_URL` | Override the Codeify-compatible API base URL |
| `CODEIFY_MODEL` | Override the default model |
| `CODEIFY_CATALOG_BASE_URL` | Override the remote model catalog base URL (defaults to `https://pi.dev`) |
| `CODEIFY_CATALOG_PROVIDER` | Select the provider catalog to join with Codeify model IDs (defaults to `opencode`) |
| `CODEIFY_CODING_AGENT_DIR` | Override `~/.codeify/agent` |
| `CODEIFY_SESSION_DIR` | Override session storage |
| `CODEIFY_OFFLINE` | Disable startup network operations |
| `CODEIFY_TIMING` | Print startup timing diagnostics |
