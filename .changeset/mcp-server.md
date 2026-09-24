---
'@tanstack/ai-mcp': minor
'@tanstack/ai': minor
---

`@tanstack/ai-mcp` can create an MCP server with `createMCPServer` and `serveMCPStdio`. The client package moves from `@modelcontextprotocol/sdk` to `@modelcontextprotocol/client` and `@modelcontextprotocol/server`. The client tries spec 2026-07-28 first, then the 2025 handshake. When an MCP server asks for input, `chat()` pauses with an `mcp_input` interrupt. Answer it with `resolveInterrupt` or `cancel()`, and the tool runs again with the answer in `ctx.inputResponse`. A tool can set `execution: 'task'`. `createMCPClient<typeof server>({ transport })` types a remote client from a `createMCPServer` server, and `createMCPClient({ server })` calls a server in the same process.
