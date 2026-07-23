# SDK Examples

Programmatic usage of Codeify via `createAgentSession()`.

## Examples

| File | Description |
|------|-------------|
| `01-minimal.ts` | Simplest usage with all defaults |
| `02-custom-model.ts` | Select model and thinking level |
| `03-custom-prompt.ts` | Replace or modify system prompt |
| `04-skills.ts` | Discover, filter, or replace skills |
| `05-tools.ts` | Built-in tool allowlists |
| `07-context-files.ts` | AGENTS.md context files |
| `08-slash-commands.ts` | File-based slash commands |
| `09-api-keys-and-oauth.ts` | API key resolution, OAuth config |
| `10-settings.ts` | Override compaction, retry, terminal settings |
| `11-sessions.ts` | In-memory, persistent, continue, list sessions |

## Running

```bash
cd packages/coding-agent
npx tsx examples/sdk/01-minimal.ts
```

## Quick Reference

```typescript
import { getModel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const modelRuntime = await ModelRuntime.create();

// Minimal
const { session } = await createAgentSession({ modelRuntime });

// Custom model
const model = getModel("anthropic", "claude-opus-4-5");
const { session } = await createAgentSession({ model, thinkingLevel: "high", modelRuntime });

// Modify prompt
const loader = new DefaultResourceLoader({
  systemPromptOverride: (base) => `${base}\n\nBe concise.`,
});
await loader.reload();
const { session } = await createAgentSession({ resourceLoader: loader, modelRuntime });

// Read-only
const { session } = await createAgentSession({ tools: ["read", "grep", "find", "ls"], modelRuntime });

// In-memory
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

// Run prompts
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});
await session.prompt("Hello");
```

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `modelRuntime` | Runtime using `agentDir/auth.json` and `models.json` | Canonical model and authentication runtime |
| `cwd` | `process.cwd()` | Working directory |
| `agentDir` | `~/.codeify/agent` | Config directory |
| `model` | From settings/first available | Model to use |
| `thinkingLevel` | From settings/"off" | off, low, medium, high |
| `tools` | `["read", "bash", "edit", "write"]` built-ins | Allowlist tool names |
| `customTools` | `[]` | Additional tool definitions |
| `resourceLoader` | DefaultResourceLoader | Resource loader for skills, prompts, themes, and context files |
| `sessionManager` | `SessionManager.create(cwd)` | Persistence |
| `settingsManager` | `SettingsManager.create(cwd, agentDir)` | Settings overrides |

## Events

```typescript
session.subscribe((event) => {
  switch (event.type) {
    case "message_update":
      if (event.assistantMessageEvent.type === "text_delta") {
        process.stdout.write(event.assistantMessageEvent.delta);
      }
      break;
    case "tool_execution_start":
      console.log(`Tool: ${event.toolName}`);
      break;
    case "tool_execution_end":
      console.log(`Result: ${event.result}`);
      break;
    case "agent_end":
      console.log("Done");
      break;
  }
});
```
