# Quickstart

## Install

Build the CLI from this workspace:

```bash
npm install --ignore-scripts
npm run build:offline
```

The executable is `codeify`. Start it from the repository you want the agent to work on:

```bash
cd /path/to/project
codeify
```

## Authenticate

On the first interactive launch, choose one of:

- `Continue with Codeify OAuth`
- `Enter Codeify API key`

Credentials are stored in `~/.codeify/agent/auth.json`. Use `/login` to replace them or `/logout` to remove them. For automation, set `CODEIFY_API_KEY` or pass `--api-key`.

## First session

Type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

The default tools are `read`, `write`, `edit`, and `bash`. Read-only `grep`, `find`, and `ls` are also available. Codeify runs with the permissions of the current user, so review commands before approving them.

## Project instructions

Codeify loads `AGENTS.md` and `CLAUDE.md` context files from the current directory and its parents. Put repository-specific commands and conventions there. Use `--no-context-files` to disable discovery for one run.

## Common workflows

```bash
codeify @README.md "Summarize this"
codeify -c
codeify -r
codeify --name "auth refactor"
codeify -p "Review this codebase"
cat README.md | codeify -p "Summarize this text"
```

Inside the TUI, `/model`, `/thinking`, `/effort`, `/settings`, `/resume`, `/new`, `/tree`, `/fork`, `/export`, `/reload`, `/hotkeys`, `/login`, `/logout`, and `/quit` are available. Use `/thinking` or `/effort` to change reasoning effort. Ctrl+C and Escape cancel the active operation; press Ctrl+C twice to leave.

See [Using Codeify](usage.md) for the complete command and option reference.
