import { expect, it, vi } from 'vitest'
import { chat } from '@tanstack/ai'
import { resolveDebugOption } from '@tanstack/ai/adapter-internals'
import { OpenAIBaseResponsesTextAdapter } from '../src/adapters/responses-text'
import type OpenAI from 'openai'
import type { AdapterYieldChunk, JSONSchema } from '@tanstack/ai'

const messages = [{ role: 'user' as const, content: 'Complete the answer' }]

function makeAdapter(events: Array<Record<string, unknown>>) {
  const client = {
    responses: {
      create: async () => ({
        async *[Symbol.asyncIterator]() {
          yield* events
        },
      }),
    },
  } as unknown as OpenAI
  return new (class extends OpenAIBaseResponsesTextAdapter<string> {
    constructor() {
      super('test-model', 'test-responses', client)
    }
  })()
}

async function collect(stream: AsyncIterable<AdapterYieldChunk>) {
  const chunks: Array<AdapterYieldChunk> = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

it('reports chat EOF without response.completed as an error', async () => {
  const onFinish = vi.fn()
  const onError = vi.fn()
  const chunks = await collect(
    chat({
      adapter: makeAdapter([
        { type: 'response.created', response: { model: 'test-model' } },
        { type: 'response.output_text.delta', delta: 'Partial answer' },
      ]),
      messages,
      middleware: [{ name: 'observe', onFinish, onError }],
    }),
  )

  expect(chunks.some((chunk) => chunk.type === 'TEXT_MESSAGE_CONTENT')).toBe(
    true,
  )
  expect(chunks.at(-1)).toMatchObject({
    type: 'RUN_ERROR',
    code: 'incomplete_stream',
  })
  expect(onFinish).not.toHaveBeenCalled()
  expect(onError).toHaveBeenCalledOnce()
})

it('does not parse structured JSON as complete after unconfirmed EOF', async () => {
  const schema: JSONSchema = {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
  }
  const chunks = await collect(
    makeAdapter([
      { type: 'response.output_text.delta', delta: '{"answer":"partial"}' },
    ]).structuredOutputStream!({
      chatOptions: {
        model: 'test-model',
        messages,
        logger: resolveDebugOption(false),
      },
      outputSchema: schema,
    }),
  )

  expect(chunks.at(-1)).toMatchObject({
    type: 'RUN_ERROR',
    code: 'incomplete_stream',
  })
  expect(
    chunks.some(
      (chunk) =>
        chunk.type === 'CUSTOM' && chunk.name === 'structured-output.complete',
    ),
  ).toBe(false)
})
