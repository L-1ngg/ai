import { Client } from '@modelcontextprotocol/client'
import {
  DuplicateToolNameError,
  MCPConnectionError,
  MCPTaskRequiredToolError,
  MCPToolNotFoundError,
} from './errors'
import { listPages } from './list-pages'
import {
  callMcpTool,
  makeMcpExecute,
  requiresTaskExecution,
  serverSupportsTaskCalls,
  toolMcpMetadata,
  toServerTools,
} from './tools'
import { directMCPClient } from './direct-client'
import { isTransportInstance, resolveTransport } from './transport'
import type { DirectClientOptions, DirectMCPClient } from './direct-client'
import type { MCPServer } from './server/create-server'
import type { TransportConfig } from './transport'
import type {
  AnyToolDefinition,
  AutomaticDescriptor,
  DescriptorTools,
  MCPClientOptions,
  MappedServerTools,
  McpServerTool,
  ServerDescriptor,
  ToolsOptions,
} from './types'
import type {
  ClientOptions,
  GetPromptResult,
  McpSubscription,
  Prompt,
  ReadResourceResult,
  Resource,
  ResourceTemplateType,
  Tool as McpToolDef,
  Transport,
} from '@modelcontextprotocol/client'
import type { ServerTool } from '@tanstack/ai'

export interface MCPClient<
  TServer extends ServerDescriptor = AutomaticDescriptor,
> {
  readonly capabilities: TServer['capabilities']
  /**
   * Auto-discovery: every server tool as a ServerTool. With a generated
   * descriptor, tool names are typed as the descriptor's name literals;
   * args/results stay untyped — use the `tools(defs)` overload for typed args.
   *
   * Both overloads yield {@link McpServerTool}s, so `tool.metadata.mcp` (the
   * server's title / annotations) is typed without an annotation or a cast.
   */
  tools: {
    (options?: ToolsOptions): Promise<DescriptorTools<TServer>>
    /**
     * Explicit: bind these TanStack toolDefinitions to the server (typed +
     * validated, allowlist). Note: when the client has a `prefix`, the
     * runtime tool name is `${prefix}_${def.name}` while the static `TName`
     * stays the unprefixed definition name.
     */
    <const TDefs extends ReadonlyArray<AnyToolDefinition>>(
      defs: TDefs,
      options?: ToolsOptions,
    ): Promise<MappedServerTools<TDefs>>
  }
  resources: () => Promise<Array<Resource>>
  readResource: (uri: string) => Promise<ReadResourceResult>
  resourceTemplates: () => Promise<Array<ResourceTemplateType>>
  prompts: () => Promise<Array<Prompt>>
  getPrompt: (
    name: string,
    args?: Record<string, string>,
  ) => Promise<GetPromptResult>
  /**
   * Call a tool directly and return its raw MCP result. Tools declaring
   * `execution.taskSupport: 'required'` automatically use task execution when
   * the server declares the tasks capability for tools/call. Pass
   * `options.signal` to abort — an in-flight task is best-effort cancelled on
   * the server.
   */
  callTool: (
    name: string,
    args?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<Awaited<ReturnType<Client['callTool']>>>
  /**
   * The ORIGINAL connection descriptor this client was created from — the
   * `transport` input and `prefix` passed to `createMCPClient`. Used by
   * `createMcpAppCallHandler` to reconnect per-call (serverless-safe) without
   * a separate transport-config map.
   *
   * `transport` is `undefined` when the client was built from a ready-made
   * `Transport` instance rather than a serializable config — either via
   * `createMCPClientFromTransport` (test-only) or `createMCPClient({ transport:
   * <instance> })`. A live `Transport` instance is single-use and cannot be
   * reconnected, so only serializable `TransportConfig`s are retained here.
   */
  getInfo: () => {
    transport: TransportConfig | undefined
    prefix: string | undefined
    /**
     * The options this client was built with, so a caller that reconstructs it
     * from this descriptor keeps them. Without it a rebuilt client silently
     * reverts to the SDK defaults — including the AJV validator that edge
     * runtimes cannot compile.
     *
     * Optional so an existing hand-rolled `MCPClient` keeps compiling.
     */
    clientOptions?: ClientOptions
  }
  close: () => Promise<void>
  [Symbol.asyncDispose]: () => Promise<void>
}

class MCPClientImpl<
  TServer extends ServerDescriptor,
> implements MCPClient<TServer> {
  capabilities: TServer['capabilities'] = {}
  readonly #client: Client
  #closed = false
  #toolDefinitions?: Map<string, McpToolDef>
  // Open only after a spec 2026 connect when the server can report tool changes.
  #toolListSubscription?: McpSubscription
  private readonly prefix?: string
  // The ORIGINAL serializable transport config (undefined for clients built
  // from a ready-made Transport instance, which is single-use / not reconnectable).
  readonly #transport: TransportConfig | undefined
  // Retained for the same reason as #transport: the MCP Apps call handler
  // rebuilds a client per call from getInfo(), and a rebuilt client that lost
  // `jsonSchemaValidator` falls straight back to AJV.
  readonly #clientOptions: ClientOptions | undefined

  constructor(
    prefix?: string,
    name = 'tanstack-ai-mcp',
    version = '0.0.1',
    transport?: TransportConfig,
    clientOptions?: ClientOptions,
  ) {
    this.prefix = prefix
    this.#transport = transport
    this.#clientOptions = clientOptions
    // Try spec 2026-07-28 first. If the server does not support it, the
    // client uses the 2025 initialize handshake. Caller options still apply.
    // `mode` stays `auto` even when `clientOptions` sets another mode.
    this.#client = new Client(
      { name, version },
      {
        ...clientOptions,
        versionNegotiation: {
          ...clientOptions?.versionNegotiation,
          mode: 'auto',
        },
      },
    )
  }

  getInfo(): {
    transport: TransportConfig | undefined
    prefix: string | undefined
    clientOptions?: ClientOptions
  } {
    return {
      transport: this.#transport,
      prefix: this.prefix,
      ...(this.#clientOptions ? { clientOptions: this.#clientOptions } : {}),
    }
  }

  async connect(transport: Transport): Promise<void> {
    try {
      // A tools/list_changed notice drops the cached definitions so the next
      // callTool reads each tool's execution mode again.
      this.#client.setNotificationHandler(
        'notifications/tools/list_changed',
        () => {
          this.#toolDefinitions = undefined
        },
      )
      await this.#client.connect(transport)
      this.capabilities = this.#client.getServerCapabilities() ?? {}
      await this.#listenForToolListChanges()
    } catch (err) {
      await this.#toolListSubscription?.close().catch(() => undefined)
      await this.#client.close().catch(() => undefined)
      throw new MCPConnectionError('Failed to connect to MCP server', err)
    }
  }

  // Spec 2026 does not push tool-list changes. Open subscriptions/listen when
  // the server says it can report them. The notice handler above drops the cache.
  async #listenForToolListChanges() {
    if (this.#client.getProtocolEra() !== 'modern') return
    const tools = this.#client.getServerCapabilities()?.tools
    if (tools?.listChanged !== true) return
    this.#toolListSubscription = await this.#client.listen({
      toolsListChanged: true,
    })
  }

  // Read every tools/list page into the definition cache.
  // listPages throws when a cursor repeats or the page cap is passed.
  // A raw list does not compile `jsonSchemaValidator`. `callTool` then
  // skips output checks. `tools()` follows the raw walk with `listTools()`
  // so the SDK cache is filled and the validator runs.
  // `raw: true` is the lazy `callTool` path. It must stay free of that cache.
  async #listTools(options?: { raw?: boolean }) {
    const client = this.#client
    const defs = await listPages(async (cursor) => {
      const page =
        cursor === undefined
          ? await client.request({ method: 'tools/list' })
          : await client.request({
              method: 'tools/list',
              params: { cursor },
            })
      return { items: page.tools, nextCursor: page.nextCursor }
    })
    this.#toolDefinitions = new Map(defs.map((def) => [def.name, def]))
    if (options?.raw !== true) {
      await client.listTools()
    }
    return defs
  }

  async tools(
    defsOrOptions?: ReadonlyArray<AnyToolDefinition> | ToolsOptions,
    maybeOptions: ToolsOptions = {},
  ): Promise<Array<McpServerTool>> {
    if (this.#closed) throw new MCPConnectionError('MCP client is closed')

    const isDefs = Array.isArray(defsOrOptions)
    const options: ToolsOptions = isDefs
      ? maybeOptions
      : // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        ((defsOrOptions as ToolsOptions) ?? {}) // SDK interop: defsOrOptions may be undefined at runtime even though TS types it as ToolsOptions here

    let tools: Array<McpServerTool>
    if (isDefs) {
      // Explicit path: bind each TanStack toolDefinition to the server by name.
      const available = new Map(
        (await this.#listTools()).map((tool) => [tool.name, tool]),
      )
      tools = (defsOrOptions as ReadonlyArray<AnyToolDefinition>).map((def) => {
        const serverTool = available.get(def.name)
        if (!serverTool) throw new MCPToolNotFoundError(def.name)
        // A task-required tool on a server without the tasks capability for
        // tools/call cannot be invoked (every call fails) — refuse the binding.
        if (
          requiresTaskExecution(serverTool) &&
          !serverSupportsTaskCalls(this.#client)
        ) {
          throw new MCPTaskRequiredToolError(def.name)
        }
        const bound = def.server(
          makeMcpExecute(
            this.#client,
            def.name,
            Boolean(def.outputSchema),
            requiresTaskExecution(serverTool),
          ),
        ) as ServerTool
        // A caller-supplied definition may already carry its own `mcp` block,
        // and `metadata.mcp` is untyped there — only spread it when it really
        // is a plain object.
        const existingMcp: unknown = bound.metadata?.mcp
        const mcpBase =
          existingMcp !== null && typeof existingMcp === 'object'
            ? existingMcp
            : {}
        // Rebuilt rather than mutated in place: assigning `metadata` on a
        // `ServerTool` can't narrow its declared `Record<string, any> |
        // undefined` type, so a fresh literal is what lets the return value be
        // an `McpServerTool` (typed `metadata.mcp`) without a cast.
        //
        // Stamping MCP metadata lets `serverToolNameOf` (and the call handler)
        // recover the UNPREFIXED native name + serverId, and carries the
        // server's display title / annotations to the host — mirrors
        // toServerTools.
        const tool: McpServerTool = {
          ...bound,
          ...(this.prefix ? { name: `${this.prefix}_${def.name}` } : {}),
          ...(options.lazy ? { lazy: true } : {}),
          metadata: {
            ...bound.metadata,
            mcp: { ...mcpBase, ...toolMcpMetadata(serverTool, this.prefix) },
          },
        }
        return tool
      })
    } else {
      // Auto-discovery path.
      const defs = await this.#listTools()
      tools = toServerTools(this.#client, defs, {
        prefix: this.prefix,
        lazy: options.lazy,
      })
    }

    // Local duplicate guard (within one client's own list — applies to both branches).
    const seen = new Set<string>()
    for (const t of tools) {
      if (seen.has(t.name)) throw new DuplicateToolNameError(t.name)
      seen.add(t.name)
    }
    return tools
  }

  async resources(): Promise<Array<Resource>> {
    if (this.#closed) throw new MCPConnectionError('MCP client is closed')
    return (await this.#client.listResources()).resources
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    if (this.#closed) throw new MCPConnectionError('MCP client is closed')
    return this.#client.readResource({ uri })
  }

  async resourceTemplates(): Promise<Array<ResourceTemplateType>> {
    if (this.#closed) throw new MCPConnectionError('MCP client is closed')
    return (await this.#client.listResourceTemplates()).resourceTemplates
  }

  async prompts(): Promise<Array<Prompt>> {
    if (this.#closed) throw new MCPConnectionError('MCP client is closed')
    return (await this.#client.listPrompts()).prompts
  }

  async getPrompt(
    name: string,
    args?: Record<string, string>,
  ): Promise<GetPromptResult> {
    if (this.#closed) throw new MCPConnectionError('MCP client is closed')
    return this.#client.getPrompt({ name, arguments: args })
  }

  async callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<Awaited<ReturnType<Client['callTool']>>> {
    if (this.#closed) throw new MCPConnectionError('MCP client is closed')
    if (!this.#toolDefinitions) {
      // Lazy discovery so task-required tools work without a prior tools()
      // call. Best-effort: a server whose tools/list fails (or omits the
      // tool) still gets the plain tools/call it would have received before
      // task support existed. See #listTools.
      try {
        await this.#listTools({ raw: true })
      } catch {
        // fall through to a plain tools/call
      }
    }
    const definition = this.#toolDefinitions?.get(name)
    const taskRequired =
      definition !== undefined && requiresTaskExecution(definition)
    // A known task-required tool on a server without the tasks capability can
    // never execute — fail with the clear local error rather than the server's
    // opaque -32600 (mirrors the tools([...defs]) binding guard).
    if (taskRequired && !serverSupportsTaskCalls(this.#client)) {
      throw new MCPTaskRequiredToolError(name)
    }
    return callMcpTool(
      this.#client,
      name,
      args ?? {},
      taskRequired,
      options?.signal,
    )
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    const subscription = this.#toolListSubscription
    this.#toolListSubscription = undefined
    try {
      await subscription?.close()
    } finally {
      await this.#client.close()
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close()
  }
}

/**
 * Connects to an MCP server.
 *
 * Pass `transport` for a server at a URL, on SSE, or on stdio.
 * Pass `server` for a TanStack `createMCPServer` result in this program.
 * `server` keeps the tool names, resource URIs, and prompt arguments.
 * Export that server from one package and import it in another.
 *
 * @param options - A transport, or a TanStack MCP server
 *
 * @example
 * ```ts
 * const remote = await createMCPClient({
 *   transport: { type: 'http', url: 'https://mcp.example.com/mcp' },
 * })
 *
 * const local = await createMCPClient({ server })
 * await local.callTool('get_weather', { city: 'Paris' })
 * ```
 */
export async function createMCPClient<
  TDescriptor extends ServerDescriptor = AutomaticDescriptor,
>(options: MCPClientOptions): Promise<MCPClient<TDescriptor>>
export async function createMCPClient<TServer extends MCPServer>(
  options: DirectClientOptions<TServer>,
): Promise<DirectMCPClient<TServer>>
export async function createMCPClient(
  options: MCPClientOptions | DirectClientOptions<MCPServer>,
): Promise<MCPClient | DirectMCPClient<MCPServer>> {
  if ('server' in options) {
    return directMCPClient(options.server)
  }
  return connectTransport(options)
}

async function connectTransport<
  TServer extends ServerDescriptor = AutomaticDescriptor,
>(options: MCPClientOptions) {
  const transport = await resolveTransport(options.transport)
  const impl = new MCPClientImpl<TServer>(
    options.prefix,
    options.name,
    options.version,
    // Only a serializable config is reconnectable; a ready-made Transport
    // instance is single-use, so it is not retained as a descriptor.
    isTransportInstance(options.transport) ? undefined : options.transport,
    options.clientOptions,
  )
  await impl.connect(transport)
  return impl
}

/** Test-only: connect directly from a transport instance (skips resolveTransport). */
export async function createMCPClientFromTransport<
  TServer extends ServerDescriptor = AutomaticDescriptor,
>(
  transport: Transport,
  prefix?: string,
  clientOptions?: ClientOptions,
): Promise<MCPClient<TServer>> {
  const impl = new MCPClientImpl<TServer>(
    prefix,
    undefined,
    undefined,
    undefined,
    clientOptions,
  )
  await impl.connect(transport)
  return impl
}
