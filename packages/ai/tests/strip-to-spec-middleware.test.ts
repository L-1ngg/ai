import { normalizeStreamChunk } from '../src/utilities/normalize-stream-chunk'
import { describe, expect, it } from 'vitest'
import { stripToSpec, toWireChunk } from '../src/strip-to-spec-middleware'
import { EventType } from '../src/types'
import type { StreamChunk } from '../src/types'
import type { AdapterYieldChunk } from '../src/utilities/adapter-yield-chunk'
import { isSpecTopLevelKey } from '../src/utilities/spec-event-keys'

describe('stripToSpec', () => {
  it('strips nested RUN_ERROR.error and top-level extras', () => {
    const result = stripToSpec({
      type: EventType.RUN_ERROR,
      timestamp: 1,
      message: 'Something went wrong',
      code: 'INTERNAL_ERROR',
      error: { message: 'Something went wrong' },
      model: 'gpt-5.5',
    })
    expect(result).not.toHaveProperty('error')
    expect(result).not.toHaveProperty('model')
    expect(result).toMatchObject({
      type: EventType.RUN_ERROR,
      message: 'Something went wrong',
      code: 'INTERNAL_ERROR',
    })
  })

  it('keeps metadata and spec fields on TOOL_CALL_START', () => {
    const result = stripToSpec({
      type: EventType.TOOL_CALL_START,
      toolCallId: 'tc-1',
      toolCallName: 'getTodos',
      toolName: 'getTodos',
      index: 0,
      metadata: { foo: 'bar' },
      model: 'gpt-5.5',
    })
    expect(result).toEqual({
      type: EventType.TOOL_CALL_START,
      toolCallId: 'tc-1',
      toolCallName: 'getTodos',
      metadata: { foo: 'bar' },
    })
    expect(result).not.toHaveProperty('toolName')
    expect(result).not.toHaveProperty('index')
    expect(result).not.toHaveProperty('model')
  })

  it('moves nothing and only keeps spec keys on RUN_FINISHED', () => {
    const result = stripToSpec({
      type: EventType.RUN_FINISHED,
      runId: 'run-1',
      threadId: 'thread-1',
      model: 'gpt-5.5',
      finishReason: 'stop',
      usage: [{ inputTokens: 100, outputTokens: 50, totalTokens: 150 }],
    } satisfies AdapterYieldChunk)
    expect(result).not.toHaveProperty('model')
    expect(result).not.toHaveProperty('finishReason')
    expect(result).toMatchObject({
      runId: 'run-1',
      threadId: 'thread-1',
      usage: [{ inputTokens: 100, outputTokens: 50, totalTokens: 150 }],
    })
    for (const key of Object.keys(result)) {
      expect(isSpecTopLevelKey(EventType.RUN_FINISHED, key)).toBe(true)
    }
  })

  it('converts TanStack TokenUsage to spec usage[] and leftover metadata', () => {
    const result = stripToSpec({
      type: EventType.RUN_FINISHED,
      runId: 'run-1',
      threadId: 'thread-1',
      usage: [
        {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
          cachedInputTokens: 3,
        },
      ],
      metadata: {
        tanstack: {
          usage: { cost: 0.02, promptTokensDetails: { audioTokens: 1 } },
        },
      },
    })
    if (result.type !== EventType.RUN_FINISHED) {
      throw new Error('expected RUN_FINISHED')
    }
    expect(result.usage).toEqual([
      {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cachedInputTokens: 3,
      },
    ])
    expect(result.metadata).toEqual({
      tanstack: {
        usage: {
          cost: 0.02,
          promptTokensDetails: { audioTokens: 1 },
        },
      },
    })
  })
})

describe('toWireChunk', () => {
  it('moves leftover RUN_FINISHED finishReason into metadata.tanstack', () => {
    const result = toWireChunk({
      type: EventType.RUN_FINISHED,
      runId: 'run-1',
      threadId: 'thread-1',
      finishReason: 'stop',
      model: 'gpt-5.5',
    } as AdapterYieldChunk)
    expect(result).not.toHaveProperty('finishReason')
    expect(result).not.toHaveProperty('model')
    if (result.type !== EventType.RUN_FINISHED) {
      throw new Error('expected RUN_FINISHED')
    }
    expect(result.metadata).toEqual({
      tanstack: {
        finishReason: 'stop',
        model: 'gpt-5.5',
      },
    })
  })
})

describe('AG-UI 1.0 wire events', () => {
  it.each([
    {
      type: EventType.SUBAGENT_STARTED,
      subagentRunId: 'child-1',
      name: 'research',
      description: 'Find sources',
      parentSubagentRunId: 'parent-1',
      parentToolCallId: 'tool-1',
      parentMessageId: 'message-1',
    },
    {
      type: EventType.SUBAGENT_FINISHED,
      subagentRunId: 'child-1',
      result: { found: 2 },
      outcome: { type: 'suspended', interruptIds: ['approval-1'] },
    },
    {
      type: EventType.SUBAGENT_ERROR,
      subagentRunId: 'child-1',
      message: 'Unavailable',
      code: 'TIMEOUT',
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      subagentRunId: 'child-1',
      messageId: 'message-1',
      delta: 'Found it',
    },
    {
      type: EventType.RUN_STARTED,
      threadId: 'thread-1',
      runId: 'run-1',
      protocolVersion: '1.0',
    },
    {
      type: EventType.RUN_FINISHED,
      threadId: 'thread-1',
      runId: 'run-1',
      outcome: { type: 'cancelled' },
    },
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: 'message-1',
      toolCallId: 'tool-1',
      content: [
        { type: 'text', text: 'Image' },
        {
          type: 'image',
          source: { type: 'file', value: 'file-1', provider: 'openai' },
        },
      ],
    },
  ] satisfies Array<StreamChunk>)(
    'keeps $type fields at the top level',
    (chunk) => {
      expect(toWireChunk(chunk)).toEqual(chunk)
    },
  )
})

it('preserves attribution on synthesized tool results and signatures', () => {
  const events = normalizeStreamChunk({
    type: EventType.TOOL_CALL_END,
    toolCallId: 'tool-1',
    subagentRunId: 'child-1',
    result: 'done',
    signature: 'opaque',
  })
  expect(events).toHaveLength(3)
  for (const event of events)
    expect(event).toHaveProperty('subagentRunId', 'child-1')
})
