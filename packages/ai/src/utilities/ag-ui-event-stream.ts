import { AGUIError, EventType } from '@ag-ui/core'
import { validateAGUIEvent } from './ag-ui-validation'
import type { AGUIEvent, Message } from '@ag-ui/core'
import type { ProtocolWarning } from './ag-ui-validation'

type Owner = string | undefined
type Family = 'TEXT_MESSAGE' | 'TOOL_CALL' | 'REASONING_MESSAGE'
interface Lane {
  family: Family
  id: string
  opener: Record<string, unknown>
}

/** One protocol stream. Create a separate instance for each concurrent producer. */
export class AGUIEventStream {
  private status: 'new' | 'running' | 'finished' | 'error' = 'new'
  private readonly lanes = new Map<Owner, Lane>()
  private readonly open = new Map<string, Set<string>>()
  private readonly owners = new Map<string, Map<string, Owner>>()
  private readonly steps = new Map<Owner, Set<string>>()
  private readonly subagents = new Map<string, boolean>()
  private readonly attributed = new Set<string>()

  constructor(
    private readonly warn: ProtocolWarning = (message) =>
      console.warn(`[AG-UI] ${message}`),
  ) {}

  push(value: unknown): Array<AGUIEvent> {
    const event = validateAGUIEvent(value, this.warn)
    if (!event) return []
    const events = this.expand(event)
    for (const next of events) this.verify(next)
    return events
  }

  private fail(message: string): never {
    throw new AGUIError(message)
  }

  private close(owner: Owner): Array<AGUIEvent> {
    const lane = this.lanes.get(owner)
    if (!lane) return []
    this.lanes.delete(owner)
    return [
      {
        type: `${lane.family}_END`,
        [lane.family === 'TOOL_CALL' ? 'toolCallId' : 'messageId']: lane.id,
        ...(owner !== undefined ? { subagentRunId: owner } : {}),
      } as AGUIEvent,
    ]
  }

  private expand(event: AGUIEvent): Array<AGUIEvent> {
    const owner = 'subagentRunId' in event ? event.subagentRunId : undefined
    if (
      event.type !== EventType.TEXT_MESSAGE_CHUNK &&
      event.type !== EventType.TOOL_CALL_CHUNK &&
      event.type !== EventType.REASONING_MESSAGE_CHUNK
    ) {
      if (
        [
          'RAW',
          'ACTIVITY_SNAPSHOT',
          'ACTIVITY_DELTA',
          'REASONING_ENCRYPTED_VALUE',
          'SUBAGENT_STARTED',
        ].includes(event.type)
      )
        return [event]
      if (
        [
          'RUN_STARTED',
          'RUN_FINISHED',
          'RUN_ERROR',
          'MESSAGES_SNAPSHOT',
        ].includes(event.type)
      ) {
        return [
          ...[...this.lanes.keys()].flatMap((key) => this.close(key)),
          event,
        ]
      }
      return [...this.close(owner), event]
    }
    const family: Family =
      event.type === EventType.TOOL_CALL_CHUNK
        ? 'TOOL_CALL'
        : event.type === EventType.TEXT_MESSAGE_CHUNK
          ? 'TEXT_MESSAGE'
          : 'REASONING_MESSAGE'
    const id =
      'toolCallId' in event
        ? event.toolCallId
        : 'messageId' in event
          ? event.messageId
          : undefined
    let laneOwner = owner
    if (id !== undefined) {
      const holder = [...this.lanes].find(
        ([, lane]) => lane.family === family && lane.id === id,
      )
      if (holder) {
        if (owner !== undefined && owner !== holder[0])
          this.fail('Chunk subagentRunId does not match its opener')
        laneOwner = holder[0]
      }
    } else if (
      owner === undefined &&
      this.lanes.get(undefined)?.family !== family
    ) {
      const holders = [...this.lanes].filter(
        ([, lane]) => lane.family === family,
      )
      if (holders.length > 1)
        this.fail(
          `Ambiguous ${event.type}: attribute the continuation to its subagent`,
        )
      if (holders.length === 1) laneOwner = holders[0]?.[0]
    }
    let lane = this.lanes.get(laneOwner)
    const result: Array<AGUIEvent> = []
    if (
      lane &&
      (lane.family !== family || (id !== undefined && lane.id !== id))
    ) {
      result.push(...this.close(laneOwner))
      lane = undefined
    }
    const input: Record<string, unknown> = { ...event }
    if (!lane) {
      if (id === undefined)
        this.fail(
          `First ${event.type} must carry ${family === 'TOOL_CALL' ? 'toolCallId' : 'messageId'}`,
        )
      if (family === 'TOOL_CALL' && input.toolCallName === undefined)
        this.fail('First TOOL_CALL_CHUNK must carry toolCallName')
      const opener: Record<string, unknown> = {
        type: `${family}_START`,
        [family === 'TOOL_CALL' ? 'toolCallId' : 'messageId']: id,
        ...(laneOwner !== undefined ? { subagentRunId: laneOwner } : {}),
      }
      if (family === 'TEXT_MESSAGE') {
        opener.role = input.role ?? 'assistant'
        if (input.name !== undefined) opener.name = input.name
      } else if (family === 'REASONING_MESSAGE') opener.role = 'reasoning'
      else {
        opener.toolCallName = input.toolCallName
        if (input.parentMessageId !== undefined)
          opener.parentMessageId = input.parentMessageId
      }
      if (event.metadata !== undefined) opener.metadata = event.metadata
      if (event.timestamp !== undefined) opener.timestamp = event.timestamp
      lane = { family, id, opener }
      this.lanes.set(laneOwner, lane)
      result.push(opener as AGUIEvent)
    } else {
      for (const field of ['role', 'name', 'toolCallName', 'parentMessageId']) {
        if (input[field] !== undefined && input[field] !== lane.opener[field])
          this.fail(`Chunk ${field} does not match its opener`)
      }
    }
    // Metadata-only chunks still update the item through an empty content event.
    if (
      event.delta !== undefined ||
      event.metadata !== undefined ||
      event.rawEvent !== undefined
    ) {
      result.push({
        type: family === 'TOOL_CALL' ? 'TOOL_CALL_ARGS' : `${family}_CONTENT`,
        [family === 'TOOL_CALL' ? 'toolCallId' : 'messageId']: lane.id,
        delta: event.delta ?? '',
        ...(laneOwner !== undefined ? { subagentRunId: laneOwner } : {}),
        ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
        ...(event.timestamp !== undefined
          ? { timestamp: event.timestamp }
          : {}),
        ...(event.rawEvent !== undefined ? { rawEvent: event.rawEvent } : {}),
      } as AGUIEvent)
    }
    return result
  }

  private own(kind: string, id: string, owner: Owner): void {
    let owners = this.owners.get(kind)
    if (!owners) this.owners.set(kind, (owners = new Map()))
    if (owners.has(id)) {
      if (owner !== undefined && owner !== owners.get(id))
        this.fail(`subagentRunId does not match the ${kind} '${id}' opener`)
    } else owners.set(id, owner)
  }

  private entity(
    kind: string,
    id: string,
    owner: Owner,
    action: 'start' | 'content' | 'end',
  ): void {
    let active = this.open.get(kind)
    if (!active) this.open.set(kind, (active = new Set()))
    if (action === 'start') {
      if (active.has(id)) this.fail(`${kind} '${id}' is already active`)
      active.add(id)
    } else if (!active.has(id))
      this.fail(`Cannot continue ${kind} '${id}' without a START event`)
    this.own(kind === 'reasoning span' ? 'reasoning' : kind, id, owner)
    if (action === 'end') active.delete(id)
  }

  private seed(messages: Array<Message>, authoritative = false): void {
    for (const message of messages) {
      const kind =
        message.role === 'reasoning'
          ? 'reasoning'
          : message.role === 'activity'
            ? 'activity'
            : 'text'
      if (authoritative) this.owners.get(kind)?.delete(message.id)
      this.own(kind, message.id, message.subagentRunId)
      if (message.role === 'assistant')
        for (const call of message.toolCalls ?? []) {
          if (authoritative) this.owners.get('tool')?.delete(call.id)
          this.own('tool', call.id, message.subagentRunId)
        }
    }
  }

  private verify(event: AGUIEvent): void {
    const type = event.type
    if (
      this.status === 'new' &&
      type !== EventType.RUN_STARTED &&
      type !== EventType.RUN_ERROR
    )
      this.fail("First event must be 'RUN_STARTED'")
    if (
      (this.status === 'finished' || this.status === 'error') &&
      type !== EventType.RUN_STARTED &&
      !(this.status === 'finished' && type === EventType.RUN_ERROR)
    )
      this.fail(
        `Cannot send ${type}: run has already ${this.status === 'error' ? 'errored' : 'finished'}`,
      )
    const owner = 'subagentRunId' in event ? event.subagentRunId : undefined
    if (owner !== undefined && type !== EventType.SUBAGENT_STARTED)
      this.attributed.add(owner)
    switch (event.type) {
      case EventType.RUN_STARTED:
        if (this.status === 'running')
          this.fail('Cannot send RUN_STARTED while a run is still active')
        this.status = 'running'
        this.open.clear()
        this.owners.clear()
        this.steps.clear()
        this.subagents.clear()
        this.attributed.clear()
        this.seed(event.input?.messages ?? [])
        if (
          event.protocolVersion !== undefined &&
          event.protocolVersion !== '1.0'
        )
          this.warn(
            `Producer protocolVersion ${event.protocolVersion} differs from supported 1.0; processing known fields`,
          )
        break
      case EventType.RUN_FINISHED:
        for (const [kind, active] of this.open)
          if (active.size)
            this.fail(
              `Cannot send RUN_FINISHED while ${kind} entities are still active`,
            )
        if ([...this.steps.values()].some((steps) => steps.size))
          this.fail('Cannot send RUN_FINISHED while steps are still active')
        if ([...this.subagents.values()].some(Boolean))
          this.fail('Cannot send RUN_FINISHED while subagents are still active')
        this.status = 'finished'
        break
      case EventType.RUN_ERROR:
        this.status = 'error'
        this.open.clear()
        this.steps.clear()
        this.subagents.clear()
        break
      case EventType.TEXT_MESSAGE_START:
        this.entity('text', event.messageId, owner, 'start')
        break
      case EventType.TEXT_MESSAGE_CONTENT:
        this.entity('text', event.messageId, owner, 'content')
        break
      case EventType.TEXT_MESSAGE_END:
        this.entity('text', event.messageId, owner, 'end')
        break
      case EventType.REASONING_START:
        this.entity('reasoning span', event.messageId, owner, 'start')
        break
      case EventType.REASONING_END:
        this.entity('reasoning span', event.messageId, owner, 'end')
        break
      case EventType.REASONING_MESSAGE_START:
        this.entity('reasoning', event.messageId, owner, 'start')
        break
      case EventType.REASONING_MESSAGE_CONTENT:
        this.entity('reasoning', event.messageId, owner, 'content')
        break
      case EventType.REASONING_MESSAGE_END:
        this.entity('reasoning', event.messageId, owner, 'end')
        break
      case EventType.TOOL_CALL_START: {
        const parent = event.parentMessageId
        if (parent !== undefined && this.owners.get('text')?.has(parent)) {
          const parentOwner = this.owners.get('text')?.get(parent)
          if (owner !== undefined && owner !== parentOwner)
            this.fail(
              'Tool call subagentRunId does not match its parent message',
            )
          this.entity('tool', event.toolCallId, parentOwner, 'start')
        } else this.entity('tool', event.toolCallId, owner, 'start')
        break
      }
      case EventType.TOOL_CALL_ARGS:
        this.entity('tool', event.toolCallId, owner, 'content')
        break
      case EventType.TOOL_CALL_END:
        this.entity('tool', event.toolCallId, owner, 'end')
        break
      case EventType.TOOL_CALL_RESULT:
        this.own('tool', event.toolCallId, owner)
        break
      case EventType.ACTIVITY_SNAPSHOT:
      case EventType.ACTIVITY_DELTA:
        this.own('activity', event.messageId, owner)
        break
      case EventType.REASONING_ENCRYPTED_VALUE:
        this.own(
          event.subtype === 'tool-call'
            ? 'tool'
            : event.subtype === 'message'
              ? 'text'
              : 'reasoning',
          event.entityId,
          owner,
        )
        break
      case EventType.STEP_STARTED: {
        let steps = this.steps.get(owner)
        if (!steps) this.steps.set(owner, (steps = new Set()))
        if (steps.has(event.stepName))
          this.fail(`Step '${event.stepName}' is already active`)
        steps.add(event.stepName)
        break
      }
      case EventType.STEP_FINISHED:
        if (!this.steps.get(owner)?.delete(event.stepName))
          this.fail(`Step '${event.stepName}' has no matching STEP_STARTED`)
        break
      case EventType.SUBAGENT_STARTED:
        if (
          this.subagents.has(event.subagentRunId) ||
          this.attributed.has(event.subagentRunId)
        )
          this.fail(
            'Subagent must be announced once, before its attributed events',
          )
        if (
          event.parentSubagentRunId !== undefined &&
          !this.subagents.has(event.parentSubagentRunId)
        )
          this.fail('parentSubagentRunId has not been started')
        this.subagents.set(event.subagentRunId, true)
        break
      case EventType.SUBAGENT_FINISHED:
      case EventType.SUBAGENT_ERROR:
        if (!this.subagents.get(event.subagentRunId))
          this.fail('SUBAGENT_STARTED must be sent before a subagent terminal')
        this.subagents.set(event.subagentRunId, false)
        break
      case EventType.MESSAGES_SNAPSHOT:
        this.seed(event.messages, true)
        break
      case EventType.TEXT_MESSAGE_CHUNK:
      case EventType.TOOL_CALL_CHUNK:
      case EventType.REASONING_MESSAGE_CHUNK:
        return this.fail('Chunk events must be expanded before ordering checks')
      case EventType.STATE_SNAPSHOT:
      case EventType.STATE_DELTA:
      case EventType.RAW:
      case EventType.CUSTOM:
        break
    }
  }
}
