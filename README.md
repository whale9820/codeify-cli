# Codeify CLI

Codeify CLI is the official terminal coding agent for [codeify.cc](https://codeify.cc). It runs locally in your repository, edits files, executes approved commands, manages sessions, and talks to Codeify through the OpenAI Responses API.

## Install

Run the same command in PowerShell, Command Prompt, Terminal, Bash, or Zsh:

```text
node -e "fetch('https://codeify.cc/install.cjs').then(r=>r.ok?r.text():Promise.reject(Error('Download failed: '+r.status))).then(s=>Function('require',s)(require))"
```

Git and Node.js 22.19 or newer are required. Re-running the command updates an existing installation. Then run `codeify` from any project directory.

## First run

On the first interactive launch, Codeify offers two authentication choices:

- Continue with Codeify OAuth
- Enter a Codeify API key

Both credentials are saved under `~/.codeify/agent/auth.json` and can be replaced later with `/login` or removed with `/logout`. `CODEIFY_API_KEY` is also supported for CI and one-off sessions.

## Features

- OpenAI Responses API streaming with tool calls and reasoning levels
- Read, write, edit, search, and shell tools
- Session resume, fork, tree, export, and sharing workflows
- Slash commands, themes, skills, and prompt templates
- Configurable approval, project trust, model catalogs, and provider authentication
- Interactive terminal UI with Ctrl+C and Escape cancellation

## Development

```bash
npm install --ignore-scripts
npm run build:offline
npm run check
./test.sh
```

The compiled launcher is used by default for fast startup; set `CODEIFY_USE_SOURCE=1` when developing against TypeScript sources.

Useful commands:

```bash
codeify --help
codeify update
codeify --list-models
codeify --version
CODEIFY_TIMING=1 codeify
```

The Codeify provider defaults to `https://codeify.cc/v1` and `gpt-5.6-sol`. Override them with `CODEIFY_BASE_URL` and `CODEIFY_MODEL` when testing compatible gateways.

## Packages

| Package | Description |
| --- | --- |
| `packages/coding-agent` | Interactive Codeify CLI |
| `packages/agent` | Agent runtime and session state |
| `packages/ai` | Multi-provider LLM and Responses API layer |
| `packages/tui` | Terminal UI and rendering primitives |

## Maintenance

The source is public for transparency and internal use. Codeify maintains this repository privately and does not currently solicit contributions or expect to accept unsolicited pull requests.

Codeify does not sandbox filesystem, process, network, or credential access. Run it only in repositories and environments you trust. See [SECURITY.md](SECURITY.md) and [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for boundaries and isolation options.

## License

MIT. Portions of the implementation are derived from MIT-licensed open-source work by Mario Zechner and contributors.
