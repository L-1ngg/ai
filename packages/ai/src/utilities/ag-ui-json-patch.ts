import type { JsonPatchOperation } from '@ag-ui/core'

function copy<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function segments(pointer: string): Array<string> {
  if (pointer === '') return []
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer))
    throw new Error('Invalid JSON pointer')
  return pointer
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function index(key: string, length: number, append = false): number {
  if (append && key === '-') return length
  if (!/^(0|[1-9][0-9]*)$/u.test(key)) throw new Error('Invalid array index')
  const value = Number(key)
  if (value > length || (!append && value === length))
    throw new Error('Array index out of bounds')
  return value
}

function child(value: unknown, key: string): unknown {
  if (Array.isArray(value)) return value[index(key, value.length)]
  if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key))
    throw new Error('JSON pointer does not resolve')
  return Reflect.get(value, key)
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (
    left === null ||
    right === null ||
    typeof left !== 'object' ||
    typeof right !== 'object' ||
    Array.isArray(left) !== Array.isArray(right)
  )
    return false
  const keys = Object.keys(left)
  return (
    keys.length === Object.keys(right).length &&
    keys.every(
      (key) =>
        Object.hasOwn(right, key) &&
        equal(Reflect.get(left, key), Reflect.get(right, key)),
    )
  )
}

/** RFC 6902, applied atomically. A rejected operation leaves the source untouched. */
export function applyAGUIPatch(
  source: unknown,
  patch: Array<JsonPatchOperation>,
): unknown {
  let document = copy(source)
  const get = (path: Array<string>): unknown => path.reduce(child, document)
  const write = (
    path: Array<string>,
    value: unknown,
    operation: 'add' | 'replace' | 'remove',
  ) => {
    if (!path.length) {
      document = operation === 'remove' ? null : copy(value)
      return
    }
    const parent = get(path.slice(0, -1))
    const key = path[path.length - 1]!
    if (Array.isArray(parent)) {
      const offset = index(key, parent.length, operation === 'add')
      if (operation === 'remove') parent.splice(offset, 1)
      else if (operation === 'add') parent.splice(offset, 0, copy(value))
      else parent[offset] = copy(value)
    } else {
      if (parent === null || typeof parent !== 'object')
        throw new Error('JSON pointer parent is not a container')
      if (operation !== 'add' && !Object.hasOwn(parent, key))
        throw new Error('JSON pointer does not resolve')
      if (operation === 'remove') Reflect.deleteProperty(parent, key)
      // Define rather than assign: __proto__ is JSON data, never a setter.
      else
        Object.defineProperty(parent, key, {
          value: copy(value),
          enumerable: true,
          writable: true,
          configurable: true,
        })
    }
  }
  for (const operation of patch) {
    const path = segments(operation.path)
    switch (operation.op) {
      case 'add':
      case 'replace':
        write(path, operation.value, operation.op)
        break
      case 'remove':
        write(path, undefined, 'remove')
        break
      case 'test':
        if (!equal(get(path), operation.value))
          throw new Error('JSON Patch test failed')
        break
      case 'copy':
        write(path, get(segments(operation.from)), 'add')
        break
      case 'move': {
        const from = segments(operation.from)
        if (
          from.length < path.length &&
          from.every((key, position) => path[position] === key)
        )
          throw new Error('Cannot move a value into its descendant')
        const value = get(from)
        write(from, undefined, 'remove')
        write(path, value, 'add')
        break
      }
    }
  }
  return document
}
