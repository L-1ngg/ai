import { createServerFn } from '@tanstack/react-start'
import { createMCPClient } from '@tanstack/ai-mcp'
import { handleMcp } from '../mcp-server'

export type DeskResult = {
  forecast: string
  guide: string
  brief: string
}

function textFrom(value: unknown) {
  if (typeof value === 'string') return value
  return ''
}

function messageText(message: unknown) {
  if (typeof message !== 'object' || message === null) return ''
  if (!('content' in message)) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (
    typeof content === 'object' &&
    content !== null &&
    'text' in content &&
    typeof content.text === 'string'
  ) {
    return content.text
  }
  return ''
}

export const callDesk = createServerFn({ method: 'POST' }).handler(
  async (): Promise<DeskResult> => {
    const client = await createMCPClient({
      transport: {
        type: 'http',
        url: 'http://127.0.0.1/mcp',
        fetch: (input, init) => handleMcp(new Request(input, init)),
      },
    })

    try {
      const tools = await client.tools()
      const weather = tools.find((tool) => tool.name === 'get_weather')
      const execute = weather?.execute
      const forecast =
        execute === undefined ? '' : textFrom(await execute({ city: 'Paris' }))
      const guideResult = await client.readResource('file:///city-guide.md')
      const guideBlock = guideResult.contents[0]
      const guide =
        guideBlock !== undefined &&
        'text' in guideBlock &&
        typeof guideBlock.text === 'string'
          ? guideBlock.text
          : ''
      const prompt = await client.getPrompt('trip_brief', { city: 'Paris' })
      const brief = messageText(prompt.messages[0])
      return { forecast, guide, brief }
    } finally {
      await client.close()
    }
  },
)
