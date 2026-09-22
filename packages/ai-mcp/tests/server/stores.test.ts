import { describe, expect, it } from 'vitest'
import {
  inMemoryProtocolSessionStore,
  inMemoryTaskStore,
  type ProtocolSessionStore,
} from '../../src/server/stores'

const protocolSession = {
  protocolVersion: '2025-11-25',
}

const taskRecord = {
  status: 'working',
  progress: 1,
}

function describeStore(
  label: string,
  create: () => ProtocolSessionStore,
  saved: unknown,
) {
  describe(label, () => {
    it('returns the value that set saved', async () => {
      const store = create()
      await store.set('item-1', saved)
      expect(await store.get('item-1')).toEqual(saved)
    })

    it('returns null when the id is missing', async () => {
      const store = create()
      expect(await store.get('missing')).toBeNull()
    })

    it('returns null for a deleted id and keeps the other id', async () => {
      const store = create()
      await store.set('item-1', saved)
      await store.set('item-2', saved)
      await store.delete('item-1')
      expect(await store.get('item-1')).toBeNull()
      expect(await store.get('item-2')).toEqual(saved)
    })

    it('replaces the value when set uses the same id', async () => {
      const store = create()
      await store.set('item-1', saved)
      await store.set('item-1', { replaced: true })
      expect(await store.get('item-1')).toEqual({ replaced: true })
    })

    it('does not share entries with a second call', async () => {
      const first = create()
      const second = create()
      await first.set('item-1', saved)
      expect(await second.get('item-1')).toBeNull()
      expect(await first.get('item-1')).toEqual(saved)
    })
  })
}

describe('in-memory protocol stores', () => {
  describeStore(
    'protocol session store',
    inMemoryProtocolSessionStore,
    protocolSession,
  )
  describeStore('task store', inMemoryTaskStore, taskRecord)

  it('does not let a session store and a task store see each other', async () => {
    const sessions = inMemoryProtocolSessionStore()
    const tasks = inMemoryTaskStore()
    await sessions.set('shared-id', protocolSession)
    await tasks.set('shared-id', taskRecord)

    expect(await sessions.get('shared-id')).toEqual({
      protocolVersion: '2025-11-25',
    })
    expect(await tasks.get('shared-id')).toEqual({
      status: 'working',
      progress: 1,
    })
  })
})
