---
title: MCP Server Tasks
id: server-tasks
order: 13
description: "A long MCP tool returns a task handle so the host can poll for the result."
keywords:
  - tanstack ai
  - mcp
  - model context protocol
  - mcp server
  - execution
  - task handle
  - createMCPServer
  - inMemoryTaskStore
  - waitUntil
---

Your long tool holds the HTTP call until the work ends. You have no task id for the host to poll.

Set `execution: 'task'` on `toolDefinition`.

The handler returns a task handle before the work ends. The tool function continues in this process. There is no queue.

```ts
import { toolDefinition } from '@tanstack/ai'
import { createMCPServer, inMemoryTaskStore } from '@tanstack/ai-mcp/server'

const taskStore = inMemoryTaskStore()

const buildReport = toolDefinition({
  name: 'build_report',
  description: 'Build a long report',
  execution: 'task',
}).server(async () => {
  const text = await writeReport()
  return { text }
})

async function writeReport() {
  await new Promise((resolve) => {
    setTimeout(resolve, 5000)
  })
  return 'Quarterly report'
}

export default {
  async fetch(
    request: Request,
    _env: unknown,
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) {
    const server = createMCPServer({
      name: 'reports',
      version: '1.0.0',
      tools: [buildReport],
      taskStore,
      waitUntil: (promise) => ctx.waitUntil(promise),
    })
    return server.fetch(request)
  },
}
```

Your tool function returns the final value. When the tool function ends, the store saves that value.

## What a task tool can use

The task keeps running after the call returns the task handle. So the task does not use the request that started it.

- `ctx.requestInput` throws an error. Ask for input in a tool without `execution: 'task'`.
- `ctx.sample` calls the `sample` option of `createMCPServer`. If you do not pass `sample`, `ctx.sample` throws an error.
- `ctx.abortSignal` does not abort when the call request ends.

## Keep the Worker alive

If you run on a Worker, pass `waitUntil` from the Worker context.

The server calls `waitUntil` with the tool promise. After the store saves the tool result or the tool error, this promise settles.

If you omit `waitUntil`, a Worker can stop before the tool function ends. On one long-lived process, you can omit `waitUntil`.

## Keep the task record

1. Create the store with `inMemoryTaskStore` outside `fetch`.
2. Pass this store as `taskStore`.

A new store on each request has no record of the old task.

The package `@tanstack/ai-mcp/server` exports `inMemoryTaskStore`. The default store keeps each task in memory for this process. If you build the server once, you can omit `taskStore`.

If more than one instance can receive `tasks/get`, pass a `taskStore` that those instances share.

- `get`: read one task by id.
- `set`: save one task.
- `delete`: remove one task.

## Read the result

The call response returns a task id with status `working`. This status means that the tool function is still at work.

```json
{
  "resultType": "task",
  "taskId": "task-id",
  "status": "working",
  "createdAt": "2026-09-22T12:00:00.000Z",
  "lastUpdatedAt": "2026-09-22T12:00:00.000Z",
  "ttlMs": null,
  "content": [{ "type": "text", "text": "task-id" }]
}
```

| Spec | Host action |
| --- | --- |
| `2026-07-28` | When `status` is `completed`, `tasks/get` includes `result` |
| `2025-11-25` | `tasks/get` returns the status. Then `tasks/result` returns the tool result. |

On spec 2026, the call sets `resultType` to `task`. `tasks/get` sets `resultType` to `complete`. That `result` wraps the value from the tool function as `content`. When the value is an object, `result` also has `structuredContent`.

On spec 2025, `structuredContent` includes these fields:

- `taskId`: the id from the call.
- `status`: `working`, `completed`, or `failed`.
- `ttl`: `null`.
- `createdAt`: the time of the first `set`.
- `lastUpdatedAt`: the time of the last `set`.

On spec 2025, the server sets `execution.taskSupport` to `required`. `tasks/result` wraps the value as `content`. When the value is an object, `tasks/result` also returns `structuredContent`. If the status is not `completed`, `tasks/result` returns the error `Task result is not ready`.

A task uses one status:

- `working`: the tool function is still at work.
- `completed`: the store holds the tool result.
- `failed`: the tool function threw an error.

If the tool function throws, the task keeps the text from that error. If that error has no text, the task keeps `The tool failed.` On spec 2026, this text is `error.message`. On spec 2026, `error.code` is `-32603`. On spec 2025, `tasks/get` puts this text in `statusMessage`.

An unknown task id on `tasks/get` returns the error `Task not found`. When `auth` names a subject, a task belongs to the subject that started it. Another subject also gets `Task not found`. [MCP Server Auth](./server-auth) shows how to set the subject.

The host polls until the status is `completed` or `failed`. A TanStack AI host polls until the task ends.

See [MCP Server Tools](../tools/mcp).

After the status is `completed`, the host reads `{ text: 'Quarterly report' }` from `structuredContent`.
