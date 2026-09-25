import { createFileRoute } from '@tanstack/react-router'
import { chat } from '@tanstack/ai'
import { createOpenaiChat } from '@tanstack/ai-openai'

const DUMMY_KEY = 'sk-e2e-test-dummy-key'
const FINAL_TEXT = 'Recovered from response.completed'

function makeCompletionOnlyResponsesStream(
  missingTerminal = false,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const responseId = 'resp_completion_only'
  const events: Array<Record<string, unknown>> = [
    {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        status: 'in_progress',
        model: 'gpt-5.2',
        output: [],
      },
    },
    {
      type: 'response.content_part.added',
      response_id: responseId,
      item_id: 'msg_completion_only',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        status: 'completed',
        model: 'gpt-5.2',
        output: [
          {
            id: 'msg_completion_only',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: FINAL_TEXT, annotations: [] },
            ],
          },
        ],
        usage: {
          input_tokens: 5,
          output_tokens: 4,
          total_tokens: 9,
        },
      },
    },
  ]
  if (missingTerminal) {
    events.splice(1, 2, {
      type: 'response.output_text.delta',
      delta: 'Partial answer',
    })
  }

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'))
      controller.close()
    },
  })
}

export const Route = createFileRoute('/api/openai-completed-response-text')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const missingTerminal =
          new URL(request.url).searchParams.get('scenario') ===
          'missing-terminal'
        const adapter = createOpenaiChat('gpt-5.2', DUMMY_KEY, {
          fetch: async () =>
            new Response(makeCompletionOnlyResponsesStream(missingTerminal), {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            }),
        })

        if (missingTerminal) {
          let onError = false
          let onFinish = false
          let text = ''
          let errorCode: string | undefined
          const events: Array<string> = []
          for await (const chunk of chat({
            adapter,
            messages: [{ role: 'user', content: 'Complete the answer' }],
            middleware: [
              {
                name: 'observe',
                onError: () => {
                  onError = true
                },
                onFinish: () => {
                  onFinish = true
                },
              },
            ],
          })) {
            events.push(chunk.type)
            if (chunk.type === 'TEXT_MESSAGE_CONTENT') text += chunk.delta
            if (chunk.type === 'RUN_ERROR') errorCode = chunk.code
          }
          return Response.json({ events, text, errorCode, onError, onFinish })
        }

        const text = await chat({
          adapter,
          messages: [
            {
              role: 'user',
              content: '[completed-response-text] answer carefully',
            },
          ],
          stream: false,
        })

        return Response.json({ text })
      },
    },
  },
})
