import { parseSignalRef } from '../plugins/api'
import type { MtfInterval } from './api'

// WHAT THE OVERLAY IS CURRENTLY DRAWING, so something outside the chart can ask.
//
// It exists for the bar replay's "next signal" (user, 2026-09-21: "the next signal would be a
// visible signal only"). The replay's stops come from the server's signal wire, which knows
// nothing about this pane's settings -- which timeframes are switched on, and whether the
// graph filter is hiding the signals outside it -- so a stop could land on a signal the chart
// does not draw, leaving the user staring at a bar with nothing on it.
//
// The answer has to be what is ON SCREEN rather than a second derivation of it, or the two
// drift. So the template publishes, on every `calc`, exactly what it placed: the signals it
// drew, and the ones it knows about but did not draw. `drawsSignal` reads that back.
//
// A binding publishes under its own indicator id and clears on teardown, so a pane that is
// closed or rebound stops answering for signals it no longer draws.

/** One pane's drawn state, as its template last computed it. */
export interface DrawnSignals {
  /** `vendor:ticker` of the pane the overlay is on. */
  symbol: string
  /** The plugin and variant whose signals this overlay draws -- what an armed ref must name. */
  plugin: string
  variant: string
  /** The timeframes the pane draws at all (switched on and not finer than the chart). */
  intervals: readonly MtfInterval[]
  /** `interval|sourceDate` for every signal DRAWN. */
  drawn: ReadonlySet<string>
  /** `interval|sourceDate` for every signal placed before the graph filter -- so a signal
   * known and not drawn is one the filter hid, which is different from one never loaded. */
  known: ReadonlySet<string>
  /** The end of the pane's last loaded bar, absolute. A pane cannot speak for a signal it has
   * not reached, and this is also what retires a pane that stopped being drawn: the replay
   * only ever asks about instants at or after its cursor, which a stale entry never covers. */
  coversTo: number
}

export function signalKey(interval: string, sourceDate: number): string {
  return `${interval}|${sourceDate}`
}

const panes = new Map<string, DrawnSignals>()

/** Publish (or with `null`, drop) one pane's drawn state. Keyed by the indicator instance. */
export function publishDrawn(indicatorKey: string, state: DrawnSignals | null): void {
  if (state) panes.set(indicatorKey, state)
  else panes.delete(indicatorKey)
}

/**
 * Whether the wall currently DRAWS the signal an armed ref names on `resolution`, at the bar
 * `date`: `true` if some pane draws it, `false` if every pane that could says it does not,
 * and **null when no pane can say** -- no overlay is up, none is on that instrument, the ref
 * belongs to another plugin, or the pane has not loaded that far back.
 *
 * Null is not "invisible": a caller that skips what is not drawn must treat null as drawn, or
 * an answer that is merely unknown would silently skip a stop the user armed.
 */
export function drawsSignal(
  symbol: string,
  ref: string,
  resolution: string,
  date: number,
  effective: number
): boolean | null {
  const { plugin, variant } = parseSignalRef(ref)
  const key = signalKey(resolution, date)
  let verdict: boolean | null = null
  for (const pane of panes.values()) {
    // The replay names its instrument as the engine does (`vendor:TICKER`) and a pane as the
    // chart does; they are the same pair, so they are compared without regard to case.
    if (pane.symbol.toLowerCase() !== symbol.toLowerCase()) continue
    if (pane.plugin !== plugin || pane.variant !== variant) continue
    if (pane.coversTo < effective) continue
    if (pane.drawn.has(key)) return true
    // A timeframe the pane does not draw at all, or a signal it placed and the graph filter
    // hid: this pane says no. Anything else it simply has not got, which is not an answer.
    if (!pane.intervals.includes(resolution as MtfInterval) || pane.known.has(key)) verdict = false
  }
  return verdict
}

/** Test seam: forget every published pane. */
export function resetDrawn(): void {
  panes.clear()
}
