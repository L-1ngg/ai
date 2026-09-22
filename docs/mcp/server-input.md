---
title: Ask for Input
id: mcp-server-input
order: 13
description: "Ask the user for a value inside an MCP server tool with requestInput."
keywords:
  - tanstack ai
  - mcp
  - model context protocol
  - requestInput
  - confirmation
  - input required
---

Before your tool deletes a file, your tool must get a confirmation from the user. Call `requestInput` on `ctx` for that confirmation. `ctx` is the second argument of `.server()`.

```ts ignore
import { toolDefinition } from '@tanstack/ai'
import { createMCPServer } from '@tanstack/ai-mcp/server'
import { z } from 'zod'

const deleteFile = toolDefinition({
  name: 'delete_file',
  description: 'Delete a file after the user says yes',
  inputSchema: z.object({
    path: z.string(),
  }),
}).server(async ({ path }, ctx) => {
  const answer = await ctx.requestInput({
    message: `Delete ${path}? Type yes to continue.`,
  })

  if (answer !== 'yes') {
    return `Kept ${path}.`
  }

  return `Deleted ${path}.`
})

const server = createMCPServer({
  name: 'files',
  version: '1.0.0',
  tools: [deleteFile],
})

export function fetch(request: Request) {
  return server.fetch(request)
}
```

`requestInput` returns the string that the user sends.

## Spec 2025 and spec 2026

On spec 2025, `requestInput` waits on the open session. The same tool call then continues with the answer.

On spec 2026, the handler returns `input_required`. Then the client runs the tool again. On spec 2026, the code before `requestInput` runs twice.

If the work must run once, put that work after `requestInput` returns.

If the user sends `yes`, the tool returns `Deleted` plus the file path.
