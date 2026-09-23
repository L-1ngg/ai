import { EventType } from '../types'
import type { StreamChunk } from '../types'
import type { AdapterYieldChunk } from './adapter-yield-chunk'
import { tanstackMetadata } from './merge-metadata'

/**
 * Restore aliases the wire does not keep (`toolName`, `TOOL_CALL_END.input`)
 * while preserving upstream `usage[]` verbatim. Mutates
 * in place so WeakMap run-id stamps stay attached.
 */
export function restorePublicAliases(chunk: StreamChunk): StreamChunk {
  if (
    chunk.type === EventType.TOOL_CALL_START &&
    chunk.toolName === undefined &&
    chunk.toolCallName
  ) {
    chunk.toolName = chunk.toolCallName
  }

  if (chunk.type === EventType.TOOL_CALL_END && chunk.input === undefined) {
    const input = tanstackMetadata(chunk)?.input
    if (input !== undefined) {
      chunk.input = input
    }
  }

  return chunk
}

/**
 * Rebuild the pre-wire chunk shape after SSE/HTTP/WS ingest.
 * Copies `metadata.tanstack` extras back to top-level fields. Usage remains
 * the upstream array, including every provider/model entry.
 */
export function restoreInboundChunk(chunk: StreamChunk): AdapterYieldChunk {
  restorePublicAliases(chunk)
  const tanstack = tanstackMetadata(chunk)
  const next = chunk as AdapterYieldChunk & Record<string, unknown>

  if (tanstack == null) {
    return next
  }

  for (const [key, value] of Object.entries(tanstack)) {
    if (key === 'usage' || key === 'interruptErrors') continue
    if (next[key] === undefined && value !== undefined) {
      next[key] = value
    }
  }

  if (tanstack.interruptErrors !== undefined) {
    next['tanstack:interruptErrors'] = tanstack.interruptErrors
  }

  return next
}
