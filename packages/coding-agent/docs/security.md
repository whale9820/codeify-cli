# Security

Codeify is a local coding agent. It can read and write repository files, execute processes, access the network, and use credentials available to the current user.

## Project trust

Project trust controls whether Codeify loads project-local settings, skills, prompts, themes, and system prompt files. It is an input-loading guard, not a sandbox. Once a session is running, the model can still request any enabled tool.

Declining trust skips project-local resources. `AGENTS.md` and `CLAUDE.md` context files are loaded unless context loading is disabled. Non-interactive modes use the saved `defaultProjectTrust` setting or the `--approve`/`--no-approve` override.

## No built-in sandbox

The built-in tools run as ordinary local processes with the permissions of Codeify. For untrusted repositories, generated code, or unattended automation, run the entire CLI inside a container, VM, or policy-controlled sandbox. See [Containerization](containerization.md).

## Reporting

Report security issues privately through the repository's security channel. Include the affected version, a reproducible description, impact, and relevant logs. Do not open a public issue for sensitive reports.
