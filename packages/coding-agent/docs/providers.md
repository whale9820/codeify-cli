# Codeify Provider

Codeify CLI connects exclusively to the Codeify provider. Model IDs in the Codeify catalog may refer to different model families, but authentication, catalog discovery, and inference requests all use the Codeify service.

## Authentication

Run `/login` and choose one of:

- `Continue with Codeify OAuth`
- `Enter Codeify API key`

OAuth and API-key credentials saved by `/login` are stored in `~/.codeify/agent/auth.json`. Run `/logout` to remove the stored Codeify credential.

For automation, set an API key in the environment:

```bash
export CODEIFY_API_KEY=...
codeify -p "Summarize this repository"
```

A command-line override is also available:

```bash
codeify --api-key ... -p "Summarize this repository"
```

Credential resolution order is:

1. `--api-key`
2. The `codeify` entry in `~/.codeify/agent/auth.json`
3. `CODEIFY_API_KEY`

## Endpoint

The default API base URL is `https://codeify.cc/v1`. Override it only when testing a compatible Codeify gateway:

```bash
export CODEIFY_BASE_URL=https://gateway.example/v1
codeify
```

`CODEIFY_MODEL` changes the fallback model used before an authenticated catalog has been loaded.

## Model Catalog

Codeify retrieves available models from `GET /v1/models` and caches the catalog in `~/.codeify/agent/models-store.json` for offline startup. Use `/model` or `--list-models` to inspect models currently available to your account.

The CLI does not register built-in third-party providers and does not load custom providers from `~/.codeify/agent/models.json`. The lower-level SDK still supports programmatic runtime registration for applications embedding `codeify-coding-agent`.

## Network Settings

Use `httpProxy` in global settings when Codeify must connect through an HTTP proxy. `CODEIFY_OFFLINE=1` disables startup network operations and uses the cached Codeify model catalog when available.
