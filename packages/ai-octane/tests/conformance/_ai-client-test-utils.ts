import { EventType, withTanstackMetadata } from '@tanstack/ai/client'
function runFinishedChunk(options: {
  runId: string
  threadId: string
  finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls' | null
  model?: string
}): Extract<StreamChunk, { type: 'RUN_FINISHED' }> {
  return withTanstackMetadata(
    {
      type: EventType.RUN_FINISHED,
      runId: options.runId,
      threadId: options.threadId,
      timestamp: Date.now(),
    },
    {
      finishReason: options.finishReason,
      ...(options.model !== undefined ? { model: options.model } : {}),
    },
  ) as Extract<StreamChunk, { type: 'RUN_FINISHED' }>
}
// Vendored from `@tanstack/ai-client`'s `tests/test-utils.ts` — the shared
// conformance helpers the upstream `@tanstack/ai-react` tests import. That
// file is not part of the package's published surface, and reaching across
// into a sibling package's tests/ directory would couple this suite to another
// package's internals, so the helpers live here instead.
//
// Their relative source imports are retargeted to the package's PUBLIC entry
// points:
//   - `../src/connection-adapters` / `../src/types` → `@tanstack/ai-client`
//   - core message/stream types                     → `@tanstack/ai/client`
//
// Only the helpers this suite actually uses are kept; the unused ones were
// dropped rather than carried as dead code. Pull more across from upstream as
// further test cases are ported.
import type { ConnectConnectionAdapter, UIMessage } from '@tanstack/ai-client'
import type {
  ModelMessage,
  AdapterYieldChunk as StreamChunk,
} from '@tanstack/ai/client'

/**
 * Options for creating a mock connection adapter
 */
export interface MockConnectionAdapterOptions {
  /**
   * Chunks to yield from the stream
   */
  chunks?: Array<StreamChunk>

  /**
   * Delay between chunks (in ms)
   */
  chunkDelay?: number

  /**
   * Whether to throw an error
   */
  shouldError?: boolean

  /**
   * Error to throw
   */
  error?: Error

  /**
   * Callback when connect is called
   */
  onConnect?: (
    messages: Array<ModelMessage> | Array<UIMessage>,
    data?: Record<string, any>,
    abortSignal?: AbortSignal,
  ) => void

  /**
   * Callback to check abort signal during streaming
   */
  onAbort?: (abortSignal: AbortSignal) => void
}

/**
 * Create a mock connection adapter for testing
 *
 * @example
 * ```typescript
 * const adapter = createMockConnectionAdapter({
 *   chunks: [
 *     { type: "TEXT_MESSAGE_CONTENT", messageId: "1", model: "test", timestamp: Date.now(), delta: "Hello", content: "Hello" },
 *     { type: "RUN_FINISHED", runId: "run-1", model: "test", timestamp: Date.now(), finishReason: "stop" }
 *   ]
 * });
 * ```
 */
export function createMockConnectionAdapter(
  options: MockConnectionAdapterOptions = {},
): ConnectConnectionAdapter {
  const {
    chunks = [],
    chunkDelay = 0,
    shouldError = false,
    error = new Error('Mock adapter error'),
    onConnect,
    onAbort,
  } = options

  return {
    async *connect(messages, data, abortSignal) {
      if (onConnect) {
        // Type assertion: messages can be ModelMessage[] or UIMessage[]
        // Filter out system messages if present
        const filteredMessages = (messages as any[]).filter(
          (m: any) => !('role' in m) || m.role !== 'system',
        )
        onConnect(filteredMessages as any, data, abortSignal)
      }

      if (shouldError) {
        throw error
      }

      for (const chunk of chunks) {
        // Check abort signal before yielding
        if (abortSignal?.aborted) {
          if (onAbort) {
            onAbort(abortSignal)
          }
          return
        }

        if (chunkDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, chunkDelay))
        }

        // Check again after delay
        if (abortSignal?.aborted) {
          if (onAbort) {
            onAbort(abortSignal)
          }
          return
        }

        yield chunk
      }
    },
  }
}

/**
 * Helper to create simple text content chunks (AG-UI format)
 */
export function createTextChunks(
  text: string,
  messageId: string = 'msg-1',
  model: string = 'test',
): Array<StreamChunk> {
  const chunks: Array<StreamChunk> = []
  const runId = `run-${messageId}`
  const threadId = `thread-${messageId}`

  chunks.push(
    { type: EventType.RUN_STARTED, runId, threadId },
    { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
  )

  for (const delta of text) {
    chunks.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId,
      timestamp: Date.now(),
      delta,
    } as StreamChunk)
  }

  chunks.push(
    { type: EventType.TEXT_MESSAGE_END, messageId },
    runFinishedChunk({ runId, threadId, finishReason: 'stop', model }),
  )

  return chunks
}

/**
 * Helper to create tool call chunks (AG-UI format)
 * Optionally includes tool-input-available chunks to trigger onToolCall
 */
export function createToolCallChunks(
  toolCalls: Array<{ id: string; name: string; arguments: string }>,
  messageId: string = 'msg-1',
  model: string = 'test',
  includeToolInputAvailable: boolean = true,
): Array<StreamChunk> {
  const chunks: Array<StreamChunk> = []
  const runId = `run-${messageId}`
  chunks.push({
    type: EventType.RUN_STARTED,
    runId,
    threadId: `thread-${messageId}`,
  })

  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i]!

    chunks.push({
      type: EventType.TOOL_CALL_START,
      toolCallId: toolCall.id,
      toolCallName: toolCall.name,
      timestamp: Date.now(),
    } as StreamChunk)

    chunks.push({
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: toolCall.id,
      timestamp: Date.now(),
      delta: toolCall.arguments,
    } as StreamChunk)

    chunks.push({ type: EventType.TOOL_CALL_END, toolCallId: toolCall.id })
  }

  chunks.push({
    ...runFinishedChunk({
      runId,
      threadId: `thread-${messageId}`,
      finishReason: 'tool_calls',
      model,
    }),
    outcome: {
      type: 'success',
      pendingToolCallIds: includeToolInputAvailable
        ? toolCalls.map((call) => call.id)
        : [],
    },
  })

  return chunks
}
