# Codeify CLI

Codeify CLI is the official terminal coding agent for [codeify.cc](https://codeify.cc). It runs locally in your repository, edits files, executes approved commands, manages sessions, and talks to Codeify through the OpenAI Responses API.

## Install

Git and Node.js 22.19 or newer are required. Re-running the installer updates an existing installation.

### macOS / Linux

Paste this into a terminal:

```sh
set -eu

CODEIFY_REPO="https://github.com/whale9820/codeify-cli.git"
CODEIFY_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/codeify-cli"
CODEIFY_BIN="${XDG_BIN_HOME:-$HOME/.local/bin}"

command -v git >/dev/null 2>&1 || { echo "Git is required." >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js 22.19 or newer is required." >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm is required." >&2; exit 1; }
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' || { echo "Node.js 22.19 or newer is required." >&2; exit 1; }

if [ -d "$CODEIFY_HOME/.git" ]; then
	git -C "$CODEIFY_HOME" pull --ff-only
elif [ -e "$CODEIFY_HOME" ]; then
	echo "$CODEIFY_HOME already exists and is not a Git checkout." >&2
	exit 1
else
	git clone --depth 1 "$CODEIFY_REPO" "$CODEIFY_HOME"
fi

npm --prefix "$CODEIFY_HOME" ci --ignore-scripts
npm --prefix "$CODEIFY_HOME" run build:offline
mkdir -p "$CODEIFY_BIN"
ln -sf "$CODEIFY_HOME/packages/coding-agent/dist/cli.js" "$CODEIFY_BIN/codeify"

case ":$PATH:" in
	*:"$CODEIFY_BIN":*) ;;
	*) echo "Add $CODEIFY_BIN to PATH, then open a new terminal." ;;
esac

"$CODEIFY_BIN/codeify" --version
```

### Windows

Paste this into PowerShell:

```powershell
$ErrorActionPreference = "Stop"

$repo = "https://github.com/whale9820/codeify-cli.git"
$installRoot = Join-Path $env:LOCALAPPDATA "CodeifyCLI"
$binDir = Join-Path $env:LOCALAPPDATA "Codeify\bin"

foreach ($command in @("git.exe", "node.exe", "npm.cmd")) {
	if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
		throw "$command is required. Install Git and Node.js 22.19 or newer first."
	}
}

$nodeVersion = [Version](& node.exe -p "process.versions.node")
if ($nodeVersion -lt [Version]"22.19.0") {
	throw "Node.js 22.19 or newer is required. Found $nodeVersion."
}

if (Test-Path (Join-Path $installRoot ".git")) {
	& git.exe -C $installRoot pull --ff-only
	if ($LASTEXITCODE -ne 0) { throw "Git update failed." }
} elseif (Test-Path $installRoot) {
	throw "$installRoot already exists and is not a Git checkout."
} else {
	& git.exe clone --depth 1 $repo $installRoot
	if ($LASTEXITCODE -ne 0) { throw "Git clone failed." }
}

& npm.cmd --prefix $installRoot ci --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
& npm.cmd --prefix $installRoot run build:offline
if ($LASTEXITCODE -ne 0) { throw "Codeify build failed." }

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$cliPath = Join-Path $installRoot "packages\coding-agent\dist\cli.js"
Set-Content -Path (Join-Path $binDir "codeify.cmd") -Encoding Ascii -Value "@echo off`r`nnode.exe `"$cliPath`" %*"

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathEntries = @($userPath -split ";" | Where-Object { $_ })
if ($pathEntries -notcontains $binDir) {
	$newPath = (@($pathEntries) + $binDir) -join ";"
	[Environment]::SetEnvironmentVariable("Path", $newPath, "User")
}
$env:Path = "$binDir;$env:Path"

& (Join-Path $binDir "codeify.cmd") --version
```

Then run `codeify` from any project directory.

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
