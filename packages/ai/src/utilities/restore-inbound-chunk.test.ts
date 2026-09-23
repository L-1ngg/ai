import { describe, expect, it } from 'vitest'
import { EventType } from '../types'
import type { RunFinishedEvent, StreamChunk } from '../types'
import {
  restoreInboundChunk,
  restorePublicAliases,
} from './restore-inbound-chunk'

function runFinished(
  overrides?: Omit<Partial<RunFinishedEvent>, 'type'>,
): RunFinishedEvent {
  return {
    type: EventType.RUN_FINISHED,
    threadId: 't1',
    runId: 'r1',
    ...overrides,
  }
}

describe('restorePublicAliases', () => {
  it('preserves every spec usage entry and leaves cost in metadata', () => {
    const chunk = runFinished({
      usage: [
        {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 3,
        },
        { provider: 'other', model: 'other-model', inputTokens: 2, outputTokens: 1, totalTokens: 3 },
      ],
      metadata: {
        tanstack: {
          model: 'gpt-5.5',
          usage: {
            cost: 0.02,
            promptTokensDetails: { audioTokens: 1 },
          },
        },
      },
    })

    restorePublicAliases(chunk)

    expect(chunk.usage).toEqual([
      { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 3 },
      { provider: 'other', model: 'other-model', inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    ])
    expect(chunk.metadata?.tanstack?.usage?.cost).toBe(0.02)
    expect(chunk).not.toHaveProperty('model')
  })

  it('restores TOOL_CALL_START toolName from toolCallName', () => {
    const chunk: StreamChunk = {
      type: EventType.TOOL_CALL_START,
      toolCallId: 'tc1',
      toolCallName: 'get_weather',
    }

    restorePublicAliases(chunk)

    if (chunk.type !== EventType.TOOL_CALL_START) {
      throw new Error('expected TOOL_CALL_START')
    }
    expect(chunk.toolName).toBe('get_weather')
  })

  it('restores TOOL_CALL_END input from metadata.tanstack.input', () => {
    const chunk: StreamChunk = {
      type: EventType.TOOL_CALL_END,
      toolCallId: 'tc1',
      metadata: { tanstack: { input: { q: 'sf' } } },
    }

    restorePublicAliases(chunk)

    if (chunk.type !== EventType.TOOL_CALL_END) {
      throw new Error('expected TOOL_CALL_END')
    }
    expect(chunk.input).toEqual({ q: 'sf' })
  })
})

describe('restoreInboundChunk', () => {
  it('copies metadata.tanstack extras back to top-level fields', () => {
    const restored = restoreInboundChunk(
      runFinished({
        usage: [{ inputTokens: 10, outputTokens: 5, totalTokens: 15 }],
        metadata: {
          tanstack: {
            model: 'gpt-5.5',
            finishReason: 'stop',
            usage: { cost: 0.02 },
          },
        },
      }),
    )

    expect(restored.finishReason).toBe('stop')
    expect(restored.model).toBe('gpt-5.5')
    if (restored.type !== EventType.RUN_FINISHED) throw new Error('expected RUN_FINISHED')
    expect(restored.usage).toEqual([
      { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    ])
  })

  it('does not overwrite extras already on the chunk', () => {
    const restored = restoreInboundChunk(
      runFinished({
        finishReason: 'length',
        model: 'kept',
        metadata: {
          tanstack: { finishReason: 'stop', model: 'other' },
        },
      }),
    )

    expect(restored.finishReason).toBe('length')
    expect(restored.model).toBe('kept')
  })

  it('leaves spec-only chunks unchanged when there is no tanstack bag', () => {
    const chunk = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: 'm1',
      delta: 'Hi',
    } as const satisfies StreamChunk
    expect(restoreInboundChunk(chunk)).toBe(chunk)
  })
})
