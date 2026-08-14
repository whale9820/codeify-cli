# Models

Codeify CLI selects models from the authenticated Codeify catalog. Every model shown by the CLI uses the `codeify` provider, even when its model ID names a GPT, Claude, Gemini, or another model family.

## List Models

```bash
codeify --list-models
codeify --list-models gpt
```

Inside interactive mode, use `/model` to search and select a model.

## Select a Model

Pass a model ID or fuzzy pattern with `--model`:

```bash
codeify --model gpt-5.6-sol
codeify --model gpt-5.6-sol:high
```

The optional suffix selects reasoning effort. Supported levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; unsupported levels are clamped to the selected model's capabilities.

Set a fallback model for a custom Codeify-compatible gateway with `CODEIFY_MODEL`. Selecting a model with `/model` also saves it as the default in `~/.codeify/agent/settings.json`.

## Model Cycling

Use `--models` or `enabledModels` to constrain Ctrl+P model cycling. Patterns support fuzzy matching and globs:

```bash
codeify --models "gpt-*,claude-*"
codeify --models gpt-5.6-sol:high,claude-haiku-4-5-20251001:low
```

```json
{
  "enabledModels": ["gpt-*", "claude-*"]
}
```

## Catalog Metadata

The Codeify `/v1/models` response is authoritative for availability, pricing, context length, output limits, reasoning support, and input modalities. Additional metadata may be joined from the configured catalog source and is cached in `~/.codeify/agent/models-store.json`.

`CODEIFY_CATALOG_BASE_URL` overrides the metadata catalog base URL. `CODEIFY_CATALOG_PROVIDER` changes the metadata catalog source joined to Codeify model IDs.

## Custom Providers

The shipped CLI ignores `~/.codeify/agent/models.json`; custom providers and direct third-party credentials are not supported. Applications embedding the SDK can construct or register a custom `ModelRuntime` programmatically without changing the CLI provider set.
