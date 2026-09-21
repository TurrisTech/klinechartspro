import type { SettingsField } from '../chartlayers/settings'
import { AREV21_LOOKBACK, type Rule } from './divergence'

// The divergence's settings for one chart pane: the swing rule and how its lines are drawn.
//
// ONE config per pane, read by both templates (the prediction pane and the price pane), so the
// two halves of one argument can never disagree about which swings they joined or what colour a
// bullish one is. It lives in the wall document (`PersistedPane.dv`, client/layout.ts) rather
// than in klinecharts calcParams, because a colour and a line style are not numbers -- which is
// the whole reason this indicator has a settings panel of its own, as the AREV lab does.

export type LineStyle = 'dotted' | 'dashed' | 'solid'
export const LINE_STYLES: readonly LineStyle[] = ['dotted', 'dashed', 'solid']

export interface DivConfig {
  rule: Rule
  line: {
    style: LineStyle
    /** Stroke width in px; a dotted line's dots are this wide. */
    width: number
    /** A bullish divergence's line and arrow (at a swing low). */
    bullColor: string
    /** A bearish divergence's line and arrow (at a swing high). */
    bearColor: string
    /** How strongly a hidden divergence is drawn beside a regular one, 0..1. */
    hiddenOpacity: number
  }
}

/** Thick and dotted by default (user, 2026-09-21): it cannot be mistaken for a series line or a
 * hand-drawn trend line. Green and red are the chart's own up and down. */
export const DIV_DEFAULTS: DivConfig = {
  rule: { left: AREV21_LOOKBACK, right: 5, minGap: 5, maxGap: 60, minDp: 0, hidden: false },
  line: { style: 'dotted', width: 3, bullColor: '#26A69A', bearColor: '#EF5350', hiddenOpacity: 0.5 }
}

interface NumberLever {
  path: string
  label: string
  min: number
  max: number
  step: number
  integer?: boolean
}

const RULE_NUMBERS: readonly NumberLever[] = [
  { path: 'rule.left', label: 'Swing: bars on its left', min: 2, max: 100, step: 1, integer: true },
  { path: 'rule.right', label: 'Swing: bars to confirm it', min: 1, max: 50, step: 1, integer: true },
  { path: 'rule.minGap', label: 'Fewest bars between swings', min: 1, max: 500, step: 1, integer: true },
  { path: 'rule.maxGap', label: 'Most bars between swings', min: 2, max: 1000, step: 1, integer: true },
  { path: 'rule.minDp', label: 'Smallest change in p', min: 0, max: 0.5, step: 0.005 }
]

const LINE_NUMBERS: readonly NumberLever[] = [
  { path: 'line.width', label: 'Line width', min: 1, max: 10, step: 0.5 },
  { path: 'line.hiddenOpacity', label: 'Hidden divergence opacity', min: 0.1, max: 1, step: 0.05 }
]

export const DIV_FIELDS: SettingsField[] = [
  {
    kind: 'group',
    label: 'Swings',
    fields: [
      ...RULE_NUMBERS.map((n) => ({ kind: 'number' as const, key: n.path, label: n.label, min: n.min, max: n.max, step: n.step, integer: n.integer })),
      { kind: 'switch', key: 'rule.hidden', label: 'Hidden divergences too' }
    ]
  },
  {
    kind: 'group',
    label: 'Lines',
    fields: [
      {
        kind: 'select',
        key: 'line.style',
        label: 'Line style',
        options: LINE_STYLES.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) }))
      },
      ...LINE_NUMBERS.map((n) => ({ kind: 'number' as const, key: n.path, label: n.label, min: n.min, max: n.max, step: n.step })),
      { kind: 'color', key: 'line.bullColor', label: 'Bullish colour' },
      { kind: 'color', key: 'line.bearColor', label: 'Bearish colour' }
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

/** Every stored path with the validator it is read back through: `undefined` means unusable. */
const PATHS: ReadonlyArray<{ path: string; coerce: (raw: unknown) => unknown }> = [
  ...[...RULE_NUMBERS, ...LINE_NUMBERS].map((n) => ({
    path: n.path,
    coerce: (raw: unknown) => {
      const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN
      if (!Number.isFinite(value)) return undefined
      const clamped = Math.min(n.max, Math.max(n.min, value))
      return n.integer ? Math.round(clamped) : clamped
    }
  })),
  { path: 'rule.hidden', coerce: (raw: unknown) => (typeof raw === 'boolean' ? raw : undefined) },
  { path: 'line.style', coerce: (raw: unknown) => ((LINE_STYLES as readonly unknown[]).includes(raw) ? raw : undefined) },
  { path: 'line.bullColor', coerce: (raw: unknown) => (typeof raw === 'string' && COLOR.test(raw) ? raw : undefined) },
  { path: 'line.bearColor', coerce: (raw: unknown) => (typeof raw === 'string' && COLOR.test(raw) ? raw : undefined) }
]

/** Any value -> a complete, drawable config: each field validated and clamped, anything unusable
 * falling back to its default. The panel commits every keystroke, and a stored document may be
 * from another build, so nothing reaches the drawing code unchecked. An inverted gap window is
 * widened rather than left to match nothing. */
export function normaliseDivConfig(value: unknown): DivConfig {
  const config = structuredClone(DIV_DEFAULTS)
  if (value && typeof value === 'object') {
    for (const { path, coerce } of PATHS) {
      const coerced = coerce(read(value, path))
      if (coerced !== undefined) write(config, path, coerced)
    }
  }
  config.rule.maxGap = Math.max(config.rule.maxGap, config.rule.minGap)
  return config
}

/** What a pane stores: only what differs from the defaults, flat by path; undefined when nothing
 * does, so an untouched pane adds nothing to the (size-capped) wall document. */
export type StoredDivConfig = Record<string, unknown>

export function toStoredDivConfig(config: DivConfig): StoredDivConfig | undefined {
  const out: StoredDivConfig = {}
  for (const { path } of PATHS) {
    const value = read(config, path)
    if (value !== read(DIV_DEFAULTS, path)) out[path] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** A stored diff merged onto the defaults, each value validated; undefined when nothing usable is
 * there, which reads as "never configured". A path this build does not know is ignored. */
export function fromStoredDivConfig(stored: unknown): DivConfig | undefined {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined
  const config = structuredClone(DIV_DEFAULTS)
  let touched = false
  for (const { path, coerce } of PATHS) {
    const raw = (stored as Record<string, unknown>)[path]
    if (raw === undefined) continue
    const value = coerce(raw)
    if (value === undefined) continue
    write(config, path, value)
    touched = true
  }
  if (!touched) return undefined
  config.rule.maxGap = Math.max(config.rule.maxGap, config.rule.minGap)
  return config
}
