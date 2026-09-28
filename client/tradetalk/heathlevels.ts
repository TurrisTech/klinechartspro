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
// entirely.
//
// A candle only becomes a level once price TRADES AWAY from it, and he means the whole candle:
//
//   "price was bullish once it put in this candle and traded away from this area. That made it
//    a demand zone" (#73) ... "the selling resumed and took out both green candles' lows and
//    closed below them" (#73, mirrored for a 2024 weekly demand in the same video)
//
// So a supply is ESTABLISHED by a close below the run's lowest LOW, a demand by a close above
// its highest HIGH -- `departure` below, the run's furthest wick on the side price has to
// leave towards, with the stop beyond the other. Until then there is no zone: nothing is drawn
// and nothing can be traded from it. The chart read this loosely until 2026-09-28, arming on a
// close clear of the BODY, which counted zones he would not have drawn yet (user: implement
// his reading).
//
// A level is then ERASED two ways:
//
//   * a CLOSE THROUGH THE LINE he draws -- above a supply's open, below a demand's. A WICK
//     through it is not a break; that is the distinction the whole method turns on, and it is
//     the same rule as his support and resistance (§4.1, "only a body close counts"). This too
//     was loose until 2026-09-28: the chart erased on a body crossing the FAR edge, his zone
//     reading (#145), where on hourly charts drawn from the single line he scraps the level on
//     a close through the line itself (#93, #94).
//   * a candle passes entirely THROUGH the area -- its whole range, wicks included, covering
//     the band (user, 2026-09-21). A wick that reaches only part way in leaves the level live.
//
// Both are judged only once the level is established, which is what stops the move that CREATES
// a level from destroying it -- the area is the origin run's own bodies, so the bars around the
// turn are still standing in it. Before that only one thing ends it: a close beyond the STOP,
// price having gone the other way instead of leaving, so there is no zone to wait for.
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
//
// "ONE OR MORE candles" -- his own words (#73, the same video as the single-line quote): the
// pause before a turn "can be one or more green close candles", and the Bitcoin supply he works
// through there is two of them, "the november 9th and 10th candles", read as one zone. So the
// origin is a RUN of same-colour candles ending at that last one, and the zone is the union of
// their bodies, with the line at the earliest open and the stop beyond the run's furthest wick.
//
// WHAT DECIDES THE RUN'S LENGTH IS WIDTH (user, 2026-09-28): if the last candle is wide enough
// on its own, that is the zone; if it is small, the one before it joins, and so on until the
// zone is wide enough. His archive has NO size rule -- nowhere does he make a zone depend on
// how large a candle is (study §3.3) -- so this is the user's, like the body-extent rule.
//
// "Wide enough" is `minWidth` x ATR(14) at the run's last candle. ATR because a pip threshold
// would need a different number for every instrument and timeframe, and because it is the
// measure the rest of this chart already uses (levels2, brk01). Two limits stop it running
// away: the colour must hold (his rule), and `maxRun` caps the count -- a rally into a top can
// be eight up-close candles, and a zone the height of the whole rally is not a level.

/** How far back from a turn the origin candle may be. A turn whose last opposite-colour candle
 * is further away than this is not one candle's worth of supply or demand. */
export const LOOKBACK = 20

export interface HeathLevel {
  side: 'supply' | 'demand'
  /** First candle of the run the zone is made of -- the one whose OPEN is the line. */
  originIndex: number
  /** Last candle of the run: the last opposite-colour candle before the turn. */
  originEnd: number
  /** The swing the level was drawn from. */
  turnIndex: number
  /** When the swing became knowable -- `right` bars after the turn. */
  confirmIndex: number
  /** The line he draws: the earliest open of the run. */
  price: number
  /** The zone: the union of the run's bodies. */
  low: number
  high: number
  /** Where the stop goes: the run's furthest wick. Outside the zone, not an edge of it. */
  stop: number
  /** The run's furthest wick on the other side -- its lowest low for a supply, its highest high
   * for a demand. A CLOSE beyond it is what makes the candles a zone. */
  departure: number
  /** First bar that closed beyond `departure`, which is where the level starts existing. Null
   * while price has not traded away from it, and then there is no zone yet. */
  armedIndex: number | null
  /** First bar, after price left the area, whose range reached back into it. Null while fresh. */
  testedIndex: number | null
  /** First bar to erase the level. Null while it stands. */
  brokenIndex: number | null
  /** How it was erased: a `closed` through the line he draws, a candle passing entirely
   * `through` the area, or `failed` -- price closed beyond the stop before ever leaving, so
   * the candles never became a zone. Null while it stands. */
  brokenBy: 'through' | 'closed' | 'failed' | null
}

/** The shaded area: the bodies of the run, open to close. Always has height -- every candle in
 * the run is chosen for closing one way, so no body is empty. */
export function zoneOf(level: Pick<HeathLevel, 'low' | 'high'>): { low: number; high: number } {
  return { low: level.low, high: level.high }
}

export interface HeathLevelSettings {
  left: number
  right: number
  /** How wide a zone has to be before the candle before it stops joining, as a multiple of
   * ATR(14). 0 always takes the single last opposite-colour candle. */
  minWidth: number
  /** 0 both, 1 supply only, 2 demand only. */
  sides: 0 | 1 | 2
  /** Draw only levels price has not been back to. */
  freshOnly: boolean
  /** Draw the run's furthest wick, where the stop goes. */
  stopLine: boolean
  /** Most candles one zone may be made of. 1 is the single last opposite-colour candle. */
  maxRun: number
}

/** Which way a candle closed: 1 up, -1 down, 0 neither. */
function direction(bar: Candle): number {
  return bar.close > bar.open ? 1 : bar.close < bar.open ? -1 : 0
}

/** The last candle at or before `turn` that closed the other way, or -1. */
export function originOf(bars: readonly Candle[], turn: number, side: 'supply' | 'demand'): number {
  const wanted = side === 'supply' ? 1 : -1
  for (let i = turn; i >= 0 && i > turn - LOOKBACK; i--) {
    if (direction(bars[i]) === wanted) return i
  }
  return -1
}

/** ATR(14), causal: `atr[i]` reads no bar later than `i`, so a prefix gives the same values as
 * the whole series. Wilder's smoothing once there are `period` true ranges, and the running mean
 * of what exists before that, so the early bars answer something rather than nothing. */
export function atr(bars: readonly Candle[], period = 14): number[] {
  const out = new Array<number>(bars.length).fill(0)
  if (bars.length === 0) return out
  let sum = 0
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]
    const range =
      i === 0
        ? bar.high - bar.low
        : Math.max(bar.high - bar.low, Math.abs(bar.high - bars[i - 1].close), Math.abs(bar.low - bars[i - 1].close))
    if (i < period) {
      sum += range
      out[i] = sum / (i + 1)
    } else {
      out[i] = (out[i - 1] * (period - 1) + range) / period
    }
  }
  return out
}

/** The run of same-colour candles ending at `end`: "one or more green close candles", as many as
 * it takes for the zone to reach `minHeight` and no more. Bounded by the colour, by `maxRun` and
 * by the start of the series -- a zone still too small when one of those stops it is still a
 * zone. Returns the first index of the run. */
export function runStart(bars: readonly Candle[], end: number, maxRun: number, minHeight = 0): number {
  const wanted = direction(bars[end])
  let start = end
  let low = Math.min(bars[end].open, bars[end].close)
  let high = Math.max(bars[end].open, bars[end].close)
  while (
    high - low < minHeight &&
    start > 0 &&
    end - start + 1 < Math.max(1, maxRun) &&
    direction(bars[start - 1]) === wanted
  ) {
    start--
    low = Math.min(low, bars[start].open, bars[start].close)
    high = Math.max(high, bars[start].open, bars[start].close)
  }
  return start
}

/**
 * Every supply and demand line the method would have on this chart, in the order they formed.
 *
 * A level's life, after the origin run: it is **established** the first time a candle closes
 * beyond `departure` -- the run's furthest wick on the side price has to leave towards -- and
 * is not a zone at all before then; **tested** the first time a later bar's range reaches back
 * INTO it; and **erased** by a close through the line or by a candle covering the whole area.
 * The one thing that can end it before it is established is a close beyond the stop: price
 * went the other way instead of leaving, so the candles never became a zone.
 *
 * Nothing here reads a bar later than the one being judged.
 */
export function heathLevels(bars: readonly Candle[], settings: HeathLevelSettings): HeathLevel[] {
  const n = bars.length
  if (n === 0) return []
  const { left, right } = settings
  const tops = settings.sides === 2 ? null : swingMask(bars.map((bar) => bar.high), left, right)
  const bottoms = settings.sides === 1 ? null : swingMask(bars.map((bar) => -bar.low), left, right)
  const ranges = settings.minWidth > 0 ? atr(bars) : null

  const levels: HeathLevel[] = []
  for (let turn = 0; turn < n; turn++) {
    for (const side of ['supply', 'demand'] as const) {
      const mask = side === 'supply' ? tops : bottoms
      if (!mask?.[turn]) continue
      const originEnd = originOf(bars, turn, side)
      if (originEnd < 0) continue
      const originIndex = runStart(bars, originEnd, settings.maxRun, (ranges?.[originEnd] ?? 0) * settings.minWidth)
      const run = bars.slice(originIndex, originEnd + 1)
      const bodies = run.flatMap((bar) => [bar.open, bar.close])
      levels.push({
        side,
        originIndex,
        originEnd,
        turnIndex: turn,
        confirmIndex: turn + right,
        price: bars[originIndex].open,
        low: Math.min(...bodies),
        high: Math.max(...bodies),
        stop: side === 'supply' ? Math.max(...run.map((bar) => bar.high)) : Math.min(...run.map((bar) => bar.low)),
        departure: side === 'supply' ? Math.min(...run.map((bar) => bar.low)) : Math.max(...run.map((bar) => bar.high)),
        armedIndex: null,
        testedIndex: null,
        brokenIndex: null,
        brokenBy: null
      })
    }
  }

  for (const level of levels) {
    const zone = zoneOf(level)
    for (let i = level.originEnd + 1; i < n; i++) {
      const bar = bars[i]
      if (level.armedIndex === null) {
        // Price closed beyond where the stop goes: it went the other way instead of trading
        // away, and these candles are never going to be a zone.
        if (level.side === 'supply' ? bar.close > level.stop : bar.close < level.stop) {
          level.brokenIndex = i
          level.brokenBy = 'failed'
          break
        }
        // "took out both green candles' lows and closed below them" -- the whole run, wicks
        // included. That close is what makes it a level.
        if (level.side === 'supply' ? bar.close < level.departure : bar.close > level.departure) level.armedIndex = i
        continue
      }
      // Reached back into the area at all.
      if (level.testedIndex === null && bar.high >= zone.low && bar.low <= zone.high) level.testedIndex = i
      // A CLOSE through the line he draws. A wick through it is not a break.
      if (level.side === 'supply' ? bar.close > level.price : bar.close < level.price) {
        level.brokenIndex = i
        level.brokenBy = 'closed'
        break
      }
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

/** Whether a level is a zone at `index`: it exists once price has traded away from the run
 * that made it, and is gone once a close went back through the line. A level price never left
 * is not a level, so one that has not been established by `index` is not live there. */
export function isLive(level: HeathLevel, index: number): boolean {
  if (level.armedIndex === null || index < level.armedIndex) return false
  return level.brokenIndex === null || index < level.brokenIndex
}
