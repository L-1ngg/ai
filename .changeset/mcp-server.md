---
'@tanstack/ai-mcp': major
'@tanstack/ai': minor
---

`@tanstack/ai-mcp` can create an MCP server with `createMCPServer` and `serveMCPStdio`. The client package moves from `@modelcontextprotocol/sdk` to `@modelcontextprotocol/client` and `@modelcontextprotocol/server`. The client tries spec 2026-07-28 first, then the 2025 handshake. When an MCP server asks for input, `chat()` pauses with an interrupt. A tool can set `execution: 'task'`.
