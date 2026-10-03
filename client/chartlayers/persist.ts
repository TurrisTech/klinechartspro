import type { SettingsField } from './settings'

// A layer's config as one pane stores it. A layer's config is a nested object of primitives --
// and [min, max] tuples, which index like objects -- whose SHAPE is its defaults, so the
// defaults say which paths exist and the layer's own settings fields say what each may hold.
// That is enough to validate a stored document generically: the levels and zones configs each
// run to some forty paths, and a hand-written list of them (client/volprofile/config.ts's
// PATHS) would be one more thing to keep in step with the fields.
//
// What is stored is the VP shape (`StoredVpConfig`): only what differs from the defaults, flat
// by path, nothing at all for an untouched pane -- the whole workspace set shares one 64 KiB
// document.

export type StoredLayerConfig = Record<string, unknown>

type Primitive = string | number | boolean

interface Leaf {
  path: string
  fallback: Primitive
  coerce(raw: unknown): Primitive | undefined
}

const COLOR = /^#[0-9a-fA-F]{3,8}$/

function fieldsByKey(fields: SettingsField[], out = new Map<string, SettingsField>()): Map<string, SettingsField> {
  for (const field of fields) {
    if (field.kind === 'group') fieldsByKey(field.fields, out)
    else out.set(field.key, field)
  }
  return out
}

// What a stored or typed value must be to stand in for `fallback`: what its field allows
// where there is a field, and otherwise at least the same kind of value as the default.
function coercerFor(fallback: Primitive, field: SettingsField | undefined): Leaf['coerce'] {
  switch (field?.kind) {
    case 'number':
      return (raw) => {
        const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN
        if (!Number.isFinite(value)) return undefined
        const clamped = Math.min(field.max, Math.max(field.min, value))
        return field.integer ? Math.round(clamped) : clamped
      }
    case 'switch':
      return (raw) => (typeof raw === 'boolean' ? raw : undefined)
    case 'select':
      return (raw) => (field.options.some((option) => option.value === raw) ? (raw as string) : undefined)
    case 'color':
      return (raw) => (typeof raw === 'string' && COLOR.test(raw) ? raw : undefined)
    default:
      if (typeof fallback === 'number') {
        return (raw) => (typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined)
      }
      return (raw) => (typeof raw === typeof fallback ? (raw as Primitive) : undefined)
  }
}

function leavesOf(defaults: object, fields: SettingsField[]): Leaf[] {
  const byKey = fieldsByKey(fields)
  const out: Leaf[] = []
  const walk = (node: unknown, prefix: string): void => {
    if (node !== null && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walk(child, prefix ? `${prefix}.${key}` : key)
      return
    }
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      out.push({ path: prefix, fallback: node, coerce: coercerFor(node, byKey.get(prefix)) })
    }
  }
  walk(defaults, '')
  return out
}

function read(source: unknown, path: string): unknown {
  let current = source
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

function write(target: object, path: string, value: unknown): void {
  const keys = path.split('.')
  let current = target as Record<string, unknown>
  for (const key of keys.slice(0, -1)) current = current[key] as Record<string, unknown>
  current[keys[keys.length - 1]] = value
}

export interface LayerConfigCodec<T> {
  /** Any value -> a complete, drawable config: each path validated against its field,
   * anything unusable falling back to its default. A path the defaults lack is dropped -- a
   * saved `intervals.1D` from before 1D levels were retired reads as nothing, not as a toggle. */
  normalise(value: unknown): T
  /** Only what differs from the defaults, flat by path; undefined when nothing does. */
  toStored(config: T): StoredLayerConfig | undefined
  /** A stored diff merged onto the defaults, each value validated; undefined when nothing
   * usable is there, which reads as "never configured". */
  fromStored(stored: unknown): T | undefined
}

export function layerConfigCodec<T extends object>(defaults: T, fields: SettingsField[]): LayerConfigCodec<T> {
  const leaves = leavesOf(defaults, fields)
  return {
    normalise(value) {
      const config = structuredClone(defaults)
      for (const leaf of leaves) {
        const coerced = leaf.coerce(read(value, leaf.path))
        if (coerced !== undefined) write(config, leaf.path, coerced)
      }
      return config
    },
    toStored(config) {
      const out: StoredLayerConfig = {}
      for (const leaf of leaves) {
        const value = read(config, leaf.path)
        if (value !== leaf.fallback) out[leaf.path] = value
      }
      return Object.keys(out).length > 0 ? out : undefined
    },
    fromStored(stored) {
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined
      const config = structuredClone(defaults)
      let touched = false
      for (const leaf of leaves) {
        const raw = (stored as Record<string, unknown>)[leaf.path]
        if (raw === undefined) continue
        const value = leaf.coerce(raw)
        if (value === undefined) continue
        write(config, leaf.path, value)
        touched = true
      }
      return touched ? config : undefined
    }
  }
}
