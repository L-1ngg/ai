import type { TaskStore } from './stores'

/**
 * JSON-RPC internal error.
 * A tool error has no JSON-RPC code of its own.
 */
const internalErrorCode = -32603

const toolFailedMessage = 'The tool failed.'

type TaskError = {
  code: number
  message: string
}

type TaskClock = {
  taskId: string
  createdAt: string
  lastUpdatedAt: string
  /** The auth subject that started the task. Absent without auth. */
  owner?: string
}

type WorkingTask = TaskClock & {
  status: 'working'
  ttlMs: null
}

type CompletedTask = TaskClock & {
  status: 'completed'
  ttlMs: null
  result: unknown
}

type FailedTask = TaskClock & {
  status: 'failed'
  ttlMs: null
  error: TaskError
}

type StoredTask = WorkingTask | CompletedTask | FailedTask

type Spec2026TaskGet =
  | (WorkingTask & { resultType: 'complete' })
  | (CompletedTask & { resultType: 'complete' })
  | (FailedTask & { resultType: 'complete' })

type Spec2025TaskGet =
  | (TaskClock & { status: 'working'; ttl: null })
  | (TaskClock & { status: 'completed'; ttl: null })
  | (TaskClock & { status: 'failed'; ttl: null; statusMessage: string })

type StartTaskOptions = {
  /** Task store. Use `inMemoryTaskStore()` or another {@link TaskStore}. */
  store: TaskStore
  /**
   * Keeps the process alive until the tool run settles.
   * The promise resolves after the store saves the tool result,
   * or the tool error.
   */
  waitUntil?: (promise: Promise<unknown>) => void
  /** The auth subject that starts the task. Only this subject can read it. */
  owner?: string
}

/**
 * Starts a tool run and returns a task id before the run finishes.
 *
 * `run` is the tool function. This function calls `run` in this process.
 * The caller passes `inMemoryTaskStore()` or another TaskStore
 * on `options.store`.
 * When you pass `options.waitUntil`, this function calls it
 * with the in-flight promise.
 * That promise settles after the store saves the tool result or the tool error.
 * If the store rejects the first save, this function rejects.
 * A tool error does not reject this function.
 * The store records the error on the task.
 *
 * @param run - Tool function. It returns the tool result.
 * @param options - `store` is required. `waitUntil` is optional.
 *
 * @example
 * ```ts
 * const store = inMemoryTaskStore()
 * const handle = await startTask(() => Promise.resolve({ text: 'done' }), {
 *   store,
 * })
 * ```
 */
export async function startTask(
  run: () => Promise<unknown>,
  options: StartTaskOptions,
) {
  const taskId = crypto.randomUUID()
  const now = new Date().toISOString()
  const working = workingTask(taskId, now, options.owner)
  await options.store.set(taskId, working)

  const inflight = settleTask(options.store, working, startTool(run))
  const waitUntil = options.waitUntil
  if (waitUntil !== undefined) {
    waitUntil(inflight)
  } else {
    void inflight.catch(() => undefined)
  }

  return { taskId }
}

/**
 * Returns the task record for a poll, or `null` when the id is absent.
 * The result is also `null` when `owner` is not the subject that
 * started the task.
 *
 * `spec2026` is the `tasks/get` result for the 2026 tasks extension.
 * That result has the task id and the status.
 * When the status is `completed`, `spec2026` also has the tool result
 * as a `CallToolResult`.
 * When the status is `failed`, `spec2026` has the error.
 * `spec2025` is the task object that the 2025-11-25 `tasks/get` method returns.
 * `spec2025` names the time to live `ttl`.
 * `spec2026` names the time to live `ttlMs`.
 *
 * @param taskId - Id from `startTask`.
 * @param store - Same store that `startTask` received.
 * @param owner - The auth subject of the caller. Absent without auth.
 *
 * @example
 * ```ts
 * const polled = await getTask(handle.taskId, store)
 * ```
 */
export async function getTask(
  taskId: string,
  store: TaskStore,
  owner?: string,
) {
  const value = await store.get(taskId)
  if (!isStoredTask(value)) return null
  if (value.owner !== owner) return null
  return {
    record: value,
    spec2026: spec2026View(value),
    spec2025: spec2025View(value),
  }
}

function workingTask(taskId: string, now: string, owner: string | undefined) {
  const status = 'working' as const
  const ttlMs = null
  return {
    taskId,
    status,
    createdAt: now,
    lastUpdatedAt: now,
    ttlMs,
    ...(owner === undefined ? {} : { owner }),
  }
}

type TaskStart = { taskId: string; createdAt: string; owner?: string }

function completedTask(task: TaskStart, result: unknown) {
  const status = 'completed' as const
  const ttlMs = null
  return {
    taskId: task.taskId,
    status,
    createdAt: task.createdAt,
    lastUpdatedAt: new Date().toISOString(),
    ttlMs,
    ...(task.owner === undefined ? {} : { owner: task.owner }),
    result,
  }
}

function failedTask(task: TaskStart, error: unknown) {
  const status = 'failed' as const
  const ttlMs = null
  return {
    taskId: task.taskId,
    status,
    createdAt: task.createdAt,
    lastUpdatedAt: new Date().toISOString(),
    ttlMs,
    ...(task.owner === undefined ? {} : { owner: task.owner }),
    error: {
      code: internalErrorCode,
      message: errorMessage(error),
    },
  }
}

// A tool can throw before it returns a promise.
// This function returns a rejected promise so the store can record the error.
function startTool(run: () => Promise<unknown>) {
  try {
    return Promise.resolve(run())
  } catch (error) {
    return Promise.reject(error)
  }
}

function settleTask(store: TaskStore, task: TaskStart, run: Promise<unknown>) {
  return run.then(
    (result) => store.set(task.taskId, completedTask(task, result)),
    (error: unknown) => store.set(task.taskId, failedTask(task, error)),
  )
}

function spec2026View(record: StoredTask) {
  // tasks/get uses resultType "complete". The create response uses "task".
  const resultType = 'complete' as const
  const timing = clockFields(record)
  switch (record.status) {
    case 'working':
      return {
        resultType,
        ...timing,
        status: record.status,
        ttlMs: record.ttlMs,
      } satisfies Spec2026TaskGet
    case 'completed':
      return {
        resultType,
        ...timing,
        status: record.status,
        ttlMs: record.ttlMs,
        // The 2025 tasks/result wraps the output the same way.
        result: toCallToolResult(record.result),
      } satisfies Spec2026TaskGet
    case 'failed':
      return {
        resultType,
        ...timing,
        status: record.status,
        ttlMs: record.ttlMs,
        error: record.error,
      } satisfies Spec2026TaskGet
    default: {
      const unexpected: never = record
      throw new Error(`Unknown task status: ${String(unexpected)}`)
    }
  }
}

function spec2025View(record: StoredTask) {
  const timing = clockFields(record)
  switch (record.status) {
    case 'working':
      return {
        ...timing,
        status: record.status,
        ttl: record.ttlMs,
      } satisfies Spec2025TaskGet
    case 'completed':
      return {
        ...timing,
        status: record.status,
        ttl: record.ttlMs,
      } satisfies Spec2025TaskGet
    case 'failed':
      return {
        ...timing,
        status: record.status,
        ttl: record.ttlMs,
        statusMessage: record.error.message,
      } satisfies Spec2025TaskGet
    default: {
      const unexpected: never = record
      throw new Error(`Unknown task status: ${String(unexpected)}`)
    }
  }
}

/**
 * Turns a tool output into an MCP `CallToolResult`.
 * A string becomes one text block. Any other value becomes a JSON text block.
 * An object also becomes `structuredContent`. With `structured`, every
 * value does, so the result matches an advertised output schema.
 */
export function toCallToolResult(output: unknown, structured = false) {
  // JSON.stringify(undefined) is undefined. A text block needs a string.
  const text =
    typeof output === 'string' ? output : (JSON.stringify(output) ?? '')
  const content = [{ type: 'text' as const, text }]
  if (structured || isRecord(output)) {
    return { content, structuredContent: output }
  }
  return { content }
}

function clockFields(record: TaskClock) {
  return {
    taskId: record.taskId,
    createdAt: record.createdAt,
    lastUpdatedAt: record.lastUpdatedAt,
  }
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message.length > 0) return error.message
  if (typeof error === 'string' && error.length > 0) return error
  return toolFailedMessage
}

function isStoredTask(value: unknown): value is StoredTask {
  if (!isRecord(value)) return false
  const taskIdMissing =
    typeof value.taskId !== 'string' || value.taskId.length === 0
  if (taskIdMissing) return false
  if (typeof value.createdAt !== 'string') return false
  if (typeof value.lastUpdatedAt !== 'string') return false
  if (value.ttlMs !== null) return false
  if (value.owner !== undefined && typeof value.owner !== 'string') return false
  switch (value.status) {
    case 'working':
      return true
    case 'completed':
      return 'result' in value
    case 'failed':
      return isTaskError(value.error)
    default:
      return false
  }
}

function isTaskError(value: unknown): value is TaskError {
  if (!isRecord(value)) return false
  const codeIsNumber = typeof value.code === 'number'
  const messageIsString = typeof value.message === 'string'
  return codeIsNumber && messageIsString
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
