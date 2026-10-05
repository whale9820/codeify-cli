# RPC Mode

RPC mode exposes Codeify over newline-delimited JSON on stdin and stdout.

```bash
codeify --mode rpc
```

Each request contains a `type` and, where applicable, an `id`. Responses and agent events are emitted as one JSON object per line. Do not mix human-readable output with the RPC stream.

## Core commands

| Type | Purpose |
| --- | --- |
| `prompt` | Submit a user prompt |
| `steer` | Queue a steering message |
| `follow_up` | Queue a follow-up message |
| `abort` | Cancel the active operation |
| `user_input_response` | Answer a pending agent question |
| `get_state` | Read current session and model state |
| `get_messages` | Read session messages |
| `new_session` | Start a new session |
| `switch_session` | Open another session |
| `fork` | Fork from an earlier message |
| `clone` | Duplicate the active branch |
| `compact` | Compact context |
| `set_model` | Select a model |
| `set_thinking_level` | Change reasoning effort |
| `bash` | Execute a shell command through the session |

Example request:

```json
{"type":"prompt","id":"1","message":"Summarize this repository"}
```

## Events

The stream reports agent lifecycle, message updates, tool execution, retry, queue, compaction, and session changes. Consumers should ignore unknown event fields so newer Codeify versions can add metadata without breaking clients.

Use the exported `RpcCommand`, `RpcResponse`, and `AgentSessionEvent` TypeScript types for the exact protocol shape implemented by the installed version.

## Questions

The agent can call `request_user_input` to ask up to three questions. It waits for explicit answers before continuing. RPC emits:

```json
{"type":"user_input_requested","request":{"id":"call_123","questions":[{"question":"Which destination?","options":["Local","Remote"]}]}}
```

Reply with one nonempty string per question, in order. Answers may be custom text:

```json
{"type":"user_input_response","id":"2","requestId":"call_123","answers":["Custom destination"]}
```

`get_state` includes `pendingUserInput` while a question is waiting. Invalid or expired responses return an error. Use `abort` to cancel; cancellation supplies no answer. The TypeScript client provides `answerUserInput(requestId, answers)`.
