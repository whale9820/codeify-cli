# Models

Codeify CLI selects models from the authenticated Codeify catalog. Models are identified only by their slugs; the CLI does not display or search human-readable model names or provider labels.

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

The Codeify `/v1/models` response is authoritative for availability, pricing, context length, output limits, reasoning support, and input modalities. Metadata is cached in `~/.codeify/agent/models-store.json`; the CLI does not fetch third-party metadata catalogs. GPT-5.5 and every GPT-5.6 variant use a minimum context window of 1,050,000 tokens, matching GPT-6's 1.1M display value.

## Custom Providers

The shipped CLI ignores `~/.codeify/agent/models.json`; custom providers and direct third-party credentials are not supported. Applications embedding the SDK can explicitly opt into built-in providers or register a custom `ModelRuntime` programmatically without changing the CLI provider set.
