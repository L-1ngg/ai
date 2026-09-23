import { describe, expect, it } from 'vitest'
import { travelClient } from './direct-client-boundary'
import { travelServer } from './fixtures/travel-server'

describe('createMCPClient({ server })', () => {
  it('calls the tool, the resource, and the prompt on the server object', async () => {
    const client = await travelClient()
    const forecast = await client.callTool('get_weather', { city: 'Paris' })
    const guide = await client.readResource('file:///city-guide.md')
    const brief = await client.getPrompt('trip_brief', { city: 'Paris' })
    const typedForecast: string = forecast

    expect(typedForecast).toBe('Sunny in Paris')
    expect(guide).toEqual({ text: '# Paris\n\nPack a light jacket.' })
    expect(brief).toEqual([
      { role: 'user', content: 'Write a one-day plan for Paris.' },
    ])
  })

  it('throws when the tool name is not on the server', async () => {
    const client = await travelClient()
    const missing = client as {
      callTool: (name: string, args: { city: string }) => Promise<unknown>
    }
    await expect(
      missing.callTool('missing', { city: 'Paris' }),
    ).rejects.toThrow('The MCP server has no tool missing.')
  })
})

function rejectedCalls() {
  return travelClient().then((client) => {
    // @ts-expect-error the tool name is not on this server
    void client.callTool('missing', { city: 'Paris' })
    // @ts-expect-error city is a string
    void client.callTool('get_weather', { city: 1 })
    // @ts-expect-error the URI is not on this server
    void client.readResource('file:///missing.md')
    // @ts-expect-error the prompt name is not on this server
    void client.getPrompt('missing', { city: 'Paris' })
    // @ts-expect-error city is a string
    void client.getPrompt('trip_brief', { city: 1 })
  })
}

void rejectedCalls
void travelServer
