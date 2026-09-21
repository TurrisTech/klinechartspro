import { swingMask } from '../../src/indicators/swing'
import type { Candle } from './calendar'

// "Heath levels" -- supply and demand as the TradeTalk method draws them (dossier §3).
//
//   "I only draw my supply and demand zones with a SINGLE LINE AT THE OPEN ... because I like
//    to keep my charts neat. Also this gives me pinpoint accuracy when taking my entries,
//    giving me the ability to have the smallest stop loss distance to increase position size."
//
//   Supply (above price): the OPEN of the last UP-CLOSE candle before a sell-off.
//   Demand (below price): the OPEN of the last DOWN-CLOSE candle before a rally.
//   The stop goes above the wick HIGH (supply) or below the wick LOW (demand) of that same
//   candle. A fresh, untested level is worth far more than one price has already visited.
//
// The area is the origin candle's BODY -- open to close, not open to wick (user, 2026-09-21).
// The line he draws is its open edge; the stop still sits beyond the wick, outside the area
// entirely. A level is ERASED two ways, both the user's (2026-09-21):
//
//   * a candle passes entirely THROUGH the area -- its whole range, wicks included, covering
//     the band. A wick that reaches only part way in leaves the level live.
//   * a later candle's BODY CROSSES its far edge -- the top of a supply, the bottom of a
//     demand (user, 2026-09-21). A WICK across that edge does not count: that is the
//     distinction the rule turns on. The crossing is judged once the level has established
//     itself -- price having closed clear of the area -- because otherwise the move that
//     CREATES the level destroys it: measured on 20 days of dev EURUSD 1h, an ungated
//     crossing rule killed 17 of 30 levels within two bars of their own candle, a median life
//     of 2 bars against 16. A close past the far edge before the level ever established
//     itself says the same thing as a crossing and ends it there and then, so a level price
//     never left cannot outlive being traded through.
//
// Two things in that definition have to be made mechanical, and both are parameters rather
// than opinions buried in code:
//
// "before a turn" -- the turn is a swing top or bottom, found with the same rule the chart's
// own Tops and Bottoms indicator uses (`swingMask`): a high clearing the `left` highs before
// it and the `right` after it. So a level is only knowable `right` bars after the candle that
// made it, which the drawing says out loud rather than hiding.
//
// "the last opposite-colour candle" -- searched backwards from the turn, the turn's own candle
// included (a rally's final candle is usually the up-close one), and bounded: if nothing of
// that colour is within `LOOKBACK` bars there is no level rather than an arbitrary one.

/** How far back from a turn the origin candle may be. A turn whose last opposite-colour candle
 * is further away than this is not one candle's worth of supply or demand. */
export const LOOKBACK = 20

export interface HeathLevel {
  side: 'supply' | 'demand'
  /** The candle whose OPEN is the level. */
  originIndex: number
  /** The swing the level was drawn from. */
  turnIndex: number
  /** When the swing became knowable -- `right` bars after the turn. */
  confirmIndex: number
  /** The line: that candle's open, and one edge of the body. */
  price: number
  /** The body's other edge: that candle's close. */
  close: number
  /** Where the stop goes: that candle's wick extreme. Outside the area, not an edge of it. */
  stop: number
  /** First bar, after price left the area, whose range reached back into it. Null while fresh. */
  testedIndex: number | null
  /** First bar to erase the level. Null while it stands. */
  brokenIndex: number | null
  /** How it was erased: a candle passing entirely `through` the area, or a body `crossing`
   * its far edge. Null while it stands. */
  brokenBy: 'through' | 'crossed' | null
}

/** The shaded area: the origin candle's BODY, open to close. Always has height -- the origin
 * is chosen for closing the other way, so its open and close are never equal. */
export function zoneOf(level: Pick<HeathLevel, 'price' | 'close'>): { low: number; high: number } {
  return { low: Math.min(level.price, level.close), high: Math.max(level.price, level.close) }
}

export interface HeathLevelSettings {
  left: number
  right: number
  /** 0 both, 1 supply only, 2 demand only. */
  sides: 0 | 1 | 2
  /** Draw only levels price has not been back to. */
  freshOnly: boolean
  /** Draw the origin candle's wick extreme, where the stop goes. */
  stopLine: boolean
}

/** The last candle at or before `turn` that closed the other way, or -1. */
export function originOf(bars: readonly Candle[], turn: number, side: 'supply' | 'demand'): number {
  const wanted = side === 'supply' ? 1 : -1
  for (let i = turn; i >= 0 && i > turn - LOOKBACK; i--) {
    const direction = bars[i].close > bars[i].open ? 1 : bars[i].close < bars[i].open ? -1 : 0
    if (direction === wanted) return i
  }
  return -1
}

/**
 * Every supply and demand line the method would have on this chart, in the order they formed.
 *
 * A level's life, after the origin candle: it is **armed** once price has closed clear of the
 * area, **tested** the first time a later bar's range reaches back INTO it, and **erased**
 * either by a candle passing entirely through it or by a body crossing its far edge. Arming
 * is what stops the move that created the level from counting against it -- the area is the
 * origin candle's own body, so the bars around the turn are still standing in it: a return
 * would read as a test, and a body poking over the edge on the way out would read as a
 * crossing. Before a level is armed only a CLOSE past its far edge ends it, which is the same
 * statement the crossing rule makes and leaves no way for a level to outlive being traded
 * through.
 *
 * Nothing here reads a bar later than the one being judged.
 */
export function heathLevels(bars: readonly Candle[], settings: HeathLevelSettings): HeathLevel[] {
  const n = bars.length
  if (n === 0) return []
  const { left, right } = settings
  const tops = settings.sides === 2 ? null : swingMask(bars.map((bar) => bar.high), left, right)
  const bottoms = settings.sides === 1 ? null : swingMask(bars.map((bar) => -bar.low), left, right)

  const levels: HeathLevel[] = []
  for (let turn = 0; turn < n; turn++) {
    for (const side of ['supply', 'demand'] as const) {
      const mask = side === 'supply' ? tops : bottoms
      if (!mask?.[turn]) continue
      const originIndex = originOf(bars, turn, side)
      if (originIndex < 0) continue
      const origin = bars[originIndex]
      levels.push({
        side,
        originIndex,
        turnIndex: turn,
        confirmIndex: turn + right,
        price: origin.open,
        close: origin.close,
        stop: side === 'supply' ? origin.high : origin.low,
        testedIndex: null,
        brokenIndex: null,
        brokenBy: null
      })
    }
  }

  for (const level of levels) {
    const zone = zoneOf(level)
    let armed = false
    for (let i = level.originIndex + 1; i < n; i++) {
      const bar = bars[i]
      const bodyLow = Math.min(bar.open, bar.close)
      const bodyHigh = Math.max(bar.open, bar.close)
      if (!armed) {
        // Not established yet: only a CLOSE past the far edge ends it here, so the move that
        // created the level cannot destroy it on its way out.
        if (level.side === 'supply' ? bar.close > zone.high : bar.close < zone.low) {
          level.brokenIndex = i
          level.brokenBy = 'crossed'
          break
        }
        armed = level.side === 'supply' ? bar.close < zone.low : bar.close > zone.high
        continue
      }
      // A body across the far edge -- the top of a supply, the bottom of a demand. Bodies
      // only: a wick across that edge is exactly what this rule does not count.
      if (level.side === 'supply' ? bodyHigh > zone.high : bodyLow < zone.low) {
        if (level.testedIndex === null && bar.high >= zone.low && bar.low <= zone.high) level.testedIndex = i
        level.brokenIndex = i
        level.brokenBy = 'crossed'
        break
      }
      // Reached back into the area at all.
      if (level.testedIndex === null && bar.high >= zone.low && bar.low <= zone.high) level.testedIndex = i
      // Passed entirely through it: the whole area is inside this candle's range, wicks and
      // all. A wick that covers only part of the area leaves the level live.
      if (bar.low <= zone.low && bar.high >= zone.high) {
        level.brokenIndex = i
        level.brokenBy = 'through'
        break
      }
    }
  }

  return settings.freshOnly ? levels.filter((level) => level.testedIndex === null) : levels
}

/** Whether a level is still on the chart at `index`: drawn from its origin candle, and gone
 * once something closed through the stop. */
export function isLive(level: HeathLevel, index: number): boolean {
  return index >= level.originIndex && (level.brokenIndex === null || index < level.brokenIndex)
}
