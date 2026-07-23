# Session Format

Codeify stores sessions as append-only JSONL files under `~/.codeify/agent/sessions/` by default. The first entry is the session header; later entries form a tree through `id` and `parentId` fields.

## Common entries

- `message`: user, assistant, and tool-result messages
- `model_change`: active provider and model
- `thinking_level_change`: reasoning effort
- `compaction`: summarized context boundary
- `branch_summary`: summary of an abandoned branch
- `label`: user-visible entry label
- `session_info`: session display metadata

Entries include an ID, parent ID, and timestamp. The active branch is reconstructed by following parent links from the current leaf to the header. Codeify can therefore branch, fork, and resume without rewriting prior history.

Session files may gain new entry types or fields. Consumers should ignore fields they do not understand and preserve unknown entries when rewriting data.

Use the exported `SessionManager` API to create, open, fork, list, and inspect sessions instead of editing JSONL directly.
