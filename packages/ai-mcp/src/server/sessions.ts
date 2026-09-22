import { inMemoryProtocolSessionStore } from './stores'
import type { ProtocolSessionStore } from './stores'

/**
 * Saves, loads, and deletes one spec 2025 session record by session id.
 *
 * `store` is the {@link ProtocolSessionStore} that keeps the records.
 * If you omit `store`, this function uses an in-memory store.
 * Each call that omits `store` gets its own store.
 * The in-memory store keeps the records in this process only.
 *
 * @param store - Session record store. An omitted store is in-memory.
 *
 * @example
 * ```ts
 * const sessions = protocolSessions()
 * await sessions.save('sess-1', { protocolVersion: '2025-11-25' })
 * await sessions.load('sess-1')
 * ```
 */
export function protocolSessions(
  store: ProtocolSessionStore = inMemoryProtocolSessionStore(),
) {
  return {
    /**
     * Saves `session` for `sessionId`.
     * A later save for the same id replaces the record.
     *
     * @param sessionId - The session id
     * @param session - The session record
     */
    save(sessionId: string, session: unknown) {
      return store.set(sessionId, session)
    },

    /**
     * Returns the record for `sessionId`.
     * When the id is absent, the result is `null`.
     *
     * @param sessionId - The session id
     */
    load(sessionId: string) {
      return store.get(sessionId)
    },

    /**
     * Removes the record for `sessionId`.
     * An absent id stays absent.
     *
     * @param sessionId - The session id
     */
    delete(sessionId: string) {
      return store.delete(sessionId)
    },
  }
}
