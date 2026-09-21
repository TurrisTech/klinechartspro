import { swingMask } from '../../src/indicators/swing'
import type { Candle } from './calendar'

// "Heath levels" -- supply and demand as the TradeTalk method draws them (dossier §3.2).
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
  /** The line: that candle's open. */
  price: number
  /** Where the stop goes: that candle's wick extreme. */
  stop: number
  /** First bar, after price left the level, whose range reached back to it. Null while fresh. */
  testedIndex: number | null
  /** First bar to CLOSE beyond the stop -- the level is finished. Null while it stands. */
  brokenIndex: number | null
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
 * A level's life, after the origin candle: it is **armed** once price has left it (a close on
 * the far side), **tested** the first time a later bar's range reaches back to it, and
 * **broken** the first time a candle closes beyond the stop -- beyond the origin candle's own
 * wick, which is exactly where the method puts the stop, so a level dies where the trade would
 * have. Arming is what stops the sell-off that created a supply from instantly "testing" it:
 * the line is the origin candle's open, so the bars around the turn are still standing on it.
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
        stop: side === 'supply' ? origin.high : origin.low,
        testedIndex: null,
        brokenIndex: null
      })
    }
  }

  for (const level of levels) {
    let armed = false
    for (let i = level.originIndex + 1; i < n; i++) {
      const bar = bars[i]
      if (!armed) {
        armed = level.side === 'supply' ? bar.close < level.price : bar.close > level.price
        continue
      }
      if (level.testedIndex === null && (level.side === 'supply' ? bar.high >= level.price : bar.low <= level.price)) {
        level.testedIndex = i
      }
      if (level.side === 'supply' ? bar.close > level.stop : bar.close < level.stop) {
        level.brokenIndex = i
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
