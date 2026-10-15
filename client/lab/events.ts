// THE SIGNAL POOL, AS SIGNALS: every source of a strategy (model.ts `SignalSource`) turned into
// the `LabSignal`s a graph is built from -- or, with the graph off, the events entries are
// chosen among.
//
//   published  the server's labelled points (`GET /plugins/{id}/signals`), each placed on the
//              candle it was cast on and knowable at that candle's CLOSE
//   rule       a rule over indicators (and anything else an alert can read), evaluated by the
//              alert manager's own machinery -- `buildTrack`, `instants`, `stepInstant` -- at the
//              event timeframe's closes, firing where it STARTS to hold
//
// A signal's price is read off its candle (`anchorPrice`): the body's top or bottom by default,
// which is what the overlay prices a graph node at (client/mtf/graph.ts).
//
// Knowable at the close -- `get_interval_end`, the effective-timestamp rule -- where the overlay
// uses the next bar's open. The two order every pair of signals the same way (they differ only
// across a market-closed gap, where no bar of any timeframe closes), which is all a graph
// compares; the close is also the instant an entry can actually be taken.
//
// PURE but for klinecharts' indicator templates, which `buildTrack` runs.

import { buildTrack, type PointIndex } from '../alerts/compute'
import { compile } from '../alerts/rules'
import { freshRun, instants, stepInstant } from '../alerts/timeline'
import type { Operand } from '../alerts/types'
import { resolutionDurationMs } from '../periods'
import type { ReplayBar } from '../replay/cache'
import type { LabSignal } from './graph'
import { type PriceAnchor, type PublishedSource, type RuleSource, type Side, withInterval } from './model'

/** A labelled point as the server sends it: its bar's wire date, its label, and its fields. */
export type SignalPoint = { date: number; signal?: unknown } & Record<string, unknown>

/** Where a signal of `side` sits on its candle. */
export function anchorPrice(anchor: PriceAnchor, side: Side, bar: { o: number; h: number; l: number; c: number }): number {
  if (anchor === 'close') return bar.c
  if (anchor === 'wick') return side === 'top' ? bar.h : bar.l
  return side === 'top' ? Math.max(bar.o, bar.c) : Math.min(bar.o, bar.c)
}

function signalOf(source: { id: string; price: PriceAnchor }, interval: string, bar: ReplayBar, side: Side, label: string, raw: Record<string, unknown>): LabSignal {
  const ohlc = { o: bar.o, h: bar.h, l: bar.l, c: bar.c }
  return {
    key: `${source.id}|${interval}|${bar.date}`,
    source: source.id,
    interval,
    durationMs: resolutionDurationMs(interval),
    knownAt: bar.end,
    sourceDate: bar.date,
    side,
    price: anchorPrice(source.price, side, ohlc),
    bar: ohlc,
    label,
    raw
  }
}

/** A published source's signals on one timeframe. `bars` are that timeframe's, keyed by the wire
 * date the points carry; a point whose candle is not held is left out rather than guessed, as the
 * overlay does (`storeGraphSignals`). */
export function publishedSignals(source: PublishedSource, interval: string, points: readonly SignalPoint[], bars: readonly ReplayBar[]): LabSignal[] {
  const byDate = new Map(bars.map((bar) => [bar.date, bar]))
  const out: LabSignal[] = []
  for (const point of points) {
    const label = typeof point.signal === 'string' ? point.signal : ''
    const side = source.sides[label]
    if (!side) continue
    const bar = byDate.get(point.date)
    if (!bar) continue
    const { date: _date, signal: _signal, effective: _effective, ...raw } = point
    out.push(signalOf(source, interval, bar, side, label, raw))
  }
  return out
}

export interface RuleEventInput {
  source: RuleSource
  interval: string
  /** Bars of every timeframe the rules read, store clock, ascending, with their lead-in. */
  bars: (interval: string) => readonly ReplayBar[]
  /** A server operand's points (a stored series or a signal the rule reads). */
  points: (operand: Operand) => PointIndex | undefined
  /** Events before this instant are evaluated -- an edge needs the bar before -- but not kept. */
  from: number
}

const EDGE = { trigger: 'edge' as const, repeat: 'always' as const, cooldownMs: 0 }

/** A rule source's events on one timeframe: each close of that timeframe where its top (bottom)
 * rule starts to hold. Only the timeframe's own closes are instants, so a rule that also reads a
 * coarser timeframe fires on the event timeframe's grid, and a crossing compares one of its closes
 * with the one before. */
export async function ruleSignals(input: RuleEventInput): Promise<LabSignal[]> {
  const { source, interval } = input
  const own = input.bars(interval)
  const byEnd = new Map(own.map((bar) => [bar.end, bar]))
  const out: LabSignal[] = []
  for (const side of ['top', 'bottom'] as const) {
    const rule = source[side]
    if (!rule) continue
    const compiled = compile(withInterval(rule, interval))
    const operands = [...compiled.operands.values()]
    const intervals = [...new Set([interval, ...operands.map((o) => o.interval)])]
    const tracks = await Promise.all(intervals.map((iv) => buildTrack(iv, input.bars(iv), operands, input.points)))
    const timeline = instants(tracks, compiled.fields).filter((instant) => byEnd.has(instant.at))
    const state = freshRun()
    for (const instant of timeline) {
      if (!stepInstant(compiled.condition, EDGE, state, instant) || instant.at < input.from) continue
      const bar = byEnd.get(instant.at) as ReplayBar
      out.push(signalOf(source, interval, bar, side, side, {}))
    }
  }
  return out.sort((a, b) => a.knownAt - b.knownAt)
}

/** The server operands (stored series, signals) a rule source reads on `interval`. */
export function ruleOperands(source: RuleSource, interval: string): Operand[] {
  const out: Operand[] = []
  for (const rule of [source.top, source.bottom]) if (rule) out.push(...compile(withInterval(rule, interval)).operands.values())
  return out
}
