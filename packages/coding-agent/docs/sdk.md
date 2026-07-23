# SDK

The coding-agent package exposes the same session runtime used by the `codeify` command.

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  thinkingLevel: "high",
  sessionManager: SessionManager.inMemory(),
});

const unsubscribe = session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt("Summarize this repository");
} finally {
  unsubscribe();
  session.dispose();
}
```

## Options

| Option | Purpose |
| --- | --- |
| `cwd` | Working directory for tools and context discovery |
| `agentDir` | Settings, credentials, and session directory |
| `modelRuntime` | Model and authentication runtime |
| `model` | Explicit model selection |
| `thinkingLevel` | Reasoning effort |
| `tools` | Tool allowlist |
| `excludeTools` | Tool denylist |
| `customTools` | Additional tool definitions |
| `sessionManager` | Persistent or in-memory session storage |
| `settingsManager` | Settings source |

Use `session.prompt()`, `session.steer()`, and `session.followUp()` to submit work. Session events report messages, tool execution, retries, queue changes, compaction, and lifecycle state.

See [the SDK examples](../examples/sdk/README.md) for model, prompt, tool, skill, context, settings, and session configurations.
