---
title: MCP Client Input
id: mcp-input
order: 12
description: "When an MCP server asks for input, chat() pauses so the UI can read the request."
keywords:
  - tanstack ai
  - mcp
  - interrupt
  - form
  - sampling
---

An MCP server can stop a tool call. The server asks for input.

- A form needs an answer from the user.
- A sampling request needs a model reply.

You want that request in the UI. `chat()` ends the run with an interrupt. `outcome.type` is `interrupt`. The payload has `kind` and `request`.

## Read the pause

Pass the MCP client to `chat()` in `mcp.clients`. [MCP Server Tools](./mcp) has that setup.

The stream ends on one `RUN_FINISHED` chunk. Read the interrupt there:

```ts
import { chat } from '@tanstack/ai'
import { openaiText } from '@tanstack/ai-openai'
import { createMCPClient } from '@tanstack/ai-mcp'

const messages = [{ role: 'user' as const, content: 'Ask the server' }]

const mcp = await createMCPClient({
  transport: {
    type: 'http',
    url: 'https://my-mcp-server.example.com/mcp',
  },
})

const stream = chat({
  adapter: openaiText('gpt-5.5'),
  messages,
  mcp: { clients: [mcp] },
})

for await (const chunk of stream) {
  if (chunk.type !== 'RUN_FINISHED') continue
  if (chunk.outcome?.type !== 'interrupt') continue

  for (const interrupt of chunk.outcome.interrupts) {
    if (interrupt.reason !== 'mcp_input') continue
    const payload = interrupt.metadata?.['tanstack:interruptPayload']
    console.log(interrupt.id, payload)
  }
}
```

The pause follows these rules:

- The input call has no tool result.
- The run does not emit `RUN_ERROR`.
- When other tools finish in that turn, the stream has those results.

The interrupt has these fields:

- `id`: `mcp_input_` and the tool call id
- `reason`: `mcp_input`
- `message`: `Input required to run` and the tool name
- `metadata.toolName`: the tool name
- `metadata['tanstack:interruptPayload']`: `kind` and `request`

`kind` is `form` or `sampling`. `request` is the MCP input body.

## Show the request

The route returns the `chat()` stream. [MCP Server Tools](./mcp) has that route.

1. Read `interrupts` from `useChat`.
2. Find the item where `reason` is `mcp_input`.
3. Read `metadata['tanstack:interruptPayload']`.
4. Show `kind` and `request`.

```tsx
import { fetchServerSentEvents, useChat } from '@tanstack/ai-react'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readMcpInput(
  metadata: Readonly<Record<string, unknown>> | undefined,
) {
  const payload = metadata?.['tanstack:interruptPayload']
  if (!isRecord(payload)) return undefined
  const kind = payload.kind
  if (kind !== 'form' && kind !== 'sampling') return undefined
  if (!('request' in payload)) return undefined
  return { kind, request: payload.request }
}

export function McpInputPrompt() {
  const { interrupts } = useChat({
    threadId: 'thread-1',
    connection: fetchServerSentEvents('/api/chat'),
  })

  return (
    <>
      {interrupts.map((interrupt) => {
        if (interrupt.reason !== 'mcp_input') return null
        const input = readMcpInput(interrupt.metadata)
        if (!input) return null
        const label = input.kind === 'form' ? 'User input' : 'Model input'
        return (
          <article key={interrupt.id}>
            <p>{interrupt.message}</p>
            <p>
              {label}: {JSON.stringify(input.request)}
            </p>
          </article>
        )
      })}
    </>
  )
}
```

The `useChat` item `kind` is `unbound`. This interrupt has no `resolveInterrupt`. Your UI reads `request`.

If `kind` is `form`, show `request` to the user. If `kind` is `sampling`, show `request` as the model request.

## A tool error

If the thrown value is a plain `Error`, the result is a tool error. The run does not pause.

`chat()` pauses only for this shape:

- `name`: `MCPInputRequiredError`
- `kind`: `form` or `sampling`
- `request`: the MCP input body

## Outside chat()

Outside `chat()`, the client throws `MCPInputRequiredError`. The name `ask` is the tool name on your server.

1. Call `tools()` on the MCP client.
2. Call `execute` on the tool.
3. Read `kind` and `request` on the error.
4. Close the client after the call.

```ts
import { createMCPClient } from '@tanstack/ai-mcp'

export async function callAsk() {
  const mcp = await createMCPClient({
    transport: {
      type: 'http',
      url: 'https://my-mcp-server.example.com/mcp',
    },
  })

  try {
    const tools = await mcp.tools()
    const ask = tools.find((tool) => tool.name === 'ask')
    if (!ask?.execute) return
    await ask.execute({})
  } catch (error) {
    if (!isMcpInputRequired(error)) throw error
    console.log(error.kind, error.request)
  } finally {
    await mcp.close()
  }
}

function isMcpInputRequired(value: unknown): value is {
  name: 'MCPInputRequiredError'
  kind: 'form' | 'sampling'
  request: unknown
} {
  if (typeof value !== 'object' || value === null) return false
  if (!('name' in value) || value.name !== 'MCPInputRequiredError') {
    return false
  }
  if (!('kind' in value)) return false
  if (value.kind !== 'form' && value.kind !== 'sampling') return false
  return 'request' in value
}
```
