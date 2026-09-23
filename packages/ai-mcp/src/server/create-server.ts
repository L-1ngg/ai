import { convertSchemaToJsonSchema } from '@tanstack/ai'
import type { AnyServerTool, SchemaInput } from '@tanstack/ai'
import {
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  ResourceTemplate,
  WebStandardStreamableHTTPServerTransport,
  acceptedContent,
  createMcpHandler,
  fromJsonSchema,
  inputRequired,
  isLegacyRequest,
} from '@modelcontextprotocol/server'
import type {
  JsonSchemaType,
  McpRequestContext,
  ServerContext,
} from '@modelcontextprotocol/server'
import type { ResourceServerAuth } from './auth'
import { authenticate } from './auth'
import { ToolInputRequiredError, createServerToolContext } from './context'
import type { SampleRequest, ToolInputRequest } from './context'
import { getTask, startTask, toCallToolResult } from './tasks'
import { inMemoryTaskStore } from './stores'
import type { TaskStore } from './stores'

const spec2026 = '2026-07-28'
// ponytail: idle sessions close only when a later request runs the sweep.
// A server that gets no traffic keeps them until the next request.
const sessionIdleMs = 30 * 60 * 1000
const protectedResourcePath = '/.well-known/oauth-protected-resource'
const inputKey = 'input'
const sampleMaxTokens = 1024

const inputFormSchema = {
  type: 'object' as const,
  properties: {
    value: { type: 'string' as const },
  },
  required: ['value'],
}

const emptyObjectSchema = fromJsonSchema({
  type: 'object',
  properties: {},
})

type ProtocolYear = '2025' | '2026'

type McpResource = {
  name: string
  mimeType: string
  uri?: string
  uriTemplate?: string
  read: () => unknown
}

// A method type is bivariant. A function property is strict, so a prompt
// with a specific input would not assign to `unknown`.
type BivariantCallback<TInput, TOutput> = BivariantCallbackSignature<
  TInput,
  TOutput
>['bivarianceHack']

declare abstract class BivariantCallbackSignature<TInput, TOutput> {
  abstract bivarianceHack(input: TInput): TOutput
}

type McpPrompt = {
  name: string
  description: string
  argsSchema: {
    parse: (input: unknown) => unknown
  }
  render: BivariantCallback<unknown, unknown>
}

type MCPServerOptions = {
  name: string
  version: string
  tools?: ReadonlyArray<AnyServerTool>
  resources?: ReadonlyArray<McpResource>
  prompts?: ReadonlyArray<McpPrompt>
  taskStore?: TaskStore
  auth?: ResourceServerAuth
  sample?: (request: SampleRequest) => Promise<unknown>
  waitUntil?: (promise: Promise<unknown>) => void
}

/**
 * One MCP server and the definitions it serves.
 *
 * `tools`, `resources`, and `prompts` keep the types from the arguments.
 * Export this object from one package and import it in another.
 * `createMCPClient({ server })` then uses those types.
 */
export type MCPServer<
  TTools extends ReadonlyArray<AnyServerTool> = ReadonlyArray<AnyServerTool>,
  TResources extends ReadonlyArray<McpResource> = ReadonlyArray<McpResource>,
  TPrompts extends ReadonlyArray<McpPrompt> = ReadonlyArray<McpPrompt>,
> = {
  readonly name: string
  readonly version: string
  readonly tools: TTools
  readonly resources: TResources
  readonly prompts: TPrompts
  fetch: (request: Request) => Promise<Response>
}

type LegacySession = {
  transport: WebStandardStreamableHTTPServerTransport
  server: McpServer
  owner: string | undefined
  lastUsed: number
}

type LegacySessions = Map<string, LegacySession>

// Keeps the options of each server for `directMCPClient`.
const serverOptionsByServer = new WeakMap<object, MCPServerOptions>()

/** Internal. Returns the options that `server` was created with. */
export function optionsOfServer(server: object) {
  return serverOptionsByServer.get(server)
}

/**
 * Builds an MCP HTTP server.
 *
 * `options.name` and `options.version` name the server.
 * `options.tools` is a list of `toolDefinition().server()` tools.
 * `options.resources` uses `resourceDefinition().read()`.
 * `options.prompts` uses `promptDefinition().render()`.
 * `options.taskStore` keeps task records. The default store is in memory.
 * `options.auth` checks the bearer token. A missing token gets a 401 response.
 * When auth names a subject, spec 2025 sessions and tasks belong to it.
 * Spec 2025 sessions live in this process. They close after 30 idle minutes.
 * `options.sample` is the model adapter for `ctx.sample` on spec 2026.
 * `options.waitUntil` receives the task promise so a worker can stay alive.
 *
 * The result has `fetch(request)`, `tools`, `resources`, and `prompts`.
 * Those three lists keep the types you passed in.
 * Export the result from one package and pass it to `createMCPClient({ server })` in another.
 * `fetch` serves tools, resources, and prompts.
 * It speaks spec `2026-07-28` and full spec 2025 sessions.
 * It does not serve `/.well-known/oauth-protected-resource`.
 * Mount `protectedResourceMetadata` on that path in the app.
 *
 * A tool with `execution: 'task'` returns a task handle before the work ends.
 * On spec 2026, `ctx.sample` calls `options.sample` and does not ask the client.
 * On spec 2025, `ctx.sample` asks the MCP client.
 * On spec 2026, `ctx.requestInput` stops the call until the client sends the answer.
 * On spec 2025, `ctx.requestInput` waits on the open session.
 *
 * @param options - Server name, version, tools, and the optional stores
 *
 * @example
 * ```ts
 * const server = createMCPServer({
 *   name: 'weather',
 *   version: '1.0.0',
 *   tools: [getWeather],
 * })
 *
 * return server.fetch(request)
 * ```
 */
export function createMCPServer<
  const TTools extends ReadonlyArray<AnyServerTool> = [],
  const TResources extends ReadonlyArray<McpResource> = [],
  const TPrompts extends ReadonlyArray<McpPrompt> = [],
>(
  options: Omit<MCPServerOptions, 'tools' | 'resources' | 'prompts'> & {
    tools?: TTools
    resources?: TResources
    prompts?: TPrompts
  },
) {
  const taskStore = options.taskStore ?? inMemoryTaskStore()
  const sessions: LegacySessions = new Map()
  const tools = options.tools ?? []
  const resources = options.resources ?? []
  const prompts = options.prompts ?? []
  const hasTaskTool = tools.some((tool) => tool.execution === 'task')

  const modern = createMcpHandler(
    (ctx) =>
      buildMcpServer({
        options,
        tools,
        resources,
        prompts,
        taskStore,
        era: ctx.era === 'modern' ? '2026' : '2025',
        hasTaskTool,
        owner: subjectOf(ctx),
      }),
    { legacy: 'reject', keepAliveMs: 0 },
  )

  const mcpServer = {
    name: options.name,
    version: options.version,
    tools,
    resources,
    prompts,
    /**
     * Serves one MCP HTTP request.
     *
     * A spec 2026 request uses the per-request envelope.
     * A spec 2025 request uses the session id header.
     * When `auth` is set, a missing or invalid bearer token returns 401.
     * `/.well-known/oauth-protected-resource` returns 404.
     *
     * @param request - The HTTP request to the MCP route
     */
    async fetch(request: Request) {
      if (isProtectedResourcePath(request)) {
        return new Response(null, { status: 404 })
      }
      await closeIdleSessions(sessions)

      let owner: string | undefined
      const auth = options.auth
      if (auth !== undefined) {
        const result = await authenticate(request, auth)
        if ('denied' in result) return result.denied
        owner = result.subject
      }

      const taskResponse = await modernTaskGet(request, taskStore, owner)
      if (taskResponse !== undefined) return taskResponse

      const legacy = await isLegacyRequest(request)
      if (legacy) {
        return legacyFetch(request, {
          open: () =>
            openLegacySession(request, {
              sessions,
              owner,
              build: () =>
                buildMcpServer({
                  options,
                  tools,
                  resources,
                  prompts,
                  taskStore,
                  era: '2025',
                  hasTaskTool,
                  owner,
                }),
            }),
          resume: (sessionId) =>
            resumeLegacySession(request, sessionId, sessions, owner),
        })
      }

      // authInfo is a pass-through. It carries the subject to the factory.
      return modern.fetch(
        request,
        owner === undefined
          ? undefined
          : {
              authInfo: {
                token: '',
                clientId: owner,
                scopes: [],
                extra: { subject: owner },
              },
            },
      )
    },
  }
  serverOptionsByServer.set(mcpServer, options)
  return mcpServer
}

function subjectOf(ctx: McpRequestContext) {
  const subject = ctx.authInfo?.extra?.subject
  return typeof subject === 'string' ? subject : undefined
}

async function closeIdleSessions(sessions: LegacySessions) {
  const cutoff = Date.now() - sessionIdleMs
  for (const [id, session] of sessions) {
    if (session.lastUsed > cutoff) continue
    sessions.delete(id)
    await session.transport.close().catch(() => undefined)
    await session.server.close().catch(() => undefined)
  }
}

function isProtectedResourcePath(request: Request) {
  const path = new URL(request.url).pathname
  const isExact = path === protectedResourcePath
  const isChild = path.startsWith(`${protectedResourcePath}/`)
  return isExact || isChild
}

function buildMcpServer(input: {
  options: MCPServerOptions
  tools: ReadonlyArray<AnyServerTool>
  resources: ReadonlyArray<McpResource>
  prompts: ReadonlyArray<McpPrompt>
  taskStore: TaskStore
  era: ProtocolYear
  hasTaskTool: boolean
  owner: string | undefined
}) {
  const server = new McpServer(
    { name: input.options.name, version: input.options.version },
    serverOptions(input.era, input.hasTaskTool),
  )
  const toolList = input.tools
  for (const tool of toolList) {
    registerServerTool(server, tool, input)
  }
  const resourceList = input.resources
  for (const resource of resourceList) {
    registerServerResource(server, resource)
  }
  const promptList = input.prompts
  for (const prompt of promptList) {
    registerServerPrompt(server, prompt)
  }
  if (input.era === '2025') {
    registerLegacyTaskMethods(server, input.taskStore, input.owner)
  }
  return server
}

function serverOptions(era: ProtocolYear, hasTaskTool: boolean) {
  if (!hasTaskTool) return undefined
  if (era === '2025') {
    return {
      capabilities: {
        tasks: { requests: { tools: { call: {} } } },
      },
    }
  }
  return {
    capabilities: {
      extensions: {
        'io.modelcontextprotocol/tasks': {},
      },
    },
  }
}

function registerServerTool(
  server: McpServer,
  tool: AnyServerTool,
  input: {
    options: MCPServerOptions
    taskStore: TaskStore
    era: ProtocolYear
    owner: string | undefined
  },
) {
  const inputSchema = standardSchema(tool.inputSchema) ?? emptyObjectSchema
  // An output schema can have any root, like z.string(). The SDK wraps it
  // in `{ result }` for a spec 2025 client.
  const outputSchema =
    tool.execution === 'task'
      ? undefined
      : standardSchema(tool.outputSchema, true)
  const registered = server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema,
      outputSchema,
    },
    async (args, sdkCtx) => {
      if (tool.execution === 'task') {
        return runTaskTool(tool, args, input)
      }
      const ctx = toolCallContext(input.era, sdkCtx, input.options.sample)
      try {
        const output = await runTool(tool, args, ctx)
        return toCallToolResult(output, outputSchema !== undefined)
      } catch (error) {
        if (error instanceof ToolInputRequiredError) {
          return inputRequired({
            inputRequests: {
              [inputKey]: inputRequired.elicit({
                message: error.request.message,
                mode: 'form',
                requestedSchema: inputFormSchema,
              }),
            },
          })
        }
        throw error
      }
    },
  )
  if (input.era === '2025' && tool.execution === 'task') {
    registered.execution = { taskSupport: 'required' }
  }
}

async function runTaskTool(
  tool: AnyServerTool,
  args: unknown,
  input: {
    options: MCPServerOptions
    taskStore: TaskStore
    era: ProtocolYear
    owner: string | undefined
  },
) {
  const ctx = taskContext(input.options.sample)
  const handle = await startTask(
    () => Promise.resolve(runTool(tool, args, ctx)),
    {
      store: input.taskStore,
      waitUntil: input.options.waitUntil,
      owner: input.owner,
    },
  )
  const polled = await getTask(handle.taskId, input.taskStore, input.owner)
  if (polled === null) {
    throw new Error(`Task ${handle.taskId} was not saved.`)
  }
  return taskCallResult(input.era, polled)
}

// A task keeps running after tools/call answers with the task handle.
// So it must not use that request: its signal, elicitation, or sampling.
function taskContext(sample: MCPServerOptions['sample']) {
  return {
    async requestInput(_request: ToolInputRequest): Promise<never> {
      throw new Error(
        'ctx.requestInput is not supported in an execution: "task" tool.',
      )
    },
    async sample(request: SampleRequest) {
      if (sample === undefined) {
        throw new Error(
          'ctx.sample in an execution: "task" tool needs the sample option of createMCPServer.',
        )
      }
      return sample(request)
    },
    // ponytail: nothing aborts this signal until tasks/cancel is implemented.
    abortSignal: new AbortController().signal,
    emitCustomEvent() {},
  }
}

function taskCallResult(
  era: ProtocolYear,
  polled: NonNullable<Awaited<ReturnType<typeof getTask>>>,
) {
  const taskId = polled.record.taskId
  const content = [{ type: 'text' as const, text: taskId }]
  if (era === '2026') {
    // tools/call still requires content. resultType "task" is the create handle.
    const handle = {
      resultType: 'task' as const,
      taskId: polled.spec2026.taskId,
      status: polled.spec2026.status,
      createdAt: polled.spec2026.createdAt,
      lastUpdatedAt: polled.spec2026.lastUpdatedAt,
      ttlMs: polled.spec2026.ttlMs,
      content,
    }
    return handle
  }
  // The 2025 tools/call schema keeps structuredContent.
  return {
    content,
    structuredContent: {
      taskId: polled.spec2025.taskId,
      status: polled.spec2025.status,
      ttl: polled.spec2025.ttl,
      createdAt: polled.spec2025.createdAt,
      lastUpdatedAt: polled.spec2025.lastUpdatedAt,
    },
  }
}

function runTool(
  tool: AnyServerTool,
  args: unknown,
  ctx: ReturnType<typeof toolCallContext> | ReturnType<typeof taskContext>,
) {
  const execute = tool.execute
  if (execute === undefined) {
    throw new Error(`Tool ${tool.name} has no execute function.`)
  }
  return execute(args ?? {}, ctx)
}

function toolCallContext(
  era: ProtocolYear,
  sdkCtx: ServerContext,
  sample: MCPServerOptions['sample'],
) {
  const hooks =
    era === '2025'
      ? createServerToolContext({
          era: '2025',
          waitForInput: (request) => waitForInput(sdkCtx, request),
          clientSample: (request) => askClientToSample(sdkCtx, request),
          sample,
        })
      : createServerToolContext({
          era: '2026',
          inputAnswer: inputAnswer(sdkCtx),
          sample,
        })
  return {
    ...hooks,
    abortSignal: sdkCtx.mcpReq.signal,
    emitCustomEvent() {},
  }
}

function inputAnswer(sdkCtx: ServerContext) {
  const content = acceptedContent(sdkCtx.mcpReq.inputResponses, inputKey)
  if (content === undefined) return undefined
  if (typeof content.value === 'string') return content.value
  return content
}

async function waitForInput(sdkCtx: ServerContext, request: ToolInputRequest) {
  const result = await sdkCtx.mcpReq.elicitInput({
    message: request.message,
    mode: 'form',
    requestedSchema: inputFormSchema,
  })
  const declined = result.action !== 'accept' || result.content === undefined
  if (declined) {
    throw new Error('The user did not accept the input request.')
  }
  const content = result.content
  if (content !== undefined && typeof content.value === 'string') {
    return content.value
  }
  return content
}

async function askClientToSample(
  sdkCtx: ServerContext,
  request: SampleRequest,
) {
  const messages = request.messages.map((message) => ({
    role:
      message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    content: { type: 'text' as const, text: message.content },
  }))
  const result = await sdkCtx.mcpReq.requestSampling({
    messages,
    maxTokens: sampleMaxTokens,
  })
  return textFromContent(result.content)
}

function textFromContent(content: unknown) {
  if (isTextBlock(content)) return content.text
  if (!Array.isArray(content)) {
    throw new Error('The client sample result has no text.')
  }
  const blocks = content
  for (const block of blocks) {
    if (isTextBlock(block)) return block.text
  }
  throw new Error('The client sample result has no text.')
}

function isTextBlock(value: unknown): value is { type: 'text'; text: string } {
  return (
    isRecord(value) && value.type === 'text' && typeof value.text === 'string'
  )
}

function registerServerResource(server: McpServer, resource: McpResource) {
  const metadata = { mimeType: resource.mimeType }
  const read = async (uri: URL) =>
    resourceContents(uri.href, resource.mimeType, await resource.read())
  if (resource.uri !== undefined) {
    server.registerResource(resource.name, resource.uri, metadata, read)
    return
  }
  if (resource.uriTemplate === undefined) return
  const template = new ResourceTemplate(resource.uriTemplate, {
    list: undefined,
  })
  server.registerResource(resource.name, template, metadata, read)
}

function resourceContents(uri: string, mimeType: string, body: unknown) {
  if (isRecord(body) && typeof body.text === 'string') {
    return { contents: [{ uri, mimeType, text: body.text }] }
  }
  if (isRecord(body) && typeof body.blob === 'string') {
    return { contents: [{ uri, mimeType, blob: body.blob }] }
  }
  if (typeof body === 'string') {
    return { contents: [{ uri, mimeType, text: body }] }
  }
  // JSON.stringify(undefined) is undefined. A text block needs a string.
  return { contents: [{ uri, mimeType, text: JSON.stringify(body) ?? '' }] }
}

function registerServerPrompt(server: McpServer, prompt: McpPrompt) {
  const argsSchema = standardSchema(prompt.argsSchema) ?? emptyObjectSchema
  server.registerPrompt(
    prompt.name,
    { description: prompt.description, argsSchema },
    async (args) => {
      const rendered = await prompt.render(args ?? {})
      return { messages: promptMessages(rendered) }
    },
  )
}

function promptMessages(rendered: unknown) {
  const items = Array.isArray(rendered) ? rendered.filter(isPromptMessage) : []
  return items.map((item) => {
    const content = { type: 'text' as const, text: item.content }
    if (item.role === 'assistant') {
      return { role: 'assistant' as const, content }
    }
    return { role: 'user' as const, content }
  })
}

function isPromptMessage(
  value: unknown,
): value is { role: string; content: string } {
  return (
    isRecord(value) &&
    typeof value.role === 'string' &&
    typeof value.content === 'string'
  )
}

const taskIdParams = {
  '~standard': {
    version: 1 as const,
    vendor: 'tanstack-ai-mcp',
    validate(value: unknown) {
      const taskId = isRecord(value) ? value.taskId : undefined
      if (typeof taskId !== 'string' || taskId.length === 0) {
        return { issues: [{ message: 'taskId is required' }] }
      }
      return { value: { taskId } }
    },
  },
}

function registerLegacyTaskMethods(
  server: McpServer,
  store: TaskStore,
  owner: string | undefined,
) {
  server.server.setRequestHandler(
    'tasks/get',
    { params: taskIdParams },
    async (params) => {
      const polled = await getTask(taskIdFrom(params), store, owner)
      if (polled === null) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Task not found',
        )
      }
      return polled.spec2025
    },
  )
  server.server.setRequestHandler(
    'tasks/result',
    { params: taskIdParams },
    async (params) => {
      const polled = await getTask(taskIdFrom(params), store, owner)
      if (polled === null || polled.record.status !== 'completed') {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Task result is not ready',
        )
      }
      return toCallToolResult(polled.record.result)
    },
  )
}

function taskIdFrom(params: unknown) {
  if (!isRecord(params) || typeof params.taskId !== 'string') {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidParams,
      'taskId is required',
    )
  }
  return params.taskId
}

// Input schemas and prompt arguments must have an object root.
function standardSchema(schema: unknown, anyRoot = false) {
  if (!isSchemaInput(schema)) return undefined
  const jsonSchema = convertSchemaToJsonSchema(schema)
  if (!anyRoot) {
    return isJsonObjectSchema(jsonSchema)
      ? fromJsonSchema(jsonSchema)
      : undefined
  }
  return isJsonSchemaRoot(jsonSchema) ? fromJsonSchema(jsonSchema) : undefined
}

// The converter returns one JSON Schema object for a Standard Schema.
function isJsonSchemaRoot(value: unknown): value is JsonSchemaType {
  return isRecord(value)
}

function isSchemaInput(schema: unknown): schema is SchemaInput {
  if (!isRecord(schema)) return false
  if ('~standard' in schema) return true
  return schema.type !== undefined
}

function isJsonObjectSchema(value: unknown): value is { type: 'object' } {
  return isRecord(value) && value.type === 'object'
}

async function legacyFetch(
  request: Request,
  routes: {
    open: () => Promise<Response>
    resume: (sessionId: string) => Promise<Response>
  },
) {
  const sessionId = request.headers.get('mcp-session-id')
  if (sessionId !== null && sessionId.length > 0) {
    return routes.resume(sessionId)
  }
  return routes.open()
}

async function resumeLegacySession(
  request: Request,
  sessionId: string,
  sessions: LegacySessions,
  owner: string | undefined,
) {
  const session = sessions.get(sessionId)
  // Another subject gets the same answer as an unknown id.
  if (session === undefined || session.owner !== owner) {
    return sessionNotFound()
  }
  session.lastUsed = Date.now()
  return session.transport.handleRequest(request)
}

async function openLegacySession(
  request: Request,
  input: {
    sessions: LegacySessions
    owner: string | undefined
    build: () => McpServer
  },
) {
  const server = input.build()
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    enableJsonResponse: true,
    keepAliveMs: 0,
    onsessioninitialized: (id) => {
      input.sessions.set(id, {
        transport,
        server,
        owner: input.owner,
        lastUsed: Date.now(),
      })
    },
    onsessionclosed: (id) => {
      input.sessions.delete(id)
    },
  })
  try {
    await server.connect(transport)
    return await transport.handleRequest(request)
  } finally {
    // A request that never opens a session must not keep the server.
    if (transport.sessionId === undefined) await server.close()
  }
}

function sessionNotFound() {
  return Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: { code: -32001, message: 'Session not found' },
    },
    { status: 404 },
  )
}

async function modernTaskGet(
  request: Request,
  store: TaskStore,
  owner: string | undefined,
) {
  if (request.method !== 'POST') return undefined
  let body: unknown
  try {
    body = await request.clone().json()
  } catch {
    return undefined
  }
  if (!isRecord(body) || body.method !== 'tasks/get') return undefined
  if (!isModernEnvelope(body.params)) return undefined
  const taskId =
    isRecord(body.params) && typeof body.params.taskId === 'string'
      ? body.params.taskId
      : undefined
  const id = rpcId(body.id)
  if (taskId === undefined || taskId.length === 0) {
    return jsonRpcError(id, ProtocolErrorCode.InvalidParams, 'Invalid params')
  }
  const polled = await getTask(taskId, store, owner)
  if (polled === null) {
    return jsonRpcError(id, ProtocolErrorCode.InvalidParams, 'Task not found')
  }
  return jsonRpcResult(id, polled.spec2026)
}

function isModernEnvelope(params: unknown) {
  if (!isRecord(params) || !isRecord(params._meta)) return false
  const version = params._meta[PROTOCOL_VERSION_META_KEY]
  return typeof version === 'string' && version >= spec2026
}

function rpcId(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') return value
  return null
}

function jsonRpcResult(id: string | number | null, result: unknown) {
  return Response.json(
    { jsonrpc: '2.0', id, result },
    { status: 200, headers: { 'mcp-protocol-version': spec2026 } },
  )
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
) {
  return Response.json(
    { jsonrpc: '2.0', id, error: { code, message } },
    { status: 200, headers: { 'mcp-protocol-version': spec2026 } },
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
