import type { SettingsField } from '../chartlayers/settings'
import type { Mode } from './source'

// The volume profile's settings for one chart pane: what it profiles, how finely, and how it is
// drawn. Kept in the wall document (`PersistedPane.vp`, client/layout.ts) rather than in
// klinecharts calcParams, because a mode, a source interval and a colour are not numbers --
// the same reason the AREV21 divergence and the AREV lab have panels of their own.

export type SessionUnit = 'D' | 'W' | 'M'
export const MODES: readonly Mode[] = ['visible', 'session']
export const SESSION_UNITS: readonly SessionUnit[] = ['D', 'W', 'M']
/** 'auto', or a stored interval the pane is pinned to (source.ts ignores one the vendor does
 * not store or that is coarser than the chart). */
export const SOURCES: readonly string[] = ['auto', '1m', '30m', '1h', '1D']

export interface VpConfig {
  mode: Mode
  /** The period one profile covers in `session` mode. */
  session: SessionUnit
  rows: number
  /** Percent of the volume the value area holds. */
  valueArea: number
  source: string
  draw: {
    /** The longest row, as a percent of the pane's width (visible) or the session's (session). */
    width: number
    opacity: number
    showPoc: boolean
    showValueArea: boolean
    upColor: string
    downColor: string
    pocColor: string
  }
}

/** 40 rows: fine enough to show structure on a full-height pane, and with the nominal 150 bars
 * on screen it puts the source at about a tenth of the chart interval (source.ts) -- 1h under a
 * daily chart, 1m under anything from 5m to 4h. Up and down are the chart's own colours. */
export const VP_DEFAULTS: VpConfig = {
  mode: 'visible',
  session: 'D',
  rows: 40,
  valueArea: 70,
  source: 'auto',
  draw: {
    width: 25,
    opacity: 0.45,
    showPoc: true,
    showValueArea: true,
    upColor: '#26A69A',
    downColor: '#EF5350',
    pocColor: '#FFB300'
  }
}

interface NumberLever {
  path: string
  label: string
  min: number
  max: number
  step: number
  integer?: boolean
}

const PROFILE_NUMBERS: readonly NumberLever[] = [
  { path: 'rows', label: 'Rows', min: 10, max: 200, step: 1, integer: true },
  { path: 'valueArea', label: 'Value area (% of volume)', min: 50, max: 95, step: 1, integer: true }
]

const DRAW_NUMBERS: readonly NumberLever[] = [
  { path: 'draw.width', label: 'Width (% of pane or session)', min: 5, max: 100, step: 1, integer: true },
  { path: 'draw.opacity', label: 'Opacity', min: 0.1, max: 1, step: 0.05 }
]

const MODE_LABELS: Record<Mode, string> = { visible: 'Visible range', session: 'One per session' }
const SESSION_LABELS: Record<SessionUnit, string> = { D: 'Day', W: 'Week', M: 'Month' }

export const VP_FIELDS: SettingsField[] = [
  {
    kind: 'group',
    label: 'Profile',
    fields: [
      { kind: 'select', key: 'mode', label: 'Profile', options: MODES.map((m) => ({ value: m, label: MODE_LABELS[m] })) },
      {
        kind: 'select',
        key: 'session',
        label: 'Session',
        options: SESSION_UNITS.map((u) => ({ value: u, label: SESSION_LABELS[u] })),
        when: { key: 'mode', is: ['session'] }
      },
      ...PROFILE_NUMBERS.map((n) => ({ kind: 'number' as const, key: n.path, label: n.label, min: n.min, max: n.max, step: n.step, integer: n.integer })),
      {
        kind: 'select',
        key: 'source',
        label: 'Built from',
        options: SOURCES.map((s) => ({ value: s, label: s === 'auto' ? 'Automatic' : `${s} bars` }))
      }
    ]
  },
  {
    kind: 'group',
    label: 'Drawing',
    fields: [
      ...DRAW_NUMBERS.map((n) => ({ kind: 'number' as const, key: n.path, label: n.label, min: n.min, max: n.max, step: n.step, integer: n.integer })),
      { kind: 'switch', key: 'draw.showPoc', label: 'Point of control' },
      { kind: 'switch', key: 'draw.showValueArea', label: 'Shade the value area' },
      { kind: 'color', key: 'draw.upColor', label: 'Up volume' },
      { kind: 'color', key: 'draw.downColor', label: 'Down volume' },
      { kind: 'color', key: 'draw.pocColor', label: 'Point of control colour' }
    ]
  }
]

const COLOR = /^#[0-9a-fA-F]{3,8}$/

function read(source: object, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[key] : undefined), source)
}

function write(target: object, path: string, value: unknown): void {
  const keys = path.split('.')
  let current = target as Record<string, unknown>
  for (const key of keys.slice(0, -1)) current = current[key] as Record<string, unknown>
  current[keys[keys.length - 1]] = value
}

const oneOf =
  (values: readonly string[]) =>
  (raw: unknown): unknown =>
    (values as readonly unknown[]).includes(raw) ? raw : undefined
const bool = (raw: unknown): unknown => (typeof raw === 'boolean' ? raw : undefined)
const color = (raw: unknown): unknown => (typeof raw === 'string' && COLOR.test(raw) ? raw : undefined)

/** Every stored path with the validator it is read back through: `undefined` means unusable. */
const PATHS: ReadonlyArray<{ path: string; coerce: (raw: unknown) => unknown }> = [
  { path: 'mode', coerce: oneOf(MODES) },
  { path: 'session', coerce: oneOf(SESSION_UNITS) },
  { path: 'source', coerce: oneOf(SOURCES) },
  ...[...PROFILE_NUMBERS, ...DRAW_NUMBERS].map((n) => ({
    path: n.path,
    coerce: (raw: unknown) => {
      const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN
      if (!Number.isFinite(value)) return undefined
      const clamped = Math.min(n.max, Math.max(n.min, value))
      return n.integer ? Math.round(clamped) : clamped
    }
  })),
  { path: 'draw.showPoc', coerce: bool },
  { path: 'draw.showValueArea', coerce: bool },
  { path: 'draw.upColor', coerce: color },
  { path: 'draw.downColor', coerce: color },
  { path: 'draw.pocColor', coerce: color }
]

/** Any value -> a complete, drawable config: each field validated and clamped, anything
 * unusable falling back to its default. The panel commits every keystroke, and a stored
 * document may be from another build, so nothing reaches the drawing code unchecked. */
export function normaliseVpConfig(value: unknown): VpConfig {
  const config = structuredClone(VP_DEFAULTS)
  if (value && typeof value === 'object') {
    for (const { path, coerce } of PATHS) {
      const coerced = coerce(read(value, path))
      if (coerced !== undefined) write(config, path, coerced)
    }
  }
  return config
}

/** What a pane stores: only what differs from the defaults, flat by path; undefined when nothing
 * does, so an untouched pane adds nothing to the (size-capped) wall document. */
export type StoredVpConfig = Record<string, unknown>

export function toStoredVpConfig(config: VpConfig): StoredVpConfig | undefined {
  const out: StoredVpConfig = {}
  for (const { path } of PATHS) {
    const value = read(config, path)
    if (value !== read(VP_DEFAULTS, path)) out[path] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** A stored diff merged onto the defaults, each value validated; undefined when nothing usable
 * is there, which reads as "never configured". A path this build does not know is ignored. */
export function fromStoredVpConfig(stored: unknown): VpConfig | undefined {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined
  const config = structuredClone(VP_DEFAULTS)
  let touched = false
  for (const { path, coerce } of PATHS) {
    const raw = (stored as Record<string, unknown>)[path]
    if (raw === undefined) continue
    const value = coerce(raw)
    if (value === undefined) continue
    write(config, path, value)
    touched = true
  }
  return touched ? config : undefined
}
