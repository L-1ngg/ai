import { createFileRoute } from '@tanstack/react-router'
import {
  chat,
  chatParamsFromRequestBody,
  maxIterations,
  toServerSentEventsResponse,
} from '@tanstack/ai'
import { createMCPClient } from '@tanstack/ai-mcp'
import type { StreamChunk } from '@tanstack/ai'
import type { MCPClient } from '@tanstack/ai-mcp'
import { createTextAdapter } from '@/lib/providers'

function connect(request: Request, token: string) {
  const origin = new URL(request.url).origin
  return createMCPClient({
    transport: {
      type: 'http',
      url: `${origin}/api/mcp-typed-server`,
      headers: { Authorization: `Bearer ${token}` },
    },
  })
}

async function* closeMcpOnDrain(
  stream: AsyncIterable<StreamChunk>,
  mcp: MCPClient,
): AsyncGenerator<StreamChunk> {
  try {
    for await (const chunk of stream) {
      yield chunk
    }
  } finally {
    await mcp.close()
  }
}

/**
 * Uses the tools of `api.mcp-typed-server` with a bearer token.
 *
 * - GET returns the discovered tools, so a test can read `outputSchema`.
 * - POST runs chat() with those tools.
 */
export const Route = createFileRoute('/api/mcp-typed-test')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const mcp = await connect(request, 'alice')
        try {
          const tools = await mcp.tools()
          return Response.json(
            tools.map((tool) => ({
              name: tool.name,
              outputSchema: tool.outputSchema ?? null,
            })),
          )
        } finally {
          await mcp.close()
        }
      },
      POST: async ({ request }) => {
        const params = await chatParamsFromRequestBody(await request.json())
        const fp = params.forwardedProps
        const testId = typeof fp.testId === 'string' ? fp.testId : undefined
        const aimockPort =
          fp.aimockPort != null ? Number(fp.aimockPort) : undefined
        const token = typeof fp.token === 'string' ? fp.token : 'alice'

        let mcp: MCPClient | undefined
        try {
          mcp = await connect(request, token)
          const stream = chat({
            ...createTextAdapter('openai', undefined, aimockPort, testId),
            messages: params.messages,
            tools: await mcp.tools(),
            threadId: params.threadId,
            runId: params.runId,
            agentLoopStrategy: maxIterations(5),
          })
          return toServerSentEventsResponse(closeMcpOnDrain(stream, mcp))
        } catch (error) {
          if (mcp) await mcp.close().catch(() => undefined)
          const message =
            error instanceof Error ? error.message : 'An error occurred'
          return new Response(JSON.stringify({ error: message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          })
        }
      },
    },
  },
})
