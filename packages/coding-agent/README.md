# Codeify CLI

This package contains the interactive terminal application used by the `codeify` command.

## Runtime

Codeify runs in the current repository and provides read, write, edit, search, and shell tools. It stores sessions and credentials in `~/.codeify/agent/` and sends model requests through the Codeify OpenAI Responses API provider.

The first interactive launch presents:

- `Continue with Codeify OAuth`
- `Enter Codeify API key`

Use `/login` to change credentials later or `/logout` to remove stored credentials. `CODEIFY_API_KEY` can be supplied for automation.

## Commands

```text
/hotkeys     Show keyboard shortcuts and interactive commands
/model       Select a model
/thinking    Select reasoning effort
/effort      Alias for /thinking
/settings    Configure the session
/new        Start a new session
/resume     Resume a session
/export     Export a session to HTML
/quit       Leave Codeify
```

Use `/thinking` or `/effort` with an optional level (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`) to change reasoning effort. Ctrl+C and Escape cancel the active operation. Ctrl+C twice exits the application.

## Build

```bash
npm run build:offline
npm run check
```

The Codeify provider defaults to `https://codeify.cc/v1` and `gpt-5.6-sol`. Use `CODEIFY_BASE_URL` and `CODEIFY_MODEL` to point at a compatible test gateway.

## License

MIT. Portions of the implementation are derived from MIT-licensed open-source work by Mario Zechner and contributors.
