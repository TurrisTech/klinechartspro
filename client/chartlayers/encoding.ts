import type { DeepPartial, LineType, SmoothLineStyle } from 'klinecharts'
import { withAlpha } from './color'

// Maps a datum's metrics onto a line's visual channels (width, opacity). Datum-agnostic: a
// ChartLayer supplies named metrics (client/levels/layer.ts's METRICS is the first example)
// and an Encoding names which metric drives which channel — the same two controls work for
// any future layer without new code here.

export type LinePattern = 'solid' | 'dashed' | 'dotted' | 'dashDot'

// klinecharts' LineType is only 'dashed' | 'solid' (index.d.ts:51) — richer patterns come
// from dashedValue, not from a richer style enum.
export const LINE_PATTERNS: Record<LinePattern, { style: LineType; dashedValue: number[] }> = {
  solid: { style: 'solid', dashedValue: [] },
  dashed: { style: 'dashed', dashedValue: [6, 4] },
  dotted: { style: 'dashed', dashedValue: [1, 3] },
  dashDot: { style: 'dashed', dashedValue: [8, 3, 2, 3] }
}

export interface LineAppearance {
  color: string
  pattern: LinePattern
  width: number
  /** 1 = fully opaque. Folded into `color` by toLineStyle — see color.ts. */
  opacity: number
}

export type EncodingChannel = 'width' | 'opacity' | 'both'

export interface Encoding {
  enabled: boolean
  /** Key into the layer's metric registry. */
  metric: string
  channel: EncodingChannel
  /** Metric values are clamped into this range before mapping. */
  domain: [number, number]
  /** Channel output at domain[0] / domain[1]. */
  range: [number, number]
  invert: boolean
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function normalize(value: number, [lo, hi]: [number, number]): number {
  if (hi === lo) return 0
  return clamp01((value - lo) / (hi - lo))
}

function lerp([lo, hi]: [number, number], t: number): number {
  return lo + (hi - lo) * t
}

// Applies every enabled encoding on top of `base`, in order — later encodings win on a
// shared channel. `metrics` is the datum's precomputed metric values, keyed the same as the
// `Encoding.metric` names the caller configured. A metric the encoding names but the datum
// doesn't have (or that resolves to NaN) leaves that channel at whatever it already was.
export function applyEncodings(
  base: LineAppearance,
  metrics: Record<string, number>,
  encodings: Encoding[]
): LineAppearance {
  let { width, opacity } = base
  for (const encoding of encodings) {
    if (!encoding.enabled) continue
    const raw = metrics[encoding.metric]
    if (raw === undefined || !Number.isFinite(raw)) continue
    let t = normalize(raw, encoding.domain)
    if (encoding.invert) t = 1 - t
    const value = lerp(encoding.range, t)
    if (encoding.channel === 'width' || encoding.channel === 'both') width = value
    if (encoding.channel === 'opacity' || encoding.channel === 'both') opacity = value
  }
  return { ...base, width, opacity }
}

// Where opacity stops being a concept and becomes part of the color string — klinecharts has
// nowhere else to put it (SmoothLineStyle has no alpha field, per index.d.ts:53-61).
export function toLineStyle(appearance: LineAppearance): DeepPartial<SmoothLineStyle> {
  const { style, dashedValue } = LINE_PATTERNS[appearance.pattern]
  return {
    style,
    dashedValue,
    size: appearance.width,
    color: withAlpha(appearance.color, appearance.opacity)
  }
}
