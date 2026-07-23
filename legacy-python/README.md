# Codeify CLI

The official agentic coding CLI for [Codeify](https://codeify.cc), built directly on the OpenAI Responses API format.

Codeify can inspect a repository, edit multiple files, run commands, validate its work, and carry context across tool calls and saved sessions. It works interactively for collaborative development and non-interactively for scripts and CI.

## Install

Python 3.10 or newer is required. The CLI has no runtime dependencies outside the standard library.

```bash
python3 -m pip install -e .
codeify --version
```

For a user-local installation:

```bash
make install-local
```

That target uses `uv tool install --editable .` so the `codeify` executable lands in `~/.local/bin`.

## Configure

```bash
codeify init
```

The API key is resolved in this order:

1. `--api-key`
2. `CODEIFY_API_KEY`
3. `OPENAI_API_KEY`
4. `~/.codeify/config.json`

The default endpoint is `https://codeify.cc/v1`. Override it with `CODEIFY_BASE_URL`, `OPENAI_BASE_URL`, `--endpoint`, or `codeify config set endpoint URL`.

The default model is `gpt-5.6-sol`. Override it with `CODEIFY_MODEL`, `--model`, or persistent configuration.

```bash
export CODEIFY_API_KEY="your-key"
codeify doctor --check-network
```

The network check validates the configured API key without generating a model response or consuming credits.

Saved configuration uses mode `0600`. Keys are redacted in all diagnostic and JSON output.

## Use

Start an interactive session in the current repository:

```bash
codeify
```

Run one complete task:

```bash
codeify "find the failing test, fix the cause, and verify it"
codeify exec --stdin < task.md
codeify run --file task.md --continue
```

Resume context:

```bash
codeify sessions list
codeify resume SESSION_ID
codeify resume SESSION_ID "now add regression tests"
```

Inspect the provider or make a raw compatible request:

```bash
codeify models
codeify --json api GET /models
codeify --json api POST /responses --data @request.json
```

Inside interactive mode, Codeify supports Pi-compatible `/settings`, `/model`, `/scoped-models`, `/export`, `/import`, `/share`, `/copy`, `/name`, `/session`, `/changelog`, `/hotkeys`, `/fork`, `/clone`, `/tree`, `/trust`, `/login`, `/logout`, `/new`, `/compact`, `/resume`, `/reload`, `/debug`, and `/quit` commands. Codeify also adds `/reasoning`, `/approval`, `/status`, `/diff`, `/clear`, and `/exit`. Prefix a command with `!` to run it through the same approval boundary as agent commands.

## Approvals

`--approval ask` is the default. Reads run immediately; file mutations and non-read-only commands ask first.

`--approval auto-edit` allows workspace file edits while still asking for commands with side effects.

`--approval full-auto` allows all workspace tools without prompting. Broad destructive system commands remain blocked.

`--approval plan` disables mutations and is suitable for repository analysis.

Non-interactive tasks cannot answer approval prompts. Use `--approval auto-edit` or `--approval full-auto` deliberately when automation needs to modify the workspace.

## Agent tools

The model receives focused tools for listing, reading, and searching files; atomic whole-file and exact multi-file edits; moves and deletes; shell commands with timeouts; Git status and diffs; and user questions in interactive mode.

All paths are resolved against the workspace and cannot escape through absolute paths or symlinks. Direct `.git` writes and credential-like files are blocked. Shell children do not inherit credential-like environment variables. Outputs are bounded before being sent back to the model.

## Sessions

Sessions are stored atomically under `~/.codeify/sessions`. Each record contains the provider response ID, workspace, model, transcript, timestamps, and cumulative token usage. API keys are never stored in session files.

The CLI uses `previous_response_id` for conversation and reasoning continuity. Tool results use Responses API `function_call_output` items linked by `call_id`.

## JSON contract

`--json` writes one JSON value to stdout. Progress is suppressed. Successful commands use an object with `ok: true`; errors use:

```json
{
  "ok": false,
  "error": {
    "message": "redacted human-readable error"
  }
}
```

Agent results include `session_id`, `response_id`, final `text`, token `usage`, and a bounded tool-call summary. Raw API responses are wrapped under `data`. Credentials are never included.

## Configuration

```bash
codeify config list
codeify config get model
codeify config set model gpt-5.6-sol
codeify config set reasoning high
codeify config set approval auto-edit
codeify config unset temperature
codeify logout
```

Supported settings are `api_key`, `endpoint`, `model`, `reasoning`, `approval`, `workspace`, `timeout`, `max_tool_loops`, `max_output_tokens`, `temperature`, `store`, `color`, and `telemetry`.

## Development

```bash
make check
```

The implementation intentionally uses the Python standard library so the installed command remains small, auditable, and usable from any repository.
