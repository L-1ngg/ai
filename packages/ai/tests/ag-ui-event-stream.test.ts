import { StreamProcessor } from '../src/activities/chat/stream/processor'
import { aguiSnapshotMessageToUIMessage } from '../src/activities/chat/messages'
import { uiMessagesToWire } from '../src/utilities/ag-ui-wire'
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { AGUIEventStream } from '../src/utilities/ag-ui-event-stream'
import { validateAGUIEvent, validateAGUIInput } from '../src/utilities/ag-ui-validation'
import type { AGUIEvent } from '@ag-ui/core'

interface Fixture {
  name: string
  area: string
  stream: Array<unknown>
  input?: { messages?: Array<import('@ag-ui/core').Message> }
  expect: {
    outcome: string
    eventTypes?: Array<string>
    eventTypesAbsent?: Array<string>
    eventPaths?: Record<string, unknown>
    eventAbsentPaths?: Array<string>
    noWarnings?: boolean
    messages?: Array<unknown>
    messageCount?: number
    state?: unknown
  }
}
// Official AG-UI corpus, pinned to ag-ui-protocol/ag-ui db790c3 (MIT).
// Era adapters are optional, and unknown-enum-value-role-fatal deliberately
// pins an upstream bug that contradicts the normative forward-compatibility rule.
const directory = new URL('./fixtures/ag-ui-1.0/', import.meta.url)
const fixtures: Array<Fixture> = readdirSync(directory).filter((file) => file.endsWith('.json')).map((file) => JSON.parse(readFileSync(new URL(file, directory), 'utf8')))
const boundaryFixtures = Object.values(fixtures).filter((fixture) => !fixture.name.startsWith('era-') && fixture.name !== 'unknown-enum-value-role-fatal')
const at = (value: unknown, path: string): unknown => path.split('.').reduce<unknown>((current, key) => current !== null && typeof current === 'object' ? Reflect.get(current, key) : undefined, value)

describe('AG-UI 1.0 protocol boundary', () => {
  it.each(boundaryFixtures)('$name', (fixture) => {
    const warnings: Array<string> = []
    const stream = new AGUIEventStream((message) => warnings.push(message))
    const events: Array<AGUIEvent> = []
    const processor = new StreamProcessor({ initialMessages: fixture.input?.messages?.map(aguiSnapshotMessageToUIMessage) })
    const warn = vi.spyOn(console, 'warn').mockImplementation((message) => warnings.push(String(message)))
    const consume = () => {
      for (const event of fixture.stream) {
        for (const next of stream.push(event)) { events.push(next); processor.processChunk(next) }
      }
    }
    if (fixture.expect.outcome === 'failed') {
      expect(consume).toThrow()
      warn.mockRestore()
      return
    }
    expect(consume).not.toThrow()
    warn.mockRestore()
    const messages = uiMessagesToWire(processor.getMessages())
    if (fixture.expect.messages !== undefined) expect(messages).toMatchObject(fixture.expect.messages)
    if (fixture.expect.messageCount !== undefined) expect(messages).toHaveLength(fixture.expect.messageCount)
    if (Object.hasOwn(fixture.expect, 'state')) expect(processor.getAgentState()).toEqual(fixture.expect.state)
    if (fixture.expect.eventTypes) expect(events.map((event) => event.type)).toEqual(fixture.expect.eventTypes)
    for (const type of fixture.expect.eventTypesAbsent ?? []) expect(events.map((event) => event.type)).not.toContain(type)
    for (const [path, value] of Object.entries(fixture.expect.eventPaths ?? {})) expect(at(events, path), path).toEqual(value)
    for (const path of fixture.expect.eventAbsentPaths ?? []) expect(at(events, path), path).toBeUndefined()
    if (fixture.expect.noWarnings) expect(warnings).toEqual([])
  })

  it('strips unknown enum values rather than rejecting a future role', () => {
    expect(validateAGUIEvent({ type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'future' }, () => {})).toEqual({ type: 'TEXT_MESSAGE_START', messageId: 'm' })
  })

  it('validates nested request fields without coercion', () => {
    expect(() => validateAGUIInput({ threadId: 't', runId: 'r', messages: [{ id: 'm', role: 'assistant', toolCalls: [{ id: 'tc', type: 'function', function: { name: 'f', arguments: {} } }] }] })).toThrow('/messages/0/toolCalls/0/function/arguments')
  })
})
