import { describe, expect, it, vi } from 'vitest'
import { getTask, startTask } from '../../src/server/tasks'
import { inMemoryTaskStore, type TaskStore } from '../../src/server/stores'

const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const toolResult = { text: 'done' }

function createDeferred<T>() {
  const box: { resolve?: (value: T) => void } = {}
  const promise = new Promise<T>((resolve) => {
    box.resolve = resolve
  })
  const resolve = box.resolve
  if (resolve === undefined) {
    throw new Error('deferred resolve was not set')
  }
  return { promise, resolve }
}

function captureWaitUntil() {
  const calls: Array<Promise<unknown>> = []
  return {
    calls,
    waitUntil(promise: Promise<unknown>) {
      calls.push(promise)
    },
  }
}

function inflightFrom(calls: Array<Promise<unknown>>) {
  const inflight = calls[0]
  if (!(inflight instanceof Promise)) {
    throw new Error('waitUntil did not receive a promise')
  }
  return inflight
}

async function requireTask(taskId: string, store: TaskStore) {
  const polled = await getTask(taskId, store)
  if (polled === null) throw new Error(`Missing task ${taskId}`)
  return polled
}

function trackSettlement(promise: Promise<unknown>) {
  let settled = false
  const done = promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  return {
    done,
    isSettled() {
      return settled
    },
  }
}

describe('server tasks', () => {
  it('returns a handle first, then stores the tool result', async () => {
    const store = inMemoryTaskStore()
    const gate = createDeferred<typeof toolResult>()
    const captured = captureWaitUntil()
    let toolCalls = 0

    const handle = await startTask(
      () => {
        toolCalls += 1
        return gate.promise
      },
      { store, waitUntil: captured.waitUntil },
    )

    expect(toolCalls).toBe(1)
    expect(handle.taskId.length).toBeGreaterThan(0)
    const inflight = inflightFrom(captured.calls)
    const settlement = trackSettlement(inflight)
    await Promise.resolve()
    expect(settlement.isSettled()).toBe(false)

    const working = await requireTask(handle.taskId, store)
    expect(working.record).toEqual({
      taskId: handle.taskId,
      status: 'working',
      createdAt: expect.any(String),
      lastUpdatedAt: expect.any(String),
      ttlMs: null,
    })
    expect(working.record.createdAt).toMatch(isoTime)
    expect(working.spec2026).toEqual({
      resultType: 'complete',
      taskId: handle.taskId,
      status: 'working',
      createdAt: working.record.createdAt,
      lastUpdatedAt: working.record.lastUpdatedAt,
      ttlMs: null,
    })
    expect(working.spec2025).toEqual({
      taskId: handle.taskId,
      status: 'working',
      ttl: null,
      createdAt: working.record.createdAt,
      lastUpdatedAt: working.record.lastUpdatedAt,
    })

    gate.resolve(toolResult)
    await inflight
    await settlement.done

    const saved = await store.get(handle.taskId)
    expect(saved).toEqual({
      taskId: handle.taskId,
      status: 'completed',
      createdAt: working.record.createdAt,
      lastUpdatedAt: expect.any(String),
      ttlMs: null,
      result: { text: 'done' },
    })

    const polled = await requireTask(handle.taskId, store)
    expect(polled.record).toEqual(saved)
    expect(polled.spec2026).toEqual({
      resultType: 'complete',
      taskId: handle.taskId,
      status: 'completed',
      createdAt: working.record.createdAt,
      lastUpdatedAt: polled.record.lastUpdatedAt,
      ttlMs: null,
      result: { text: 'done' },
    })
    expect(polled.spec2025).toEqual({
      taskId: handle.taskId,
      status: 'completed',
      ttl: null,
      createdAt: working.record.createdAt,
      lastUpdatedAt: polled.record.lastUpdatedAt,
    })
  })

  it('stores the tool result when waitUntil is absent', async () => {
    const store = inMemoryTaskStore()
    const handle = await startTask(async () => toolResult, { store })

    await vi.waitFor(async () => {
      expect(await store.get(handle.taskId)).toEqual({
        taskId: handle.taskId,
        status: 'completed',
        createdAt: expect.any(String),
        lastUpdatedAt: expect.any(String),
        ttlMs: null,
        result: { text: 'done' },
      })
    })
  })

  it('keeps each task result under its own id', async () => {
    const store = inMemoryTaskStore()
    const first = await startTask(async () => ({ text: 'one' }), { store })
    const second = await startTask(async () => ({ text: 'two' }), { store })

    expect(first.taskId).not.toBe(second.taskId)
    await vi.waitFor(async () => {
      expect(await store.get(first.taskId)).toMatchObject({
        status: 'completed',
        result: { text: 'one' },
      })
      expect(await store.get(second.taskId)).toMatchObject({
        status: 'completed',
        result: { text: 'two' },
      })
    })
  })

  it('records a failed task when the tool throws', async () => {
    const store = inMemoryTaskStore()
    const captured = captureWaitUntil()
    const handle = await startTask(
      async () => {
        throw new Error('rate limit')
      },
      { store, waitUntil: captured.waitUntil },
    )
    await inflightFrom(captured.calls)

    const polled = await requireTask(handle.taskId, store)
    expect(await store.get(handle.taskId)).toEqual({
      taskId: handle.taskId,
      status: 'failed',
      createdAt: expect.any(String),
      lastUpdatedAt: expect.any(String),
      ttlMs: null,
      error: { code: -32603, message: 'rate limit' },
    })
    expect(polled.spec2026).toEqual({
      resultType: 'complete',
      taskId: handle.taskId,
      status: 'failed',
      createdAt: polled.record.createdAt,
      lastUpdatedAt: polled.record.lastUpdatedAt,
      ttlMs: null,
      error: { code: -32603, message: 'rate limit' },
    })
    expect(polled.spec2025).toEqual({
      taskId: handle.taskId,
      status: 'failed',
      ttl: null,
      createdAt: polled.record.createdAt,
      lastUpdatedAt: polled.record.lastUpdatedAt,
      statusMessage: 'rate limit',
    })
  })

  it('returns null when the task id is absent', async () => {
    const store = inMemoryTaskStore()
    expect(await getTask('missing', store)).toBeNull()
  })
})
