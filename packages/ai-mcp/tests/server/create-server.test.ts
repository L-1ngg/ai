import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { toolDefinition } from '@tanstack/ai'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  promptDefinition,
  resourceDefinition,
} from '../../src/server/definitions'
import { createMCPServer } from '../../src/server/create-server'
import type { SampleRequest } from '../../src/server/context'
import {
  inMemoryProtocolSessionStore,
  inMemoryTaskStore,
} from '../../src/server/stores'

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

function surfaceServer(
  sessionStore?: ReturnType<typeof inMemoryProtocolSessionStore>,
) {
  return createMCPServer({
    name: 'weather',
    version: '1.0.0',
    tools: [echoTool()],
    resources: [readmeResource()],
    prompts: [summarizePrompt()],
    sessionStore,
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
    const sessionStore = inMemoryProtocolSessionStore()
    const server = surfaceServer(sessionStore)

    await withClient(server, { era: '2025' }, async (client, transport) => {
      const sessionId = transport.sessionId
      if (sessionId === undefined || sessionId.length === 0) {
        throw new Error('The 2025 session has no session id')
      }
      expect(await sessionStore.get(sessionId)).toEqual({
        protocolVersion: '2025-11-25',
      })

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
})
