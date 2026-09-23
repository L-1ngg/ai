import { EventSchema } from '@ag-ui/core/schemas'
import { EventType as ClientEventType } from '../client'
import { describe, expect, it } from 'vitest'
import { EventType } from '../types'
import { specKeysFor, isSpecTopLevelKey } from './spec-event-keys'

describe('specKeysFor', () => {
  it('allows metadata on every event and usage on RUN_FINISHED / RUN_ERROR', () => {
    expect(isSpecTopLevelKey(EventType.RUN_FINISHED, 'usage')).toBe(true)
    expect(isSpecTopLevelKey(EventType.RUN_ERROR, 'usage')).toBe(true)
    expect(isSpecTopLevelKey(EventType.RUN_STARTED, 'metadata')).toBe(true)
    expect(isSpecTopLevelKey(EventType.CUSTOM, 'name')).toBe(true)
  })

  it('rejects TanStack extras', () => {
    expect(isSpecTopLevelKey(EventType.RUN_FINISHED, 'finishReason')).toBe(
      false,
    )
    expect(isSpecTopLevelKey(EventType.RUN_FINISHED, 'model')).toBe(false)
    expect(isSpecTopLevelKey(EventType.TOOL_CALL_START, 'toolName')).toBe(false)
    expect(isSpecTopLevelKey(EventType.TOOL_CALL_START, 'index')).toBe(false)
    expect(isSpecTopLevelKey(EventType.TEXT_MESSAGE_CONTENT, 'content')).toBe(
      false,
    )
    expect(isSpecTopLevelKey(EventType.TOOL_CALL_ARGS, 'args')).toBe(false)
    expect(isSpecTopLevelKey(EventType.TOOL_CALL_END, 'input')).toBe(false)
    expect(isSpecTopLevelKey(EventType.TOOL_CALL_END, 'result')).toBe(false)
    expect(isSpecTopLevelKey(EventType.RUN_ERROR, 'error')).toBe(false)
    expect(
      isSpecTopLevelKey(EventType.RUN_ERROR, 'tanstack:interruptErrors'),
    ).toBe(false)
    expect(isSpecTopLevelKey(EventType.STATE_SNAPSHOT, 'state')).toBe(false)
    expect(isSpecTopLevelKey(EventType.CUSTOM, 'threadId')).toBe(false)
    expect(specKeysFor(EventType.RUN_ERROR).has('threadId')).toBe(false)
  })
})

describe('AG-UI 1.0 contract', () => {
  it('exposes the upstream enum on the client entry', () => {
    expect(ClientEventType).toBe(EventType)
  })

  it('preserves exactly the spec fields for every event', () => {
    for (const schema of EventSchema.options) {
      const type = schema.shape.type.value
      expect([...specKeysFor(type)].sort(), type).toEqual(
        Object.keys(schema.shape).sort(),
      )
    }
  })
})
