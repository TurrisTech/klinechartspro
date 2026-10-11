import { layerConfigCodec } from '../chartlayers/persist'
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

// The stored form and its validation are derived from the defaults and the fields
// (chartlayers/persist.ts), plus the one rule across fields: an inverted gap window is widened
// rather than left to match nothing.
const CODEC = layerConfigCodec(DIV_DEFAULTS, DIV_FIELDS, (config) => {
  config.rule.maxGap = Math.max(config.rule.maxGap, config.rule.minGap)
  return config
})

/** Any value -> a complete, drawable config: each field validated and clamped, anything unusable
 * falling back to its default. The panel commits every keystroke, and a stored document may be
 * from another build, so nothing reaches the drawing code unchecked. */
export function normaliseDivConfig(value: unknown): DivConfig {
  return CODEC.normalise(value)
}

/** What a pane stores: only what differs from the defaults, flat by path; undefined when nothing
 * does, so an untouched pane adds nothing to the (size-capped) wall document. */
export type StoredDivConfig = Record<string, unknown>

export function toStoredDivConfig(config: DivConfig): StoredDivConfig | undefined {
  return CODEC.toStored(config)
}

/** A stored diff merged onto the defaults, each value validated; undefined when nothing usable is
 * there, which reads as "never configured". A path this build does not know is ignored. */
export function fromStoredDivConfig(stored: unknown): DivConfig | undefined {
  return CODEC.fromStored(stored)
}
