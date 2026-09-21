import { wallClock } from '../../src/indicators/sessions'
import {
  ema,
  findPeriod,
  levelsForDay,
  periodKey,
  periodMaps,
  sessionDay,
  UNIT_SPAN_MS,
  UNITS,
  unitRank,
  type Candle,
  type Level,
  type PeriodMap,
  type SessionBar,
  type SessionClock,
  type Unit
} from './calendar'

// Where TradeTalk would enter, as a rule.
//
// The method's own words, and what each becomes here (the dossier's sections are in
// README.md):
//
//   "Price runs BELOW a swing low or support, triggering sell stops. That candle CLOSES BACK
//    ABOVE the level. Enter when the HIGH OF THE STOP-RUN CANDLE is taken out. Stop below the
//    LOW of the stop-run candle -- if price goes back down to those lows then it is
//    continuation and not a stop run."                       -- setup 2, "his favourite"
//
//   "Wait for a pullback into a level IN THE DIRECTION OF TREND ... wait for price to show it
//    will trade away: wicks through the level, bodies closing on the right side. Enter when a
//    candle takes out the high of the last counter-trend candle."      -- setup 1, the CTM entry
//
// They are one mechanic -- a level pierced and reclaimed by one candle's body, entered on a
// stop order at that candle's extreme -- so this is one rule with the trend filter as a
// parameter rather than two implementations. Everything else in the method that can be
// stated as a number gates it: minimum 2:1 to the next opposing level, half size when
// another level sits between entry and stop, the daily 21 EMA bias switch, the yearly open
// as structural bias, and the hours he will open a position in.
//
// NO LOOKAHEAD, anywhere. A signal is decided at the close of the candle that made it, from
// levels knowable at the start of its session; the order fills on a LATER bar; the outcome
// is read forwards. Where a single bar could have filled and stopped in either order, the
// pessimistic reading is taken -- a stop.

const EMA_PERIOD = 21
const HOUR_MS = 3_600_000

/** The trader's own clock. Not the instrument's: "New York open is the money window" is a
 * statement about when HE trades, so it stays New York whatever the instrument's schedule. */
const TRADER_TZ = 'America/New_York'

export type BiasMode = 0 | 1 | 2
export type WindowMode = 0 | 1 | 2

export interface Settings {
  /** Minimum reward:risk, measured to the next opposing level. Below it, "there is no trade". */
  rr: number
  /** 0 none, 1 the daily 21 EMA, 2 the daily 21 EMA and the yearly open agreeing. */
  bias: BiasMode
  /** 0 any time, 1 London through the New York morning (03:00-11:00 New York, weekdays),
   * 2 the New York window only (07:00-11:00). Applied to the bar that FILLS the order, and
   * only on charts of an hour or less. */
  window: WindowMode
  /** How many bars the entry stop order stays working after the signal candle. */
  expiry: number
  /** The finest calendar unit the map draws levels from. */
  minUnit: Unit
}

export interface TradeTalkInput {
  bars: readonly Candle[]
  /** Completed trading sessions, ascending, one per day (calendar.ts). */
  sessions: readonly SessionBar[]
  clock: SessionClock
  /** The chart's own bar span, in ms. */
  barMs: number
  /** The instrument's price tick, for comparing levels that are the same price. */
  tick: number
  settings: Settings
}

export interface Target {
  price: number
  label: string
  /** False for the fallback target of a trade with no opposing level above (below) it --
   * at an all-time high he switches to Fibonacci extensions, which this does not draw. */
  isLevel: boolean
}

export interface Trade {
  side: 'long' | 'short'
  /** The candle that swept the level and closed back through it. */
  signalIndex: number
  /** The bar whose break of the signal candle's extreme filled the stop order. */
  entryIndex: number
  exitIndex: number | null
  /** The fill -- the signal candle's extreme, or the open of a bar that gapped past it. */
  entry: number
  /** The price the order was working at, and what the reward:risk was measured from. */
  planned: number
  stop: number
  target: Target
  /** Reward:risk as it stood when the order was placed. */
  rr: number
  level: Level
  /** Another objective level sits between entry and stop: "half size, because price usually
   * runs it first". */
  halfSize: boolean
  outcome: 'target' | 'stop' | 'open'
}

export interface BarValue {
  [key: string]: unknown
  /** The map in force on this bar, deduplicated by price. Shared by reference between bars
   * of the same session, which is what lets `draw` group them into runs. */
  levels?: readonly Level[]
  /** Set on every bar from the signal candle to the exit, so the legend and the drawing can
   * both reach the trade from wherever the crosshair is. */
  trade?: Trade
  entry?: number
  stop?: number
  target?: number
}

/** Why a sweep did not become a trade. An empty pane is a result, and this is what makes it
 * a legible one rather than a chart that looks broken. */
export interface Skips {
  /** The level was swept against the trend the bias filter reads. */
  bias: number
  /** The next opposing level was not far enough away for the minimum reward:risk. */
  rr: number
  /** The order would have filled outside the hours he opens positions in. */
  hours: number
  /** Price went back through the signal candle's other extreme first -- continuation. */
  invalidated: number
  /** The order was still working when it ran out of bars. */
  expired: number
}

export interface TradeTalkResult {
  values: BarValue[]
  trades: Trade[]
  /** The units the map could actually be drawn from on this chart. */
  units: Unit[]
  skips: Skips
}

export type SkipReason = keyof Skips

/** What a candle's sweep came to: an order to work, or the reason there is none. */
export interface SignalResult {
  order: Omit<Pending, 'signalIndex'> | null
  skip: 'bias' | 'rr' | null
}

const KIND_RANK: Record<Level['kind'], number> = { open: 3, high: 2, low: 2, mid: 1 }

/** Which of the levels a candle swept is the one the trade is named for: the coarsest unit,
 * then the more significant kind, then the one nearest the close. */
export function pickLevel(candidates: readonly Level[], close: number): Level | null {
  let best: Level | null = null
  for (const level of candidates) {
    if (best === null) {
      best = level
      continue
    }
    const byUnit = unitRank(level.unit) - unitRank(best.unit)
    const byKind = KIND_RANK[level.kind] - KIND_RANK[best.kind]
    const byDistance = Math.abs(best.price - close) - Math.abs(level.price - close)
    if (byUnit > 0 || (byUnit === 0 && (byKind > 0 || (byKind === 0 && byDistance > 0)))) best = level
  }
  return best
}

/** One price, one line: two units that agree on a price are one level, kept under the
 * coarser one's name. Two lines on one price would otherwise double-count "another level
 * between entry and stop" and draw the same line three times at a year boundary. */
export function dedupeLevels(levels: readonly Level[], tick: number): Level[] {
  const step = tick > 0 ? tick : 0
  const byPrice = new Map<number, Level>()
  for (const level of levels) {
    if (!Number.isFinite(level.price)) continue
    const key = step > 0 ? Math.round(level.price / step) : level.price
    const held = byPrice.get(key)
    if (
      held === undefined ||
      unitRank(level.unit) > unitRank(held.unit) ||
      (unitRank(level.unit) === unitRank(held.unit) && KIND_RANK[level.kind] > KIND_RANK[held.kind])
    ) {
      byPrice.set(key, level)
    }
  }
  return [...byPrice.values()].sort((a, b) => b.price - a.price)
}

/** Whether a position may be OPENED at this instant: "nothing after 11:00 a.m. ET", no
 * Asian session, no weekends. A chart coarser than an hour is a swing chart and is never
 * gated -- the window is about where in a session an intraday entry falls. */
export function inTradingWindow(ms: number, mode: WindowMode, barMs: number): boolean {
  if (mode === 0 || barMs > HOUR_MS) return true
  const clock = wallClock(TRADER_TZ, ms)
  if (clock.weekday === 0 || clock.weekday === 6) return false
  const from = mode === 2 ? 7 * 60 : 3 * 60
  return clock.minuteOfDay >= from && clock.minuteOfDay < 11 * 60
}

export interface Pending {
  side: 'long' | 'short'
  signalIndex: number
  planned: number
  stop: number
  target: Target
  rr: number
  level: Level
  halfSize: boolean
}

/** The units a map can be drawn from on this chart: never finer than the parameter asks
 * for, and never finer than the chart's own bar -- a daily chart has nothing to say about
 * levels inside a day. */
export function unitsFor(minUnit: Unit, barMs: number): Unit[] {
  return UNITS.filter((unit) => UNIT_SPAN_MS[unit] >= UNIT_SPAN_MS[minUnit] && barMs <= UNIT_SPAN_MS[unit])
}

/** The calendar level map over a run of bars: what every bar has in force. */
export interface LevelMap {
  /** One array per bar, SHARED by reference between bars with the same map (cached per
   * session and exclusion mask) -- which is what lets a drawer group bars into runs. */
  levels: Level[][]
  units: Unit[]
  maps: Map<Unit, PeriodMap>
  /** Each bar's session day. */
  days: number[]
}

/**
 * The objective calendar levels in force on every bar -- the map both TradeTalk indicators
 * draw. Null when there is nothing to draw it from: no bars, no sessions, or no calendar unit
 * at least as long as the chart's own bar.
 *
 * A period's open is not a line on the bar that opened it: on a 1h chart the 17:00 candle IS
 * the daily open, and every bullish candle with a lower wick would "sweep and reclaim" it.
 * So each bar's map drops the opens of any period it is the first bar of.
 */
export function levelMap(
  bars: readonly Candle[],
  sessions: readonly SessionBar[],
  clock: SessionClock,
  barMs: number,
  tick: number,
  minUnit: Unit
): LevelMap | null {
  const units = unitsFor(minUnit, barMs)
  if (bars.length === 0 || sessions.length === 0 || units.length === 0) return null
  const maps = periodMaps(sessions, units)
  const days = bars.map((bar) => sessionDay(bar.timestamp, clock))
  const cache = new Map<string, Level[]>()
  const levels = bars.map((_, i) => {
    const day = days[i]
    let mask = 0
    units.forEach((unit, bit) => {
      const spans = barMs < UNIT_SPAN_MS[unit]
      const opensHere = i === 0 || periodKey(days[i - 1], unit) !== periodKey(day, unit)
      if (!spans || opensHere) mask |= 1 << bit
    })
    const key = `${day}|${mask}`
    const held = cache.get(key)
    if (held) return held
    const all = levelsForDay(day, maps, units).filter((level) => {
      if (!level.current) return true
      return (mask & (1 << units.indexOf(level.unit))) === 0
    })
    const deduped = dedupeLevels(all, tick)
    cache.set(key, deduped)
    return deduped
  })
  return { levels, units, maps, days }
}

export function computeTradeTalk(input: TradeTalkInput): TradeTalkResult {
  const { bars, sessions, clock, barMs, tick, settings } = input
  const values: BarValue[] = bars.map(() => ({}))
  const trades: Trade[] = []
  const skips: Skips = { bias: 0, rr: 0, hours: 0, invalidated: 0, expired: 0 }
  const map = levelMap(bars, sessions, clock, barMs, tick, settings.minUnit)
  if (map === null) return { values, trades, units: unitsFor(settings.minUnit, barMs), skips }

  const { maps, days, units } = map
  const yearly = maps.get('Y')
  const emaValues = ema(
    sessions.map((session) => session.close),
    EMA_PERIOD
  )
  const half = tick > 0 ? tick / 2 : 0

  // The last session that had CLOSED before a bar's own session -- what the bias is read
  // off. Walks forward with the bars; both are ascending.
  let priorSession = -1
  const biasOf = (day: number): 'up' | 'down' | null => {
    while (priorSession + 1 < sessions.length && sessions[priorSession + 1].day < day) priorSession++
    if (priorSession < 0) return null
    const average = emaValues[priorSession]
    if (average === undefined) return null
    const close = sessions[priorSession].close
    if (close > average) return 'up'
    if (close < average) return 'down'
    return null
  }

  const yearOpen = (day: number): number | null => {
    if (!yearly) return null
    const key = periodKey(day, 'Y')
    const at = findPeriod(yearly, key)
    return at < 0 || yearly.periods[at].key !== key ? null : yearly.periods[at].open
  }

  let pending: Pending | null = null
  let open: Trade | null = null
  let currentDay: number | null = null
  let dayHigh = Number.NEGATIVE_INFINITY
  let dayLow = Number.POSITIVE_INFINITY

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i]
    const day = days[i]
    if (day !== currentDay) {
      currentDay = day
      dayHigh = Number.NEGATIVE_INFINITY
      dayLow = Number.POSITIVE_INFINITY
    }
    dayHigh = Math.max(dayHigh, bar.high)
    dayLow = Math.min(dayLow, bar.low)

    const levels = map.levels[i]
    values[i].levels = levels

    // 1. An open position: does this bar end it? A bar that reaches both is read as the
    // stop -- within one bar the order of the two ticks is not knowable, and the honest
    // reading of an unknown is the bad one.
    if (open !== null) {
      const hitStop = open.side === 'long' ? bar.low <= open.stop : bar.high >= open.stop
      const hitTarget = open.side === 'long' ? bar.high >= open.target.price : bar.low <= open.target.price
      if (hitStop || hitTarget) {
        open.exitIndex = i
        open.outcome = hitStop ? 'stop' : 'target'
        open = null
      }
    }

    // 2. A working order: filled, cancelled, or still waiting.
    if (open === null && pending !== null) {
      const expired = i - pending.signalIndex > settings.expiry
      const breached = pending.side === 'long' ? bar.low < pending.stop : bar.high > pending.stop
      // "Takes out" is a strict break of the signal candle's extreme, the same test the
      // method's own trending candle is defined by.
      const triggered = pending.side === 'long' ? bar.high > pending.planned : bar.low < pending.planned
      if (expired) {
        skips.expired++
        pending = null
      } else if (triggered && !inTradingWindow(bar.timestamp, settings.window, barMs)) {
        // He would not be at the desk. The order comes off rather than filling.
        skips.hours++
        pending = null
      } else if (triggered) {
        const entry = pending.side === 'long' ? Math.max(pending.planned, bar.open) : Math.min(pending.planned, bar.open)
        const trade: Trade = {
          side: pending.side,
          signalIndex: pending.signalIndex,
          entryIndex: i,
          exitIndex: null,
          entry,
          planned: pending.planned,
          stop: pending.stop,
          target: pending.target,
          rr: pending.rr,
          level: pending.level,
          halfSize: pending.halfSize,
          outcome: 'open'
        }
        trades.push(trade)
        pending = null
        // The entry bar can also finish the trade.
        const hitStop = trade.side === 'long' ? bar.low <= trade.stop : bar.high >= trade.stop
        const hitTarget = trade.side === 'long' ? bar.high >= trade.target.price : bar.low <= trade.target.price
        if (hitStop || hitTarget) {
          trade.exitIndex = i
          trade.outcome = hitStop ? 'stop' : 'target'
        } else {
          open = trade
        }
      } else if (breached) {
        // "If price goes back down to those lows then it is continuation and not a stop run."
        skips.invalidated++
        pending = null
      }
    }

    // 3. A new signal. Never while a position is open: "one trade a day is enough", and a
    // second entry would need a second risk budget the method does not describe.
    if (open === null) {
      const { order, skip } = signalAt(bar, levels, {
        tick,
        half,
        settings,
        bias: biasOf(day),
        yearOpen: yearOpen(day),
        dayHigh,
        dayLow,
        intraday: barMs < UNIT_SPAN_MS.D
      })
      if (order !== null) pending = { ...order, signalIndex: i }
      else if (skip !== null) skips[skip]++
    }
  }

  for (const trade of trades) {
    const last = trade.exitIndex ?? values.length - 1
    for (let i = trade.signalIndex; i <= last; i++) {
      values[i].trade = trade
      if (i >= trade.entryIndex) {
        values[i].entry = trade.entry
        values[i].stop = trade.stop
        values[i].target = trade.target.price
      }
    }
  }

  return { values, trades, units, skips }
}

interface SignalContext {
  tick: number
  half: number
  settings: Settings
  bias: 'up' | 'down' | null
  yearOpen: number | null
  dayHigh: number
  dayLow: number
  intraday: boolean
}

/** The order this candle would leave working, or null. Everything it reads is knowable at
 * the candle's close. */
export function signalAt(bar: Candle, levels: readonly Level[], ctx: SignalContext): SignalResult {
  const longs: Level[] = []
  const shorts: Level[] = []
  for (const level of levels) {
    if (bar.open > level.price && bar.low < level.price && bar.close > level.price) longs.push(level)
    if (bar.open < level.price && bar.high > level.price && bar.close < level.price) shorts.push(level)
  }
  // An outside candle that swept levels on both sides and closed through both says nothing
  // about which side was the stop run.
  if (longs.length > 0 && shorts.length > 0) return { order: null, skip: null }
  const side: 'long' | 'short' | null = longs.length > 0 ? 'long' : shorts.length > 0 ? 'short' : null
  if (side === null) return { order: null, skip: null }

  const level = pickLevel(side === 'long' ? longs : shorts, bar.close)
  if (level === null) return { order: null, skip: null }

  const { settings, bias, tick, half } = ctx
  if (settings.bias >= 1 && bias !== null && bias !== (side === 'long' ? 'up' : 'down')) return { order: null, skip: 'bias' }
  if (settings.bias >= 2 && ctx.yearOpen !== null) {
    if (side === 'long' && bar.close <= ctx.yearOpen) return { order: null, skip: 'bias' }
    if (side === 'short' && bar.close >= ctx.yearOpen) return { order: null, skip: 'bias' }
  }

  const planned = side === 'long' ? bar.high : bar.low
  const stop = side === 'long' ? bar.low : bar.high
  const risk = Math.abs(planned - stop)
  // A candle with no range at all is not a trade, and it is not a rejected setup either.
  if (!(risk > 0) || risk < tick) return { order: null, skip: null }

  const target = nextTarget(side, planned, risk, levels, ctx)
  const rr = Math.abs(target.price - planned) / risk
  if (rr + 1e-9 < settings.rr) return { order: null, skip: 'rr' }

  const halfSize = levels.some(
    (other) =>
      Math.abs(other.price - level.price) > half &&
      other.price > Math.min(stop, planned) + half &&
      other.price < Math.max(stop, planned) - half
  )

  return { order: { side, planned, stop, target, rr, level, halfSize }, skip: null }
}

/** Where the trade is going: "the next opposing level", or the high (low) of the day when
 * that is nearer -- "day trades target the high of the day unless a structural level is
 * closer". With nothing above (below) at all, the minimum acceptable reward stands in, and
 * says so: at an all-time high he switches to Fibonacci extensions, which this does not draw. */
export function nextTarget(
  side: 'long' | 'short',
  entry: number,
  risk: number,
  levels: readonly Level[],
  ctx: SignalContext
): Target {
  const { half, intraday, settings } = ctx
  let best: Target | null = null
  const consider = (price: number, label: string): void => {
    if (!Number.isFinite(price)) return
    if (side === 'long' ? price <= entry + half : price >= entry - half) return
    if (best === null || (side === 'long' ? price < best.price : price > best.price)) best = { price, label, isLevel: true }
  }
  for (const level of levels) consider(level.price, level.label)
  if (intraday) consider(side === 'long' ? ctx.dayHigh : ctx.dayLow, side === 'long' ? 'day high' : 'day low')
  if (best !== null) return best
  const reach = settings.rr * risk
  return { price: side === 'long' ? entry + reach : entry - reach, label: 'no level', isLevel: false }
}
