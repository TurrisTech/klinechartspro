// VALUES PER BAR: one timeframe's bars, plus the server points a rule reads on it, as a
// `Track` (./timeline.ts) -- each bar's close, and each operand's value on that bar.
//
// A built-in indicator is computed by klinecharts' own template (`getIndicatorClass`, exported
// by the klinecharts patch), over the bars handed in -- so an alert's RSI is the chart's RSI,
// not a second implementation that could round differently. It is computed over a WINDOW, the
// lead-in the caller fetched (./catalogue.ts `leadInBars`): exact for a moving average, and
// converged to well under a part in ten thousand for a recursive one, the same contract every
// windowed indicator read in this project keeps.
//
// A server series or signal is a lookup by the bar's wire date, which is the date both the
// bar and the plugin's point are filed under.

import { getIndicatorClass, type Indicator, type KLineData } from 'klinecharts'
import type { ReplayBar } from '../replay/cache'
import { readField } from '../tsregistry/api'
import { operandKey } from './rules'
import type { Track, Value } from './timeline'
import type { Operand } from './types'

/** A stored bar: the store-clock open, its close (the effective instant), the wire date the
 * server files it and its points under, and the prices. `ReplayBar` is one. */
export type AlertBar = Pick<ReplayBar, 'open' | 'end' | 'date' | 'o' | 'h' | 'l' | 'c' | 'v'>

/** A plugin's rows on one bar. `folded` files them under their fold field (krev01's `top` and
 * `bottom`), which is what a dotted series key (`top.p`) reads; unfolded it is the one row. */
export interface PointRows {
  rows: Array<Record<string, unknown>>
  folded: Record<string, unknown>
}

export type PointIndex = ReadonlyMap<number, PointRows>

/** Index a plugin's points by bar date, folding several rows on one bar under `foldBy`. */
export function indexPoints(points: ReadonlyArray<{ date: number }>, foldBy: string | null): Map<number, PointRows> {
  const out = new Map<number, PointRows>()
  for (const point of points) {
    const row = point as Record<string, unknown>
    let entry = out.get(point.date)
    if (!entry) {
      entry = { rows: [], folded: {} }
      out.set(point.date, entry)
    }
    entry.rows.push(row)
    if (foldBy) {
      const side = row[foldBy]
      if (typeof side === 'string') entry.folded[side] = row
    } else entry.folded = row
  }
  return out
}

/** Where a server operand's points come from: its plugin, variant and fold. Resolved by the
 * caller from the catalogue (a series names a registry row; a signal names its plugin). */
export interface PointSource {
  plugin: string
  variant: string
  foldBy: string | null
}

/** One timeframe's track. `points` answers for a server operand on this interval, or
 * undefined when nothing was fetched for it -- every value then reads as missing. */
export async function buildTrack(
  interval: string,
  bars: readonly AlertBar[],
  operands: Iterable<Operand>,
  points: (operand: Operand) => PointIndex | undefined
): Promise<Track> {
  const values = new Map<string, Value[]>()
  let data: KLineData[] | null = null
  for (const operand of operands) {
    if (operand.interval !== interval) continue
    const key = operandKey(operand)
    if (values.has(key)) continue
    switch (operand.kind) {
      case 'bar':
        values.set(key, bars.map((bar) => barValue(bar, operand.field)))
        break
      case 'indicator':
        data ??= bars.map(toKLine)
        values.set(key, await indicatorValues(data, operand.name, operand.params, operand.output))
        break
      case 'series': {
        const index = points(operand)
        values.set(key, bars.map((bar) => seriesValue(index?.get(bar.date), operand.key)))
        break
      }
      case 'signal': {
        const index = points(operand)
        values.set(key, bars.map((bar) => signalValue(index?.get(bar.date))))
        break
      }
    }
  }
  return { interval, at: bars.map((bar) => bar.end), values }
}

function barValue(bar: AlertBar, field: 'open' | 'high' | 'low' | 'close' | 'volume'): number {
  switch (field) {
    case 'open':
      return bar.o
    case 'high':
      return bar.h
    case 'low':
      return bar.l
    case 'close':
      return bar.c
    case 'volume':
      return bar.v
  }
}

function toKLine(bar: AlertBar): KLineData {
  return { timestamp: bar.open, open: bar.o, high: bar.h, low: bar.l, close: bar.c, volume: bar.v }
}

/** A fresh instance of a registered template with `params` -- what the chart does on a
 * parameter change, through the template's public fields (`calcParams`, and the figures it
 * regenerates from them), never klinecharts' internals. Null for an unknown name. */
export function instantiate(name: string, params: readonly number[]): Indicator | null {
  const Template = getIndicatorClass(name)
  if (!Template) return null
  const instance = new Template()
  if (params.length > 0) {
    instance.calcParams = [...params]
    if (instance.regenerateFigures) instance.figures = instance.regenerateFigures(instance.calcParams)
  }
  return instance
}

/** A built-in's `output` line over `data`, aligned with it; a bar the template leaves blank
 * (its warm-up) is undefined. An unknown template computes nothing rather than throwing: the
 * rule then reads as unknowable, which never fires. */
export async function indicatorValues(
  data: KLineData[],
  name: string,
  params: readonly number[],
  output: string
): Promise<Value[]> {
  const instance = instantiate(name, params)
  if (!instance) return data.map(() => undefined)
  const result = (await instance.calc(data, instance)) as Array<Record<string, unknown> | undefined>
  return data.map((_, i) => {
    const value = result[i]?.[output]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  })
}

function seriesValue(rows: PointRows | undefined, key: string): Value {
  if (!rows) return undefined
  const value = readField(key.includes('.') ? rows.folded : rows.rows[rows.rows.length - 1], key)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** The label on a bar, '' on a bar the plugin served with no label, and undefined on a bar it
 * has not served at all -- "no signal" and "not computed yet" are different answers, and only
 * the first may compare false. */
function signalValue(rows: PointRows | undefined): Value {
  if (!rows) return undefined
  for (const row of rows.rows) if (typeof row.signal === 'string' && row.signal) return row.signal
  return ''
}
