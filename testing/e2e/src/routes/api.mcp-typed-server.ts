import { createFileRoute } from '@tanstack/react-router'
import { toolDefinition } from '@tanstack/ai'
import { createMCPServer } from '@tanstack/ai-mcp/server'
import { z } from 'zod'

/**
 * A `createMCPServer` server behind a bearer token.
 *
 * - The tokens `alice` and `bob` are valid. Each token is its own subject.
 * - `forecast` has a string output schema.
 * - `build_report` runs as a task. The client polls `tasks/get` for it.
 */
const forecast = toolDefinition({
  name: 'forecast',
  description: 'The forecast for a city',
  inputSchema: z.object({ city: z.string() }),
  outputSchema: z.string(),
}).server(async ({ city }) => `Sunny in ${city}`)

const buildReport = toolDefinition({
  name: 'build_report',
  description: 'Build a report in the background',
  inputSchema: z.object({}),
  execution: 'task',
}).server(async () => {
  await new Promise((resolve) => setTimeout(resolve, 50))
  return 'Report ready'
})

const server = createMCPServer({
  name: 'typed-weather',
  version: '1.0.0',
  tools: [forecast, buildReport],
  auth: {
    verifyToken: async (token) =>
      token === 'alice' || token === 'bob' ? { subject: token } : false,
  },
})

export const Route = createFileRoute('/api/mcp-typed-server')({
  server: {
    handlers: {
      GET: ({ request }) => server.fetch(request),
      POST: ({ request }) => server.fetch(request),
      DELETE: ({ request }) => server.fetch(request),
    },
  },
})
