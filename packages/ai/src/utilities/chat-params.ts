import { validateAGUIInput } from './ag-ui-validation'
import { AGUIError } from '@ag-ui/core'
import type {
  Context as AGUIContext,
  RunAgentInput as AGUIRunAgentInput,
} from '@ag-ui/core'
import type {
  AnyTool,
  JSONSchema,
  ModelMessage,
  RunAgentResumeItem,
  UIMessage,
} from '../types'

/** Give request handlers a stable error with migration guidance. */
function invalidBody(reason: string): never {
  throw new AGUIError(
    `Request body is not a valid AG-UI RunAgentInput. See docs/migration/ag-ui-compliance.md. Validation errors: ${reason}`,
  )
}

/**
 * Parse and validate an HTTP request body as an AG-UI `RunAgentInput`.
 *
 * Returns a spread-friendly object whose `messages` field is suitable for
 * passing directly to `chat({ messages })`. The existing
 * `convertMessagesToModelMessages` handles AG-UI fan-out dedup and
 * reasoning/activity/developer-role normalization internally.
 *
 * Validated structurally against the AG-UI `RunAgentInput` contract without a
 * schema library, so this package pulls in no validation runtime of its own.
 *
 * @throws An error with a migration-pointing message when the body does
 *   not conform to AG-UI `RunAgentInput`. Surface this as a
 *   400 Bad Request to the client.
 */
export async function chatParamsFromRequestBody(body: unknown): Promise<{
  messages: Array<UIMessage | ModelMessage>
  threadId: string
  runId: string
  parentRunId?: string
  protocolVersion?: string
  tools: Array<{ name: string; description: string; parameters: JSONSchema }>
  forwardedProps: AGUIRunAgentInput['forwardedProps']
  state: unknown
  resume?: Array<RunAgentResumeItem>
  /**
   * @deprecated Use `aguiContext` instead. This alias will be removed in a
   * future release.
   */
  context: Array<AGUIContext>
  aguiContext: Array<AGUIContext>
}> {
  let input: AGUIRunAgentInput
  try {
    input = validateAGUIInput(body)
  } catch (error) {
    invalidBody(error instanceof Error ? error.message : String(error))
  }
  const aguiContext = input.context ?? []
  return {
    messages: input.messages as Array<UIMessage | ModelMessage>,
    threadId: input.threadId,
    runId: input.runId,
    ...(input.parentRunId !== undefined
      ? { parentRunId: input.parentRunId }
      : {}),
    ...(input.protocolVersion !== undefined
      ? { protocolVersion: input.protocolVersion }
      : {}),
    tools: (input.tools ?? []).map((tool) => ({
      ...tool,
      description: tool.description ?? '',
      parameters: tool.parameters as JSONSchema,
    })),
    forwardedProps: input.forwardedProps ?? {},
    state: input.state,
    ...(input.resume !== undefined ? { resume: input.resume } : {}),
    context: aguiContext,
    aguiContext,
  }
}

/**
 * Read an HTTP `Request`, parse its JSON body, and validate it as an
 * AG-UI `RunAgentInput` — collapsing the standard `req.json()` +
 * `chatParamsFromRequestBody(...)` pair into a single call.
 *
 * On a malformed body or invalid AG-UI shape, this **throws a
 * `Response`** with status 400 and a migration-pointing message in the
 * body. Frameworks that natively handle thrown `Response` objects
 * (TanStack Start, SolidStart, Remix, React Router 7) will return the
 * 400 to the client automatically, so the handler reduces to:
 *
 * ```ts
 * export async function POST(req: Request) {
 *   const params = await chatParamsFromRequest(req)
 *   // ...use params
 * }
 * ```
 *
 * In frameworks that do not auto-handle thrown `Response` objects
 * (Next.js Route Handlers, SvelteKit, Hono, raw Node), wrap the call
 * with try/catch and return the caught Response yourself, or use
 * `chatParamsFromRequestBody` directly with your own JSON-parsing.
 *
 * @throws {Response} 400 on malformed JSON or invalid AG-UI shape.
 */
export async function chatParamsFromRequest(
  req: Request,
): Promise<Awaited<ReturnType<typeof chatParamsFromRequestBody>>> {
  let body: unknown
  try {
    body = await req.json()
  } catch (cause) {
    // Preserve the underlying error on the thrown Response for
    // server-side observability without leaking it to the client.
    const res = new Response(
      'Invalid AG-UI request body. See docs/migration/ag-ui-compliance.md.',
      { status: 400 },
    )
    ;(res as { cause?: unknown }).cause = cause
    throw res
  }
  try {
    return await chatParamsFromRequestBody(body)
  } catch (cause) {
    // Generic public message — avoid echoing Zod paths (which can contain
    // user payload fragments) or internal validator strings to the client.
    // The original AGUIError is attached as `cause` so server logs can
    // surface it without exposing it to remote callers.
    const res = new Response(
      'Invalid AG-UI request body. See docs/migration/ag-ui-compliance.md.',
      { status: 400 },
    )
    ;(res as { cause?: unknown }).cause = cause
    throw res
  }
}

/**
 * Client-declared tool stub (no execute). `name` is `string`, so arrays that
 * include these stubs intentionally widen tool-name discrimination —
 * pass server tools alone when you need a closed name union.
 */
export type ClientToolDeclaration = {
  name: string
  description: string
  inputSchema: JSONSchema
}

export type MergedAgentTools<TServerTools extends ReadonlyArray<AnyTool>> =
  ReadonlyArray<TServerTools[number] | ClientToolDeclaration>

/**
 * Merge a server-side tool array with the AG-UI client-declared tools
 * received in the request body.
 *
 * Rules:
 * - Server tools win on name collision. The client's declaration is
 *   ignored if the server already has a tool with that name. The client's
 *   UI-side handler still fires when the streamed tool-result event comes
 *   through (see `chat-client.ts` `onToolCall`), giving the
 *   "after server execution the client also handles" semantic for free.
 * - Client-only tools (name not in `serverTools`) become no-execute
 *   entries: the runtime's existing `ClientToolRequest` path handles
 *   them — server emits a tool-call request, client executes via its
 *   registered handler, client posts back the result.
 *
 * Typing:
 * - Empty `clientTools` preserves the server tuple (closed name union).
 * - Non-empty `clientTools` returns a widened array that honestly includes
 *   client stubs, so the merged array does not claim a closed server-only
 *   name union.
 *
 * @param serverTools - The server's tool array (e.g. from
 *   `[myToolDef.server(...)]`). Pass directly to `chat({ tools })`.
 * @param clientTools - The `tools` array received from
 *   `chatParamsFromRequest(...)` / `chatParamsFromRequestBody(...)`.
 * @returns A merged array suitable for `chat({ tools })`.
 */
export function mergeAgentTools<
  const TServerTools extends ReadonlyArray<AnyTool>,
>(serverTools: TServerTools, clientTools: readonly []): TServerTools
export function mergeAgentTools<
  const TServerTools extends ReadonlyArray<AnyTool>,
>(
  serverTools: TServerTools,
  clientTools: ReadonlyArray<{
    name: string
    description: string
    parameters: JSONSchema
  }>,
): MergedAgentTools<TServerTools>
export function mergeAgentTools<
  const TServerTools extends ReadonlyArray<AnyTool>,
>(
  serverTools: TServerTools,
  clientTools: ReadonlyArray<{
    name: string
    description: string
    parameters: JSONSchema
  }>,
): TServerTools | MergedAgentTools<TServerTools> {
  if (clientTools.length === 0) {
    return serverTools
  }
  const seen = new Set(serverTools.map((t) => t.name))
  const merged: Array<TServerTools[number] | ClientToolDeclaration> = [
    ...serverTools,
  ]
  for (const ct of clientTools) {
    if (seen.has(ct.name)) {
      // Server wins on name collision.
      continue
    }
    seen.add(ct.name)
    merged.push({
      name: ct.name,
      description: ct.description,
      inputSchema: ct.parameters,
      // No `execute` — runtime treats this as a client-side tool and
      // emits ClientToolRequest events.
    })
  }
  return merged
}
