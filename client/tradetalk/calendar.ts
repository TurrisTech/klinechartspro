import { zoneOffsetMinutes } from '../../src/indicators/sessions'

// The map TradeTalk trades from: the objective calendar levels.
//
// "For each of yearly, quarterly, monthly, weekly, daily he marks five data points: open,
// high, low, close and midpoint" -- the framework the method settled on by 2025. What this
// module builds is that map, from DAILY bars, because a daily bar is the unit every coarser
// candle is made of and the server dates one by its session (CLAUDE.md, "Candle boundary
// rules"): a month is the sessions whose date falls in it, and a month's open is the open of
// its first session, whatever wall-clock instant that candle actually opened at.
//
// Nothing here guesses a boundary. A session's date comes from the instrument's own schedule
// (`SessionClock`, read off SymbolInfo.timezone + dayGeometry, which the server resolves from
// Postgres), and the daily bars themselves are the server's -- so the forex week that opens
// Sunday 17:00 New York, crypto's UTC midnight and an equity session are all one code path.

const DAY_MS = 86_400_000
const MINUTE_MS = 60_000

/** The clock a bar's session date is read on: the instrument's zone, the hours from the
 * midnight that dates a session to that session's open (`DayGeometry.openOffset` -- -7 for
 * the forex week, 0 for crypto, +9 for US equities), and whether the bars being mapped are
 * dated by their open (intraday) or by their session date already (daily and coarser, which
 * the wire dates canonically). */
export interface SessionClock {
  timezone: string
  openOffset: number
  sessionDated: boolean
}

/** Days since 1970-01-01 of the session a bar belongs to. A bar before its day's open --
 * the Sunday-evening forex bars, an equity pre-market bar -- belongs to the session its
 * open offset names, which is the rule `SESSIONS`' week line already uses. */
export function sessionDay(ms: number, clock: SessionClock): number {
  const local = ms + zoneOffsetMinutes(clock.timezone, ms) * MINUTE_MS
  const shifted = clock.sessionDated ? local : local - clock.openOffset * 60 * MINUTE_MS
  return Math.floor(shifted / DAY_MS)
}

/** A bar, of whatever timeframe: the four numbers and the instant they are dated on. */
export interface Candle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
}

/** One trading session: a daily candle, dated by its session rather than by its open. */
export interface SessionBar {
  day: number
  open: number
  high: number
  low: number
  close: number
}

export type Unit = 'Y' | 'Q' | 'M' | 'W' | 'D'

/** Coarsest first -- the order a level's significance is ranked in, and the order the
 * picker's "smallest unit" parameter cuts from the bottom. */
export const UNITS: readonly Unit[] = ['Y', 'Q', 'M', 'W', 'D']

/** Nominal length of a unit, for comparing against the chart's own bar span. Deliberately
 * the SHORT end of each (a month is 28 days, a year 365) so a chart bar that could span the
 * unit is treated as spanning it. */
export const UNIT_SPAN_MS: Record<Unit, number> = {
  Y: 365 * DAY_MS,
  Q: 90 * DAY_MS,
  M: 28 * DAY_MS,
  W: 7 * DAY_MS,
  D: DAY_MS
}

export function unitRank(unit: Unit): number {
  return UNITS.length - UNITS.indexOf(unit)
}

interface Civil {
  year: number
  /** 0-11. */
  month: number
}

function civil(day: number): Civil {
  const date = new Date(day * DAY_MS)
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() }
}

/** The period of `unit` a session date falls in, as a number that increases with time and
 * is equal exactly for two dates in the same period. Weeks are Monday-based (1970-01-01 was
 * a Thursday, so `day + 3` counts from the Monday before it), which is the week every
 * schedule here opens: forex Sunday 17:00 New York dates to Monday, crypto Monday 00:00 UTC,
 * equities Monday. */
export function periodKey(day: number, unit: Unit): number {
  if (unit === 'D') return day
  if (unit === 'W') return Math.floor((day + 3) / 7)
  const { year, month } = civil(day)
  if (unit === 'M') return year * 12 + month
  if (unit === 'Q') return year * 4 + Math.floor(month / 3)
  return year
}

/** One completed or forming calendar candle, folded from the sessions it holds. */
export interface PeriodBar {
  key: number
  /** Session date of its first session -- what names it. */
  firstDay: number
  open: number
  high: number
  low: number
  close: number
}

/** The sessions folded into `unit` candles, ascending. `sessions` must be ascending by day
 * and hold each day once. */
export function groupPeriods(sessions: readonly SessionBar[], unit: Unit): PeriodBar[] {
  const periods: PeriodBar[] = []
  let current: PeriodBar | null = null
  for (const session of sessions) {
    const key = periodKey(session.day, unit)
    if (current === null || current.key !== key) {
      current = { key, firstDay: session.day, open: session.open, high: session.high, low: session.low, close: session.close }
      periods.push(current)
      continue
    }
    current.high = Math.max(current.high, session.high)
    current.low = Math.min(current.low, session.low)
    current.close = session.close
  }
  return periods
}

export type LevelKind = 'open' | 'high' | 'low' | 'mid'

/** One horizontal line on the map: a price, what it is, and the label it is drawn with --
 * "2026 open", "Aug high", "prev day low". Every line on his charts is labelled with what it
 * is, "so no line is ever ambiguous". */
export interface Level {
  unit: Unit
  kind: LevelKind
  price: number
  label: string
  /** True while this is the open of the period in progress -- the line that is not yet
   * usable on the bar that opened it (rules.ts). */
  current: boolean
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** What the current period's open is called: "2026 open", "Q3 open", "Sep open", "week
 * open", "day open". */
export function currentOpenLabel(unit: Unit, firstDay: number): string {
  const { year, month } = civil(firstDay)
  switch (unit) {
    case 'Y':
      return `${year} open`
    case 'Q':
      return `Q${Math.floor(month / 3) + 1} open`
    case 'M':
      return `${MONTHS[month]} open`
    case 'W':
      return 'week open'
    default:
      return 'day open'
  }
}

/** What a completed period's high/low/mid is called, on a chart whose current period starts
 * at `todayDay`: "2025 high", "Q2 low", "Aug mid", "last week high", "prev day low". A month
 * or quarter in another year carries the year, so "Dec high" in January is never this
 * December's. */
export function priorLabel(unit: Unit, firstDay: number, todayDay: number, kind: LevelKind): string {
  const { year, month } = civil(firstDay)
  const thisYear = civil(todayDay).year
  const stamp = year === thisYear ? '' : ` '${String(year).slice(-2)}`
  switch (unit) {
    case 'Y':
      return `${year} ${kind}`
    case 'Q':
      return `Q${Math.floor(month / 3) + 1}${stamp} ${kind}`
    case 'M':
      return `${MONTHS[month]}${stamp} ${kind}`
    case 'W':
      return `last week ${kind}`
    default:
      return `prev day ${kind}`
  }
}

/** Every unit's periods, folded once, so a bar's levels are a binary search rather than a
 * scan. */
export interface PeriodMap {
  periods: PeriodBar[]
}

export function periodMaps(sessions: readonly SessionBar[], units: readonly Unit[]): Map<Unit, PeriodMap> {
  const maps = new Map<Unit, PeriodMap>()
  for (const unit of units) maps.set(unit, { periods: groupPeriods(sessions, unit) })
  return maps
}

/** The position of the last period at or before `key`, or -1. A period whose key is smaller
 * than asked for is the one BEFORE the period in progress -- which is the honest answer when
 * the period in progress has no sessions yet (a holiday, or a feed that has not served the
 * day), rather than pretending its open is known. */
export function findPeriod(map: PeriodMap, key: number): number {
  let lo = 0
  let hi = map.periods.length - 1
  let at = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (map.periods[mid].key <= key) {
      at = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return at
}

/**
 * The levels in force on session `day`: for each unit, the open of the period in progress
 * and the high, low and midpoint of the one before it.
 *
 * Every value is knowable at the start of `day` -- a period's open is its first session's
 * open and the previous period is complete -- so a bar is never shown a line drawn from its
 * own future. The developing high and low of the period in progress are deliberately NOT
 * levels here: the running extreme of the day is a target (rules.ts), and price is at it by
 * definition whenever it makes a new one, which is not a line to trade against.
 *
 * The midpoint is the 50% retracement of the previous candle's range, "the five major data
 * points" that completes open/high/low/close. The close is left out: on a 24-hour market it
 * is the next open to within a weekend gap, and a second line on the same price adds only
 * clutter.
 */
export function levelsForDay(day: number, maps: ReadonlyMap<Unit, PeriodMap>, units: readonly Unit[]): Level[] {
  const levels: Level[] = []
  for (const unit of units) {
    const map = maps.get(unit)
    if (!map) continue
    const key = periodKey(day, unit)
    const at = findPeriod(map, key)
    if (at < 0) continue
    const period = map.periods[at]
    const started = period.key === key
    if (started) {
      levels.push({ unit, kind: 'open', price: period.open, label: currentOpenLabel(unit, period.firstDay), current: true })
    }
    const prior = started ? (at > 0 ? map.periods[at - 1] : undefined) : period
    if (!prior) continue
    levels.push({ unit, kind: 'high', price: prior.high, label: priorLabel(unit, prior.firstDay, day, 'high'), current: false })
    levels.push({ unit, kind: 'low', price: prior.low, label: priorLabel(unit, prior.firstDay, day, 'low'), current: false })
    levels.push({
      unit,
      kind: 'mid',
      price: (prior.high + prior.low) / 2,
      label: priorLabel(unit, prior.firstDay, day, 'mid'),
      current: false
    })
  }
  return levels
}

/**
 * An exponential moving average, seeded with the simple average of the first `period`
 * values -- the daily 21 EMA is "the day-trade bias switch", and the weekly 21 the macro
 * one. Undefined until the window is full, so a bias filter that cannot be computed is
 * visibly absent rather than quietly wrong.
 */
export function ema(values: readonly number[], period: number): Array<number | undefined> {
  const out = new Array<number | undefined>(values.length).fill(undefined)
  if (period < 1 || values.length < period) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += values[i]
  let previous = sum / period
  out[period - 1] = previous
  const k = 2 / (period + 1)
  for (let i = period; i < values.length; i++) {
    previous = values[i] * k + previous * (1 - k)
    out[i] = previous
  }
  return out
}

/**
 * Bars folded into the sessions they belong to. Used for two things: the sessions a daily
 * feed has not served yet (the one forming, and any that closed since the page loaded), and
 * a daily-or-coarser chart, whose own bars already ARE sessions.
 *
 * A session folded from part of its bars is still a session -- the caller only ever reads
 * one that is complete relative to the bar being judged (rules.ts).
 */
export function sessionsFromBars(bars: readonly Candle[], clock: SessionClock): SessionBar[] {
  const sessions: SessionBar[] = []
  let current: SessionBar | null = null
  for (const bar of bars) {
    const day = sessionDay(bar.timestamp, clock)
    if (current === null || current.day !== day) {
      current = { day, open: bar.open, high: bar.high, low: bar.low, close: bar.close }
      sessions.push(current)
      continue
    }
    current.high = Math.max(current.high, bar.high)
    current.low = Math.min(current.low, bar.low)
    current.close = bar.close
  }
  return sessions
}

/** The daily feed's sessions, extended with the chart's own for every day AFTER the last one
 * the feed served. The feed wins wherever it has an answer: its bars are the vendor's whole
 * session, while the chart holds only the window it has loaded. */
export function mergeSessions(fed: readonly SessionBar[], derived: readonly SessionBar[]): SessionBar[] {
  if (fed.length === 0) return [...derived]
  const last = fed[fed.length - 1].day
  return [...fed, ...derived.filter((session) => session.day > last)]
}
