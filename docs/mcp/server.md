---
title: Serve Tools over HTTP
id: mcp-server
order: 13
description: "Serve TanStack tools over HTTP with createMCPServer so a host can call them."
keywords:
  - tanstack ai
  - mcp
  - model context protocol
  - mcp server
  - createMCPServer
  - tanstack start
  - cloudflare workers
---

You have TanStack server tools. A host cannot call those tools over HTTP.

`createMCPServer` serves those tools over MCP. Return `server.fetch(request)` from your route.

```ts
// src/mcp-server.ts
import { toolDefinition } from '@tanstack/ai'
import { createMCPServer } from '@tanstack/ai-mcp/server'
import { z } from 'zod'

const getWeather = toolDefinition({
  name: 'get_weather',
  description: 'Get the weather for a city',
  inputSchema: z.object({
    city: z.string(),
  }),
}).server(async ({ city }) => {
  return `Sunny in ${city}`
})

const server = createMCPServer({
  name: 'weather',
  version: '1.0.0',
  tools: [getWeather],
})

export function handleMcp(request: Request) {
  return server.fetch(request)
}
```

Create the server once. `handleMcp` calls `fetch` for each request.

## Installation

Install these packages:

<!-- ::start:tabs variant="package-manager" mode="install" -->

react: @tanstack/ai-mcp @modelcontextprotocol/server
vue: @tanstack/ai-mcp @modelcontextprotocol/server
solid: @tanstack/ai-mcp @modelcontextprotocol/server
svelte: @tanstack/ai-mcp @modelcontextprotocol/server
preact: @tanstack/ai-mcp @modelcontextprotocol/server
angular: @tanstack/ai-mcp @modelcontextprotocol/server
vanilla: @tanstack/ai-mcp @modelcontextprotocol/server
octane: @tanstack/ai-mcp @modelcontextprotocol/server

<!-- ::end:tabs -->

## TanStack Start

1. Save the server code as `src/mcp-server.ts`.
2. Forward each request to `handleMcp`.

```ts ignore
// src/routes/api.mcp.ts
import { createFileRoute } from '@tanstack/react-router'
import { handleMcp } from '../mcp-server'

export const Route = createFileRoute('/api/mcp')({
  server: {
    handlers: {
      GET: ({ request }) => handleMcp(request),
      POST: ({ request }) => handleMcp(request),
      DELETE: ({ request }) => handleMcp(request),
    },
  },
})
```

The route path is `/api/mcp`.

## Cloudflare Workers

1. Save the server code as `src/mcp-server.ts`.
2. Call `handleMcp` for each request.

```ts ignore
// src/index.ts
import { handleMcp } from './mcp-server'

export default {
  async fetch(request: Request) {
    return handleMcp(request)
  },
}
```

The worker URL is the MCP URL.

The host can list `get_weather`. Then the host can call that tool.

To call this URL from `chat()`, see [MCP Server Tools](../tools/mcp).

If the host starts a local process, see [MCP Server on stdio](./server-stdio).
