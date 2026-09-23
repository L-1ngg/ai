import type { Event as SpecEvent } from '@ag-ui/core'
import type { StreamChunk } from '../src/types'
/**
 * Wire events put TanStack extras in metadata.tanstack. Client restore copies
 * model/finishReason back onto RunFinishedEvent for onChunk.
 */

import { describe, expectTypeOf, it } from 'vitest'
import type { TextActivityResult } from '../src/activities/chat'
import type {
  ChatStream,
  RunFinishedEvent,
  ToolCallEndEvent,
} from '../src/types'

type HasKey<T, K extends string> = K extends keyof T ? true : false

describe('public StreamChunk extras', () => {
  it('RunFinishedEvent restores model/finishReason for client onChunk', () => {
    expectTypeOf<HasKey<RunFinishedEvent, 'model'>>().toEqualTypeOf<true>()
    expectTypeOf<
      HasKey<RunFinishedEvent, 'finishReason'>
    >().toEqualTypeOf<true>()
  })

  it('ToolCallEndEvent has no output/result/toolName', () => {
    expectTypeOf<HasKey<ToolCallEndEvent, 'output'>>().toEqualTypeOf<false>()
    expectTypeOf<HasKey<ToolCallEndEvent, 'result'>>().toEqualTypeOf<false>()
    expectTypeOf<HasKey<ToolCallEndEvent, 'toolName'>>().toEqualTypeOf<false>()
  })

  it('TextActivityResult<undefined, true> equals ChatStream', () => {
    expectTypeOf<
      TextActivityResult<undefined, true>
    >().toEqualTypeOf<ChatStream>()
  })
})

it('accepts every AG-UI 1.0 event without requiring extra fields', () => {
  expectTypeOf<SpecEvent>().toExtend<StreamChunk>()
  expectTypeOf<`${StreamChunk['type']}`>().toEqualTypeOf<`${SpecEvent['type']}`>()
})
