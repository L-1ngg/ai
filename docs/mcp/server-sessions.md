---
title: MCP Server Sessions
id: mcp-server-sessions
order: 13
description: "Keep a spec 2025 session in your store so each instance can read the session id."
keywords:
  - tanstack ai
  - mcp
  - model context protocol
  - createMCPServer
  - sessionStore
  - spec 2025
  - inMemoryProtocolSessionStore
---

A spec 2025 client sends the same session id on later requests. The default store keeps that session in one process. A second instance cannot read that session.

On the edge, pass `sessionStore` to `createMCPServer`.

```ts
import {
  createMCPServer,
  type ProtocolSessionStore,
} from '@tanstack/ai-mcp/server'

type TextStore = {
  get(id: string): Promise<string | null>
  put(id: string, value: string): Promise<void>
  delete(id: string): Promise<void>
}

export function createNotesServer(textStore: TextStore) {
  const sessionStore: ProtocolSessionStore = {
    async get(id: string) {
      const raw = await textStore.get(id)
      if (raw === null) return null
      const value: unknown = JSON.parse(raw)
      return value
    },
    async set(id: string, value: unknown) {
      await textStore.put(id, JSON.stringify(value))
    },
    async delete(id: string) {
      await textStore.delete(id)
    },
  }

  return createMCPServer({
    name: 'notes',
    version: '1.0.0',
    sessionStore,
  })
}
```

1. Call `createNotesServer` once.
2. Call `fetch` on that server for each request.

`inMemoryProtocolSessionStore()` is the default for one process.

The store has three methods:

- `get` returns the value for the session id. When the id is absent, `get` returns `null`.
- `set` saves the value. A later `set` for the same id replaces that value.
- `delete` deletes the value for that id. An absent id stays absent.

This package does not ship these products:

- Redis
- Workers KV
- a Durable Object

When a session opens, the server calls `set` with `{ protocolVersion: '2025-11-25' }`. Then the client sends that id on the `mcp-session-id` header.

When the request reaches a server that did not open the session, the response status is 404.

The saved value stays in your store. When every instance uses that store, each instance can `get` the saved value.
