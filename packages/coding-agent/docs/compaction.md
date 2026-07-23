# Compaction

Compaction replaces older conversation context with a structured summary when a session approaches the model's context limit. Recent messages remain verbatim so current work keeps its immediate detail.

Use `/compact` to compact manually or configure automatic compaction in `/settings`.

## Settings

| Setting | Purpose |
| --- | --- |
| `compaction.enabled` | Enable automatic compaction |
| `compaction.reserveTokens` | Keep output capacity available for the next response |
| `compaction.keepRecentTokens` | Preserve this much recent context verbatim |

## Branch summaries

When navigating a session tree, Codeify can summarize work from an abandoned branch before continuing elsewhere. The summary records the task, progress, decisions, remaining work, and critical context needed by the new branch.

Compaction and branch summaries are stored in the session JSONL and include usage metadata when the model reports it.
