import { describe, expect, it } from 'vitest'
import { protocolSessions } from '../../src/server/sessions'
import { inMemoryProtocolSessionStore } from '../../src/server/stores'

const hostSession = {
  protocolVersion: '2025-11-25',
  clientName: 'host',
}

const otherSession = {
  protocolVersion: '2025-11-25',
  clientName: 'other',
}

async function saveTwoSessions() {
  const sessions = protocolSessions()
  await sessions.save('sess-1', hostSession)
  await sessions.save('sess-2', otherSession)
  return sessions
}

describe('protocolSessions', () => {
  it('returns the session saved for that session id', async () => {
    const sessions = protocolSessions()

    await sessions.save('sess-1', hostSession)

    expect(await sessions.load('sess-1')).toEqual({
      protocolVersion: '2025-11-25',
      clientName: 'host',
    })
  })

  it('returns null for a deleted session id and keeps the other id', async () => {
    const sessions = await saveTwoSessions()

    await sessions.delete('sess-1')

    expect(await sessions.load('sess-1')).toBeNull()
    expect(await sessions.load('sess-2')).toEqual({
      protocolVersion: '2025-11-25',
      clientName: 'other',
    })
  })

  it('keeps a different record for each session id', async () => {
    const sessions = await saveTwoSessions()

    expect(await sessions.load('sess-1')).toEqual({
      protocolVersion: '2025-11-25',
      clientName: 'host',
    })
    expect(await sessions.load('sess-2')).toEqual({
      protocolVersion: '2025-11-25',
      clientName: 'other',
    })
  })

  it('keeps the record in memory when the caller omits the store', async () => {
    const first = protocolSessions()
    const second = protocolSessions()

    await first.save('sess-1', hostSession)

    expect(await first.load('sess-1')).toEqual({
      protocolVersion: '2025-11-25',
      clientName: 'host',
    })
    expect(await second.load('sess-1')).toBeNull()
  })

  it('uses the caller store for set and get', async () => {
    const store = inMemoryProtocolSessionStore()
    const sessions = protocolSessions(store)
    const separate = protocolSessions()

    await sessions.save('sess-1', hostSession)

    expect(await store.get('sess-1')).toEqual({
      protocolVersion: '2025-11-25',
      clientName: 'host',
    })
    expect(await separate.load('sess-1')).toBeNull()

    await store.set('sess-1', otherSession)

    expect(await sessions.load('sess-1')).toEqual({
      protocolVersion: '2025-11-25',
      clientName: 'other',
    })
  })
})
