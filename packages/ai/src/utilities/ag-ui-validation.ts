import { AGUIError } from '@ag-ui/core'
import { aguiSchema } from './ag-ui-schema'
import type { AGUIEvent, RunAgentInput } from '@ag-ui/core'

interface Schema {
  ref?: string
  type?: string | Array<string>
  properties?: Record<string, Schema>
  required?: Array<string>
  allOf?: Array<Schema>
  oneOf?: Array<Schema>
  items?: Schema
  not?: Schema
  minimum?: number
  maximum?: number
  minItems?: number
  pattern?: string
  enum?: Array<unknown>
  const?: unknown
  additionalProperties?: boolean
  unevaluatedProperties?: boolean
}

const schemas: Record<string, Schema> = aguiSchema
const resolved = new WeakMap<Schema, Schema>()
const DROP = Symbol('unknown AG-UI member')
export type ProtocolWarning = (message: string) => void
const warn: ProtocolWarning = (message) => console.warn(`[AG-UI] ${message}`)

function resolve(schema: Schema): Schema {
  const cached = resolved.get(schema)
  if (cached) return cached
  const parents = [
    ...(schema.ref ? [resolve(schemas[schema.ref]!)] : []),
    ...(schema.allOf?.map(resolve) ?? []),
  ]
  const value: Schema = Object.assign({}, ...parents, schema)
  if (parents.length) {
    value.properties = Object.assign(
      {},
      ...parents.map((parent) => parent.properties),
      schema.properties,
    )
    value.required = [
      ...new Set([
        ...parents.flatMap((parent) => parent.required ?? []),
        ...(schema.required ?? []),
      ]),
    ]
  }
  resolved.set(schema, value)
  return value
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function kind(value: unknown): string {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
}

function invalid(path: string, expected: string): never {
  throw new AGUIError(
    `Invalid AG-UI field ${path || '/'}: expected ${expected}`,
  )
}

/** Interpret the generated schema subset, without loading Zod in browser bundles. */
function read(
  value: unknown,
  input: Schema,
  path: string,
  report: ProtocolWarning,
): unknown {
  const schema = resolve(input)
  if (schema.not?.type === 'null' && value === null)
    invalid(path, 'a non-null value')
  if (schema.oneOf) {
    const choices = schema.oneOf.map(resolve)
    const tag = ['type', 'role', 'op'].find((key) =>
      choices.every((choice) => choice.properties?.[key]?.const !== undefined),
    )
    if (tag && object(value)) {
      const choice = choices.find(
        (candidate) => candidate.properties?.[tag]?.const === value[tag],
      )
      if (!choice) {
        // Unknown union members are forward-compatible; wrong shapes remain fatal.
        if (typeof value[tag] !== 'string')
          invalid(`${path}/${tag}`, 'a string discriminator')
        report(`Removed unrecognized member at ${path || '/'}`)
        return DROP
      }
      return read(value, choice, path, report)
    }
    const choice = choices.find((candidate) =>
      (Array.isArray(candidate.type)
        ? candidate.type
        : [candidate.type]
      ).includes(kind(value)),
    )
    if (!choice) invalid(path, 'a supported union value')
    return read(value, choice, path, report)
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (
      !types.some(
        (type) =>
          type === kind(value) ||
          (type === 'integer' && Number.isSafeInteger(value)),
      )
    ) {
      invalid(path, types.join(' | '))
    }
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const)
    invalid(path, JSON.stringify(schema.const))
  if (schema.enum && !schema.enum.includes(value)) {
    if (typeof value !== 'string') invalid(path, 'a string')
    report(`Removed unrecognized value at ${path}`)
    return DROP
  }
  if (typeof value === 'number') {
    if (
      !Number.isFinite(value) ||
      (schema.minimum !== undefined && value < schema.minimum) ||
      (schema.maximum !== undefined && value > schema.maximum)
    )
      invalid(path, 'a number within the schema bounds')
  }
  if (
    typeof value === 'string' &&
    schema.pattern &&
    !new RegExp(schema.pattern).test(value)
  )
    invalid(path, `a string matching ${schema.pattern}`)
  if (Array.isArray(value) && schema.items) {
    const result = value
      .map((item, index) =>
        read(item, schema.items!, `${path}/${index}`, report),
      )
      .filter((item) => item !== DROP)
    if (schema.minItems !== undefined && result.length < schema.minItems)
      invalid(path, `at least ${schema.minItems} items`)
    return result
  }
  if (object(value) && schema.properties) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined)
        invalid(`${path}/${key}`, 'a required value')
    }
    const entries: Array<[string, unknown]> = []
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue
      if (!Object.hasOwn(schema.properties, key)) {
        if (
          schema.unevaluatedProperties !== false &&
          schema.additionalProperties !== false
        )
          entries.push([key, child])
        else report(`Removed unrecognized field ${path}/${key}`)
        continue
      }
      const next = read(
        child,
        schema.properties[key]!,
        `${path}/${key}`,
        report,
      )
      if (next === DROP) {
        if (schema.required?.includes(key)) return DROP
      } else entries.push([key, next])
    }
    return Object.fromEntries(entries)
  }
  return value
}

/** Drop unknown material; reject malformed known fields before application. */
export function validateAGUIEvent(
  value: unknown,
  report: ProtocolWarning = warn,
): AGUIEvent | undefined {
  const result = read(value, schemas.Event!, '', report)
  return result === DROP ? undefined : (result as AGUIEvent)
}

export function validateAGUIInput(
  value: unknown,
  report: ProtocolWarning = warn,
): RunAgentInput {
  const result = read(value, schemas.RunAgentInput!, '', report)
  if (result === DROP) invalid('/', 'a recognized RunAgentInput')
  return result as RunAgentInput
}
