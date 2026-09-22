import { describe, expect, it } from 'vitest'
import { chat } from '../src/activities/chat/index'
import { EventType } from '../src/types'
import { collectChunks, createMockAdapter, ev, serverTool } from './test-utils'
import type { StreamChunk } from '../src/types'

function inputRequiredThrow(kind: 'form' | 'sampling', request: unknown) {
  return {
    name: 'MCPInputRequiredError',
    kind,
    request,
  }
}

async function runInputRequiredChat(
  kind: 'form' | 'sampling',
  request: unknown,
) {
  const { adapter, calls } = createMockAdapter({
    iterations: [
      [
        ev.runStarted(),
        ev.toolStart('call_1', 'askInput'),
        ev.toolArgs('call_1', '{}'),
        ev.runFinished('tool_calls'),
      ],
      [
        ev.runStarted(),
        ev.textStart(),
        ev.textContent('continued'),
        ev.textEnd(),
        ev.runFinished('stop'),
      ],
    ],
  })

  const chunks = await collectChunks(
    chat({
      adapter,
      messages: [{ role: 'user', content: 'Ask' }],
      tools: [
        serverTool('askInput', () => {
          throw inputRequiredThrow(kind, request)
        }),
      ],
    }) as AsyncIterable<StreamChunk>,
  )

  const finished = chunks.filter(
    (chunk): chunk is Extract<StreamChunk, { type: 'RUN_FINISHED' }> =>
      chunk.type === EventType.RUN_FINISHED,
  )
  expect(finished).toHaveLength(1)
  expect(
    chunks.some((chunk) => chunk.type === EventType.TOOL_CALL_RESULT),
  ).toBe(false)
  expect(chunks.some((chunk) => chunk.type === EventType.RUN_ERROR)).toBe(false)
  expect(calls).toHaveLength(1)

  return finished[0]
}

describe('MCP input interrupt', () => {
  it('pauses a form request as an interrupt, not a tool error', async () => {
    const request = { elicitationId: 'elicit-1', message: 'Which city?' }
    const finished = await runInputRequiredChat('form', request)

    expect(finished?.outcome).toMatchObject({
      type: 'interrupt',
      interrupts: [
        {
          id: 'mcp_input_call_1',
          reason: 'mcp_input',
          toolCallId: 'call_1',
          metadata: {
            'tanstack:interruptPayload': {
              kind: 'form',
              request,
            },
          },
        },
      ],
    })
  })

  it('pauses a sampling request as a different interrupt', async () => {
    const request = { messages: [{ role: 'user', content: 'Hi' }] }
    const finished = await runInputRequiredChat('sampling', request)

    expect(finished?.outcome).toMatchObject({
      type: 'interrupt',
      interrupts: [
        {
          id: 'mcp_input_call_1',
          reason: 'mcp_input',
          toolCallId: 'call_1',
          metadata: {
            'tanstack:interruptPayload': {
              kind: 'sampling',
              request,
            },
          },
        },
      ],
    })
  })
})
