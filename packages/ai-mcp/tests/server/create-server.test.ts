import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { PROTOCOL_VERSION_META_KEY } from '@modelcontextprotocol/server'
import { toolDefinition } from '@tanstack/ai'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  promptDefinition,
  resourceDefinition,
} from '../../src/server/definitions'
import { createMCPServer } from '../../src/server/create-server'
import type { SampleRequest } from '../../src/server/context'
import { inMemoryTaskStore } from '../../src/server/stores'

const serverUrl = new URL('https://mcp.example.com/mcp')
const protectedResourceUrl =
  'https://mcp.example.com/.well-known/oauth-protected-resource'

const summaryRequest: SampleRequest = {
  messages: [{ role: 'user', content: 'Draft a summary' }],
}

function echoTool() {
  return toolDefinition({
    name: 'echo',
    description: 'Echo text',
    inputSchema: z.object({ text: z.string() }),
  }).server(async (args) => args.text)
}

function readmeResource() {
  return resourceDefinition({
    uri: 'file:///readme.md',
    name: 'readme',
    mimeType: 'text/markdown',
  }).read(async () => ({ text: 'hello' }))
}

function summarizePrompt() {
  return promptDefinition({
    name: 'summarize',
    description: 'Summarize a topic',
    argsSchema: z.object({ topic: z.string() }),
  }).render(async (args) => [{ role: 'user', content: args.topic }])
}

function surfaceServer() {
  return createMCPServer({
    name: 'weather',
    version: '1.0.0',
    tools: [echoTool()],
    resources: [readmeResource()],
    prompts: [summarizePrompt()],
  })
}

// Each token names its own subject.
const subjectAuth = {
  verifyToken: async (token: string) => ({ subject: token }),
}

function initializeRequest(token: string) {
  return new Request(serverUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1.0.0' },
      },
    }),
  })
}

function sessionRequest(token: string, sessionId: string) {
  return new Request(serverUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
      'mcp-protocol-version': '2025-11-25',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  })
}

async function openSession(
  server: { fetch(request: Request): Promise<Response> },
  token: string,
) {
  const opened = await server.fetch(initializeRequest(token))
  const sessionId = opened.headers.get('mcp-session-id')
  if (sessionId === null) throw new Error('The server opened no session')
  return sessionId
}

function modernTaskGet(token: string, taskId: string) {
  return new Request(serverUrl, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tasks/get',
      params: {
        taskId,
        _meta: { [PROTOCOL_VERSION_META_KEY]: '2026-07-28' },
      },
    }),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasSample(
  ctx: object,
): ctx is { sample: (request: SampleRequest) => Promise<unknown> } {
  return 'sample' in ctx && typeof ctx.sample === 'function'
}

function deferredText() {
  const box: { resolve?: (value: { text: string }) => void } = {}
  const work = new Promise<{ text: string }>((resolve) => {
    box.resolve = resolve
  })
  const resolve = box.resolve
  if (resolve === undefined) {
    throw new Error('The deferred work has no resolve')
  }
  return { work, resolve }
}

function rpcResult(text: string) {
  const payload = text.trim().startsWith('{') ? text : sseData(text)
  if (payload === undefined) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  return parsed.result
}

function sseData(text: string) {
  const lines = text.split('\n')
  const data = lines.find((line) => line.startsWith('data:'))
  if (data === undefined) return undefined
  return data.slice('data:'.length).trim()
}

function taskResultFrom(bodies: ReadonlyArray<string>) {
  const results = bodies.map((body) => rpcResult(body))
  for (const result of results) {
    if (isRecord(result) && result.resultType === 'task') return result
  }
  return undefined
}

async function withClient(
  server: { fetch(request: Request): Promise<Response> },
  hooks: {
    era: '2025' | '2026'
    authToken?: string
    onResponse?: (text: string) => void
    prepare?: (client: Client) => void
  },
  run: (
    client: Client,
    transport: StreamableHTTPClientTransport,
  ) => Promise<void>,
) {
  const versionNegotiation =
    hooks.era === '2026' ? { mode: { pin: '2026-07-28' } } : undefined
  const client = new Client(
    { name: 'tester', version: '1.0.0' },
    {
      versionNegotiation,
      capabilities: { sampling: {} },
    },
  )
  hooks.prepare?.(client)
  const transport = new StreamableHTTPClientTransport(serverUrl, {
    authProvider:
      hooks.authToken === undefined
        ? undefined
        : { token: async () => hooks.authToken },
    fetch: async (input, init) => {
      const response = await server.fetch(new Request(input, init))
      if (hooks.onResponse !== undefined) {
        hooks.onResponse(await response.clone().text())
      }
      return response
    },
  })
  await client.connect(transport)
  try {
    await run(client, transport)
  } finally {
    await client.close()
  }
}

describe('createMCPServer', () => {
  it('lists and calls a tool for a spec 2026 request', async () => {
    const server = surfaceServer()

    await withClient(server, { era: '2026' }, async (client) => {
      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(['echo'])

      const echoed = await client.callTool({
        name: 'echo',
        arguments: { text: 'hi' },
      })
      expect(echoed.content).toEqual([{ type: 'text', text: 'hi' }])

      const resources = await client.listResources()
      expect(resources.resources.map((resource) => resource.name)).toEqual([
        'readme',
      ])
      const readme = await client.readResource({ uri: 'file:///readme.md' })
      expect(readme.contents).toEqual([
        { uri: 'file:///readme.md', mimeType: 'text/markdown', text: 'hello' },
      ])

      const prompts = await client.listPrompts()
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
        'summarize',
      ])
      const summary = await client.getPrompt({
        name: 'summarize',
        arguments: { topic: 'weather' },
      })
      expect(summary.messages).toEqual([
        { role: 'user', content: { type: 'text', text: 'weather' } },
      ])
    })
  })

  it('lists and calls a tool for a spec 2025 session', async () => {
    const server = surfaceServer()

    await withClient(server, { era: '2025' }, async (client, transport) => {
      expect(transport.sessionId).toEqual(expect.any(String))

      const listed = await client.listTools()
      expect(listed.tools.map((tool) => tool.name)).toEqual(['echo'])

      const echoed = await client.callTool({
        name: 'echo',
        arguments: { text: 'hi' },
      })
      expect(echoed.content).toEqual([{ type: 'text', text: 'hi' }])
    })
  })

  it('returns a task handle before the task tool finishes', async () => {
    const taskStore = inMemoryTaskStore()
    const gate = deferredText()
    let finished = false
    const calls: Array<Promise<unknown>> = []
    const bodies: Array<string> = []
    const server = createMCPServer({
      name: 'tasks',
      version: '1.0.0',
      taskStore,
      waitUntil(promise) {
        calls.push(promise)
      },
      tools: [
        toolDefinition({
          name: 'slow',
          description: 'Slow work',
          execution: 'task',
        }).server(async () => {
          const result = await gate.work
          finished = true
          return result
        }),
      ],
    })

    await withClient(
      server,
      {
        era: '2026',
        onResponse(text) {
          bodies.push(text)
        },
      },
      async (client) => {
        try {
          await client.callTool({ name: 'slow', arguments: {} })
        } catch {
          // Spec 2026 returns resultType "task". The client may reject that
          // result. The HTTP body is the handle.
        }
      },
    )

    expect(finished).toBe(false)
    const result = taskResultFrom(bodies)
    expect(result).toMatchObject({
      resultType: 'task',
      status: 'working',
      ttlMs: null,
    })
    if (!isRecord(result) || typeof result.taskId !== 'string') {
      throw new Error('The task handle has no task id')
    }
    const taskId = result.taskId
    expect(taskId.length).toBeGreaterThan(0)
    expect(await taskStore.get(taskId)).toEqual({
      taskId,
      status: 'working',
      createdAt: expect.any(String),
      lastUpdatedAt: expect.any(String),
      ttlMs: null,
    })

    const inflight = calls[0]
    if (inflight === undefined) {
      throw new Error('waitUntil did not receive a promise')
    }
    gate.resolve({ text: 'done' })
    await inflight

    expect(finished).toBe(true)
    expect(await taskStore.get(taskId)).toEqual({
      taskId,
      status: 'completed',
      createdAt: expect.any(String),
      lastUpdatedAt: expect.any(String),
      ttlMs: null,
      result: { text: 'done' },
    })
  })

  it('rejects a missing bearer token with 401', async () => {
    const server = createMCPServer({
      name: 'secure',
      version: '1.0.0',
      auth: { verifyToken: async (token) => token === 'secret' },
      tools: [echoTool()],
    })

    const missing = await server.fetch(
      new Request(serverUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: '{}',
      }),
    )
    expect(missing.status).toBe(401)
    expect(missing.headers.get('WWW-Authenticate')).toBe('Bearer')

    await withClient(
      server,
      { era: '2026', authToken: 'secret' },
      async (client) => {
        const listed = await client.listTools()
        expect(listed.tools.map((tool) => tool.name)).toEqual(['echo'])
      },
    )
  })

  it('does not serve the protected resource metadata document', async () => {
    const server = surfaceServer()
    const response = await server.fetch(new Request(protectedResourceUrl))
    const body = await response.text()

    expect(response.status).toBe(404)
    expect(body).not.toContain('authorization_servers')
    expect(body).not.toContain('bearer_methods_supported')
  })

  it('uses the sample adapter for a spec 2026 sample and does not ask the client', async () => {
    const seen: Array<SampleRequest> = []
    const clientAsks: Array<string> = []
    const server = createMCPServer({
      name: 'writer',
      version: '1.0.0',
      sample: async (request) => {
        seen.push(request)
        return 'from-adapter'
      },
      tools: [
        toolDefinition({
          name: 'draft',
          description: 'Draft a summary',
        }).server(async (_args, ctx) => {
          if (ctx === undefined || !hasSample(ctx)) {
            throw new Error('The tool context has no sample function.')
          }
          return ctx.sample(summaryRequest)
        }),
      ],
    })

    await withClient(
      server,
      {
        era: '2026',
        prepare(client) {
          client.setRequestHandler('sampling/createMessage', async () => {
            clientAsks.push('client')
            return {
              role: 'assistant',
              content: { type: 'text', text: 'from-client' },
              model: 'client',
            }
          })
        },
      },
      async (client) => {
        const drafted = await client.callTool({ name: 'draft', arguments: {} })
        expect(drafted.content).toEqual([
          { type: 'text', text: 'from-adapter' },
        ])
      },
    )

    expect(seen).toEqual([summaryRequest])
    expect(clientAsks).toEqual([])
  })

  it('gives a spec 2025 session only to the subject that opened it', async () => {
    const server = createMCPServer({
      name: 'secure',
      version: '1.0.0',
      auth: subjectAuth,
      tools: [echoTool()],
    })
    const sessionId = await openSession(server, 'alice')

    const own = await server.fetch(sessionRequest('alice', sessionId))
    expect(own.status).toBe(200)
    const other = await server.fetch(sessionRequest('bob', sessionId))
    expect(other.status).toBe(404)
  })

  it('closes a spec 2025 session after 30 idle minutes', async () => {
    const server = surfaceServer()
    const start = Date.now()
    const now = vi.spyOn(Date, 'now').mockReturnValue(start)
    try {
      const opened = await server.fetch(initializeRequest('any'))
      const sessionId = opened.headers.get('mcp-session-id')
      if (sessionId === null) throw new Error('The server opened no session')

      now.mockReturnValue(start + 31 * 60 * 1000)
      const late = await server.fetch(sessionRequest('any', sessionId))
      expect(late.status).toBe(404)
    } finally {
      now.mockRestore()
    }
  })

  it('shows a task only to the subject that started it', async () => {
    const taskStore = inMemoryTaskStore()
    const bodies: Array<string> = []
    const server = createMCPServer({
      name: 'tasks',
      version: '1.0.0',
      auth: subjectAuth,
      taskStore,
      tools: [
        toolDefinition({
          name: 'slow',
          description: 'Slow work',
          execution: 'task',
        }).server(async () => 'done'),
      ],
    })

    await withClient(
      server,
      {
        era: '2026',
        authToken: 'alice',
        onResponse(text) {
          bodies.push(text)
        },
      },
      async (client) => {
        await client
          .callTool({ name: 'slow', arguments: {} })
          .catch(() => undefined)
      },
    )
    const handle = taskResultFrom(bodies)
    if (!isRecord(handle) || typeof handle.taskId !== 'string') {
      throw new Error('The task handle has no task id')
    }

    const own = rpcResult(
      await (await server.fetch(modernTaskGet('alice', handle.taskId))).text(),
    )
    expect(own).toMatchObject({
      status: 'completed',
      result: { content: [{ type: 'text', text: 'done' }] },
    })
    const other = await (
      await server.fetch(modernTaskGet('bob', handle.taskId))
    ).json()
    expect(other).toMatchObject({ error: { message: 'Task not found' } })
  })

  it('gives a task tool its own context, not the finished request', async () => {
    const taskStore = inMemoryTaskStore()
    const seen: Array<{ aborted: boolean; message: string }> = []
    const calls: Array<Promise<unknown>> = []
    const server = createMCPServer({
      name: 'tasks',
      version: '1.0.0',
      taskStore,
      waitUntil(promise) {
        calls.push(promise)
      },
      tools: [
        toolDefinition({
          name: 'ask',
          description: 'Asks in a task',
          execution: 'task',
        }).server(async (_args, ctx) => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          const aborted = ctx?.abortSignal?.aborted ?? true
          try {
            if (ctx === undefined || !('requestInput' in ctx)) {
              throw new Error('no requestInput')
            }
            const requestInput = ctx.requestInput
            if (typeof requestInput !== 'function') {
              throw new Error('no requestInput')
            }
            await requestInput({ message: 'City?' })
          } catch (error) {
            seen.push({
              aborted,
              message: error instanceof Error ? error.message : '',
            })
          }
          return 'done'
        }),
      ],
    })

    await withClient(server, { era: '2026' }, async (client) => {
      await client
        .callTool({ name: 'ask', arguments: {} })
        .catch(() => undefined)
    })
    await Promise.all(calls)

    expect(seen).toEqual([
      {
        aborted: false,
        message:
          'ctx.requestInput is not supported in an execution: "task" tool.',
      },
    ])
  })
})
