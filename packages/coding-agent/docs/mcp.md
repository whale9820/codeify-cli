# MCP servers

Configure stdio MCP servers in `~/.codeify/agent/mcp.json`:

```json
{
  "mcpServers": {
    "example": {
      "command": "example-mcp-server",
      "args": [],
      "timeoutMs": 600000
    }
  }
}
```

Tool calls allow ten minutes (600,000 milliseconds) by default, including tools that produce no progress notifications. Each progress notification restarts that timeout. Set `timeoutMs` per server to a positive integer in milliseconds, up to 2,147,483,647, for a different limit. Invalid values produce a diagnostic and use the default.

Press Escape to cancel an in-flight tool call. Codeify forwards cancellation to the MCP server; the server controls whether its underlying work stops.

Connection setup and tool discovery retain the SDK's default timeout.
