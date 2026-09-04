// PURE. Interval algebra and candle-boundary math for the replay, mirroring wmarkettypes'
// `Interval` (get_interval_start / get_interval_end / get_next_interval_start /
// is_market_open) on the instrument's wall clock. No DOM, no chart, no network.
//
// Parity with the server is asserted by `timeframes.test.ts` against
// `fixtures/boundaries.json`, generated from wmarkettypes itself (wdashboard-server
// tests/sim/fixtures/gen_boundaries.py): every open, close and next-open the replay
// computes must be the one `/getbars` labels a candle with, on both backends, or the chart
// drops the bar.
//
// The rules (workspace CLAUDE.md, "Candle boundary rules"): 17:00 in the instrument's own
// timezone is the anchor; candles are half-open; a daily candle opens 17:00 the evening before
// its session and closes 17:00; a week opens Sunday 17:00 and closes Friday 17:00; a month
// opens 17:00 the evening before its FIRST MARKET DAY; a market day is a weekday; a candle's
// close is not the next candle's open (the weekend belongs to neither).

export type Unit = 's' | 'm' | 'h' | 'D' | 'W' | 'M' | 'Y'

export interface IntervalSpec {
  number: number
  unit: Unit
  code: string
}

const PATTERN = /^([1-9][0-9]*)([smhDWMY])$/

export function parseInterval(code: string): IntervalSpec {
  const m = PATTERN.exec(code)
  if (!m) throw new Error(`not an interval code: ${code}`)
  return { number: Number(m[1]), unit: m[2] as Unit, code }
}

export function isInterval(code: string): boolean {
  return PATTERN.test(code)
}

const UNIT_SECONDS: Record<Unit, number> = {
  s: 1,
  m: 60,
  h: 3600,
  D: 86_400,
  W: 7 * 86_400,
  M: 30 * 86_400,
  Y: 365 * 86_400
}

/** Nominal length in ms (calendar units are nominal: a month is 30 days here). Used for
 * sizing fetch pages and ordering, never for boundary arithmetic. */
export function nominalMs(code: string): number {
  const iv = parseInterval(code)
  return iv.number * UNIT_SECONDS[iv.unit] * 1000
}

export function isIntraday(code: string): boolean {
  const unit = parseInterval(code).unit
  return unit === 's' || unit === 'm' || unit === 'h'
}

/** Daily-and-coarser bars are dated on the wire by their canonical date (00:00 of the session
 * in the instrument's own zone). For the FX week that is open + 7h. (`services/wiredate.py`.)
 *
 * **This constant is the forex value**, and `toWireDate`/`fromWireDate` below are its
 * unparameterised form -- correct for every OANDA instrument and wrong for the others: a
 * crypto day is already dated by its open (0h) and a US equity day opens 9h into its date
 * (-9h). `scheduleWireShift` is the schedule-aware form; it is what the tile fold uses, and
 * what these two should become once replay and the MTF overlay carry an instrument's
 * `DayGeometry` rather than assuming one. */
export const SESSION_DATE_OFFSET_MS = 7 * 3_600_000

export function sessionDated(code: string): boolean {
  return !isIntraday(code)
}

export function toWireDate(code: string, openMs: number): number {
  return sessionDated(code) ? openMs + SESSION_DATE_OFFSET_MS : openMs
}

export function fromWireDate(code: string, dateMs: number): number {
  return sessionDated(code) ? dateMs - SESSION_DATE_OFFSET_MS : dateMs
}

// --- divisibility ---------------------------------------------------------------------------

function seconds(iv: IntervalSpec): number {
  return iv.number * UNIT_SECONDS[iv.unit]
}

/** Whether every `b` candle is made of whole `a` candles. Intraday against intraday is plain
 * divisibility of lengths (both grids are anchored at 17:00, so 4h tiles a day and 8h does,
 * while 5h does not). Intraday tiles any daily-or-coarser candle iff it tiles a day. `1D`
 * tiles a week, a month and a year (market days); nothing else daily-or-coarser tiles
 * anything but itself except `1M` -> `nM`/`1Y`. */
export function divides(a: string, b: string): boolean {
  if (a === b) return true
  const A = parseInterval(a)
  const B = parseInterval(b)
  const aIntra = A.unit === 's' || A.unit === 'm' || A.unit === 'h'
  const bIntra = B.unit === 's' || B.unit === 'm' || B.unit === 'h'
  if (aIntra && bIntra) return seconds(B) % seconds(A) === 0
  if (aIntra) return 86_400 % seconds(A) === 0
  if (bIntra) return false
  if (A.unit === 'D') return A.number === 1 || (B.unit === 'D' && B.number % A.number === 0)
  if (A.unit === 'W') return B.unit === 'W' && B.number % A.number === 0
  if (A.unit === 'M') {
    if (B.unit === 'M') return B.number % A.number === 0
    return B.unit === 'Y' && 12 % A.number === 0
  }
  return B.unit === 'Y' && B.number % A.number === 0
}

/** The grid every base candidate is drawn from: the intraday lengths that tile a day, and
 * the calendar units. Coarsest last. */
export const CANDIDATE_LADDER: readonly string[] = [
  '1s',
  '5s',
  '10s',
  '15s',
  '30s',
  '1m',
  '2m',
  '3m',
  '5m',
  '10m',
  '15m',
  '20m',
  '30m',
  '1h',
  '2h',
  '3h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1D',
  '1W',
  '1M',
  '1Y'
]

/** The stored ladder: what the store physically holds (`5s` only for the majors that have
 * it -- callers pass the instrument's own list). */
export const STORED_LADDER: readonly string[] = ['5s', '1m', '1h', '1D']

/** The greatest common divisor of a set of intervals: the coarsest interval that tiles every
 * one of them. Intraday sets reduce exactly (3m + 5m -> 1m, 15m + 1h -> 15m); a set with a
 * calendar interval picks the coarsest ladder entry dividing all (1D + 1W -> 1D, 4h + 1D ->
 * 4h). Null for an empty set. */
export function gcdInterval(codes: readonly string[]): string | null {
  const unique = [...new Set(codes)]
  if (unique.length === 0) return null
  if (unique.length === 1) return unique[0]
  if (unique.every(isIntraday)) {
    let g = 0
    for (const code of unique) g = gcd(g, seconds(parseInterval(code)))
    return secondsToCode(g)
  }
  const candidates = [...CANDIDATE_LADDER, ...unique]
  let best: string | null = null
  for (const c of candidates) {
    if (unique.every((code) => divides(c, code))) {
      if (best === null || coarser(c, best)) best = c
    }
  }
  return best
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

function secondsToCode(s: number): string {
  if (s % 3600 === 0) return `${s / 3600}h`
  if (s % 60 === 0) return `${s / 60}m`
  return `${s}s`
}

/** True when `a` is a coarser interval than `b` (tiles it, or is nominally longer). */
export function coarser(a: string, b: string): boolean {
  if (a === b) return false
  if (divides(b, a)) return true
  if (divides(a, b)) return false
  return nominalMs(a) > nominalMs(b)
}

export function sortByLength(codes: readonly string[]): string[] {
  return [...codes].sort((a, b) => nominalMs(a) - nominalMs(b))
}

/** The default base: the GCD of the intervals in use, floored to the coarsest STORED
 * interval that divides it. `null` when nothing stored divides the GCD (a 5s-less
 * instrument with a 30s pane, say) -- the caller reports it rather than guessing. */
export function defaultBase(inUse: readonly string[], stored: readonly string[]): string | null {
  const g = gcdInterval(inUse)
  if (g === null) return null
  let best: string | null = null
  for (const s of stored) {
    if (divides(s, g) && (best === null || coarser(s, best))) best = s
  }
  return best
}

export interface BaseCheck {
  ok: boolean
  reason?: string
}

/** A base must be stored for the instrument and tile every interval in use. */
export function validateBase(base: string, inUse: readonly string[], stored: readonly string[]): BaseCheck {
  if (!isInterval(base)) return { ok: false, reason: `${base} is not an interval` }
  if (!stored.includes(base)) return { ok: false, reason: `${base} is not stored for this instrument` }
  const offending = inUse.filter((code) => !divides(base, code))
  if (offending.length > 0) {
    return { ok: false, reason: `${base} does not divide ${offending.join(', ')}` }
  }
  return { ok: true }
}

/** The stored intervals finer than `code`, finest first -- the refinement ladder the fill
 * engine descends when a coarse candle intersects something working. */
export function finerStored(code: string, stored: readonly string[]): string[] {
  return sortByLength(stored.filter((s) => s !== code && divides(s, code) && nominalMs(s) < nominalMs(code)))
}

// --- the wall clock ---------------------------------------------------------------------------

export const MARKET_TZ = 'America/New_York'
const SESSION_ANCHOR_HOUR = 17
const HOUR = 3_600_000
const DAY = 86_400_000
const SESSION_SHIFT = (24 - SESSION_ANCHOR_HOUR) * HOUR // 7h: wall + 7h floors to the session date
const SESSION_CLOSE = SESSION_ANCHOR_HOUR * HOUR

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    formatters.set(tz, f)
  }
  return f
}

/** An instant as a "naive wall-clock" number: the wall-clock reading re-encoded as if it were
 * UTC (`Date.UTC(y, m, d, h, mi, s)` + the sub-second part), which is what makes floor/day
 * arithmetic on it plain integer arithmetic -- the same trick wmarkettypes' `to_wall_clock`
 * plays with a naive pandas Timestamp. */
export function toWall(ms: number, tz: string = MARKET_TZ): number {
  const parts = formatter(tz).formatToParts(new Date(ms))
  let y = 0
  let mo = 0
  let d = 0
  let h = 0
  let mi = 0
  let s = 0
  for (const p of parts) {
    switch (p.type) {
      case 'year':
        y = Number(p.value)
        break
      case 'month':
        mo = Number(p.value)
        break
      case 'day':
        d = Number(p.value)
        break
      case 'hour':
        h = Number(p.value)
        break
      case 'minute':
        mi = Number(p.value)
        break
      case 'second':
        s = Number(p.value)
        break
    }
  }
  const sub = ((ms % 1000) + 1000) % 1000
  return Date.UTC(y, mo - 1, d, h, mi, s) + sub
}

/** The zone's offset (ms east of UTC) in force at an instant. */
function offsetAt(ms: number, tz: string): number {
  return toWall(ms, tz) - ms
}

/** The instant a naive wall-clock reading names. On a repeated hour (fall-back) the EARLIER
 * reading; on a skipped hour (spring-forward) the next wall time that exists -- both as
 * wmarkettypes' `from_wall_clock` resolves them, so a boundary computed here lands where the
 * server's does. */
export function fromWall(wall: number, tz: string = MARKET_TZ): number {
  // The two offsets that could apply are the ones in force a day either side.
  const before = offsetAt(wall - DAY, tz)
  const after = offsetAt(wall + DAY, tz)
  const candidates = [wall - before, wall - after]
  const valid = candidates.filter((ms) => toWall(ms, tz) === wall)
  if (valid.length > 0) return Math.min(...valid)
  // Skipped hour: the later offset shifts it onto a wall time that exists.
  return wall - before
}

// --- session-date helpers (naive wall clock) ---------------------------------------------------

function floorDay(wall: number): number {
  return Math.floor(wall / DAY) * DAY
}

/** Midnight of the session date: the day whose 17:00 close ends this session. */
function sessionDate(wall: number): number {
  return floorDay(wall + SESSION_SHIFT)
}

function sessionOpen(sessionDay: number): number {
  return sessionDay - SESSION_SHIFT
}

function sessionClose(sessionDay: number): number {
  return sessionDay + SESSION_CLOSE
}

/** 0 = Monday .. 6 = Sunday, of a naive day number. */
function weekday(day: number): number {
  return (((Math.floor(day / DAY) + 3) % 7) + 7) % 7 // 1970-01-01 was a Thursday (3)
}

function daysSinceEpoch(day: number): number {
  return Math.floor(day / DAY)
}

/** Weekdays since the epoch for a weekday `day` (Monday..Friday); mirrors wmarkettypes'
 * `timestamp_to_weekdays_since_epoch`. */
function weekdaysSinceEpoch(day: number): number {
  const days = daysSinceEpoch(day)
  // Align to a Monday: 1970-01-05 is day 4, a Monday.
  const since = days - 4
  const weeks = Math.floor(since / 7)
  const rem = since - weeks * 7
  return weeks * 5 + Math.min(rem, 4)
}

function weekdaysSinceEpochToDay(n: number): number {
  const weeks = Math.floor(n / 5)
  const rem = n - weeks * 5
  return (4 + weeks * 7 + rem) * DAY
}

function floorToWeekday(sessionDay: number): number {
  const wd = weekday(sessionDay)
  return wd >= 5 ? sessionDay - (wd - 4) * DAY : sessionDay
}

function weekMonday(sessionDay: number): number {
  return sessionDay - weekday(sessionDay) * DAY
}

function firstWeekdayOfMonth(year: number, month: number): number {
  let day = Date.UTC(year, month - 1, 1)
  const wd = weekday(day)
  if (wd >= 5) day += (7 - wd) * DAY
  return day
}

function lastWeekdayOfMonth(year: number, month: number): number {
  let day = Date.UTC(year, month, 1) - DAY
  const wd = weekday(day)
  if (wd >= 5) day -= (wd - 4) * DAY
  return day
}

function effectiveMonth(sessionDay: number): [number, number] {
  const date = new Date(sessionDay)
  let year = date.getUTCFullYear()
  let month = date.getUTCMonth() + 1
  if (sessionDay < firstWeekdayOfMonth(year, month)) {
    month -= 1
    if (month === 0) {
      year -= 1
      month = 12
    }
  }
  return [year, month]
}

function effectiveYear(sessionDay: number): number {
  let year = new Date(sessionDay).getUTCFullYear()
  if (sessionDay < firstWeekdayOfMonth(year, 1)) year -= 1
  return year
}

function unitStartForSessionDate(iv: IntervalSpec, sessionDay: number, number: number): number {
  switch (iv.unit) {
    case 'D': {
      const n = weekdaysSinceEpoch(floorToWeekday(sessionDay))
      return sessionOpen(weekdaysSinceEpochToDay(n - (n % number)))
    }
    case 'W': {
      let monday = weekMonday(sessionDay)
      if (number > 1) {
        const weeks = Math.floor(daysSinceEpoch(monday) / 7)
        monday -= 7 * (weeks % number) * DAY
      }
      return sessionOpen(monday)
    }
    case 'M': {
      const [year, month] = effectiveMonth(sessionDay)
      let index = year * 12 + (month - 1)
      index -= index % number
      return sessionOpen(firstWeekdayOfMonth(Math.floor(index / 12), (index % 12) + 1))
    }
    case 'Y': {
      let year = effectiveYear(sessionDay)
      year -= year % number
      return sessionOpen(firstWeekdayOfMonth(year, 1))
    }
    default:
      throw new Error(`not a session-date unit: ${iv.unit}`)
  }
}

function unitLength(unit: Unit): number {
  return UNIT_SECONDS[unit] * 1000
}

// --- the public boundary functions --------------------------------------------------------

/** Open of the candle containing `ms` -- a floor: inside the closed window, the candle that
 * most recently opened. */
export function intervalStart(code: string, ms: number, tz: string = MARKET_TZ): number {
  const iv = parseInterval(code)
  if (iv.unit === 'D' || iv.unit === 'W' || iv.unit === 'M' || iv.unit === 'Y') {
    const day = sessionDate(toWall(ms, tz))
    return fromWall(unitStartForSessionDate(iv, day, iv.number), tz)
  }
  // Single-unit floor on the wall clock by absolute subtraction: the wall reading is floored
  // to the unit and the same delta taken off the instant, so the second reading of a repeated
  // hour stays distinct from the first (a 1h grid really is regular in absolute time).
  const wall = toWall(ms, tz)
  const len = unitLength(iv.unit)
  const start = ms - (wall - Math.floor(wall / len) * len)
  if (iv.number === 1) return start
  if (iv.unit === 's' || iv.unit === 'm') {
    const wallStart = toWall(start, tz)
    const within = iv.unit === 's' ? Math.floor(wallStart / 1000) % 60 : Math.floor(wallStart / 60_000) % 60
    return start - (within % iv.number) * len
  }
  // Hours: anchored so a candle always opens at 17:00 wall clock. Step back on the naive wall
  // clock and re-localize, so the grid is DST-safe in both directions.
  const wallStart = toWall(start, tz)
  const hour = Math.floor(wallStart / HOUR) % 24
  const past = (((hour - SESSION_ANCHOR_HOUR) % iv.number) + iv.number) % iv.number
  return fromWall(wallStart - past * HOUR, tz)
}

/** The next instant strictly after `ms` at which the zone's wall clock reads 17:00 -- the
 * session anchor every daily-and-coarser candle opens and closes on.
 *
 * This is the coarsest true statement about when a daily, weekly, monthly or yearly book can
 * change: every such boundary is a 17:00, so nothing that keys off one can move between two
 * consecutive returns of this. Not every 17:00 IS a boundary (Saturday's is not), so it errs
 * towards asking again, never towards missing a change -- which is the direction a cache
 * validity horizon has to err in. */
export function nextSessionAnchor(ms: number, tz: string = MARKET_TZ): number {
  const wall = toWall(ms, tz)
  const anchor = floorDay(wall) + SESSION_ANCHOR_HOUR * HOUR
  return fromWall(anchor > wall ? anchor : anchor + DAY, tz)
}

/** Is the 24/5 FX week open at `ms` on the zone's wall clock? Friday from 17:00, all
 * Saturday and Sunday before 17:00 are closed. */
export function isMarketOpen(ms: number, tz: string = MARKET_TZ): boolean {
  const wall = toWall(ms, tz)
  const wd = weekday(floorDay(wall))
  const hour = Math.floor((wall - floorDay(wall)) / HOUR)
  if (wd === 4 && hour >= SESSION_ANCHOR_HOUR) return false
  if (wd === 5) return false
  if (wd === 6 && hour < SESSION_ANCHOR_HOUR) return false
  return true
}

function previousIntradayStart(code: string, start: number, tz: string): number {
  return intervalStart(code, start - 1, tz)
}

function nextIntradayStart(code: string, start: number, tz: string): number {
  const delta = nominalMs(code)
  const stepped = start + delta
  let candidate = intervalStart(code, stepped, tz)
  if (candidate === stepped) return candidate
  if (candidate <= start) candidate = intervalStart(code, fromWall(toWall(start, tz) + delta, tz), tz)
  if (candidate <= start) throw new Error(`no ${code} candle opens after ${start}`)
  let previous = previousIntradayStart(code, candidate, tz)
  while (previous > start) {
    candidate = previous
    previous = previousIntradayStart(code, previous, tz)
  }
  return candidate
}

function shiftStart(iv: IntervalSpec, startWall: number, count: number): number {
  const day = sessionDate(startWall)
  switch (iv.unit) {
    case 'D': {
      const n = weekdaysSinceEpoch(day)
      return sessionOpen(weekdaysSinceEpochToDay(n + count * iv.number))
    }
    case 'W':
      return sessionOpen(day + 7 * count * iv.number * DAY)
    case 'M': {
      const date = new Date(day)
      const index = date.getUTCFullYear() * 12 + date.getUTCMonth() + count * iv.number
      return sessionOpen(firstWeekdayOfMonth(Math.floor(index / 12), (index % 12) + 1))
    }
    case 'Y':
      return sessionOpen(firstWeekdayOfMonth(new Date(day).getUTCFullYear() + count * iv.number, 1))
    default:
      throw new Error(`not a session-date unit: ${iv.unit}`)
  }
}

/** Open of the candle after the one containing `ms`; intraday candles that would open inside
 * the closed window are skipped (from Friday 16:00 the next 1h candle opens Sunday 17:00). */
export function nextIntervalStart(code: string, ms: number, tz: string = MARKET_TZ): number {
  const iv = parseInterval(code)
  let start = intervalStart(code, ms, tz)
  if (iv.unit === 'D' || iv.unit === 'W' || iv.unit === 'M' || iv.unit === 'Y') {
    return fromWall(shiftStart(iv, toWall(start, tz), 1), tz)
  }
  for (;;) {
    start = nextIntradayStart(code, start, tz)
    if (isMarketOpen(start, tz)) return start
  }
}

/** Close of the candle containing `ms` -- exclusive, and NOT the next candle's open: a week
 * closes Friday 17:00, a month 17:00 on its last market day; intraday is open + length. */
export function intervalEnd(code: string, ms: number, tz: string = MARKET_TZ): number {
  const iv = parseInterval(code)
  const start = intervalStart(code, ms, tz)
  if (iv.unit === 's' || iv.unit === 'm' || iv.unit === 'h') return start + nominalMs(code)
  const day = sessionDate(toWall(start, tz))
  let last: number
  switch (iv.unit) {
    case 'D':
      last = weekdaysSinceEpochToDay(weekdaysSinceEpoch(day) + iv.number - 1)
      break
    case 'W':
      last = day + 7 * (iv.number - 1) * DAY + 4 * DAY
      break
    case 'M': {
      const date = new Date(day)
      const index = date.getUTCFullYear() * 12 + date.getUTCMonth() + iv.number - 1
      last = lastWeekdayOfMonth(Math.floor(index / 12), (index % 12) + 1)
      break
    }
    default:
      last = lastWeekdayOfMonth(new Date(day).getUTCFullYear() + iv.number - 1, 12)
  }
  return fromWall(sessionClose(last), tz)
}

/** The close of the bar labelled (store-clock open) `openMs`: its effective instant. */
export function effectiveAt(code: string, openMs: number, tz: string = MARKET_TZ): number {
  return intervalEnd(code, openMs, tz)
}

/** The instant `count` whole `code` candles after `cursor` have completed: the close of the
 * candle containing the cursor (when it lies strictly inside one), then each following
 * candle's close -- computed on the boundary rules, never by adding a timedelta, so a step
 * out of a Friday evening lands on the Sunday session and a 1D step on the next market day. */
export function advanceTarget(code: string, cursor: number, count: number, tz: string = MARKET_TZ): number {
  let t = cursor
  for (let i = 0; i < count; i++) {
    const end = intervalEnd(code, t, tz)
    if (end > t && intervalStart(code, t, tz) <= t && isMarketOpen(t, tz)) t = end
    else t = intervalEnd(code, nextIntervalStart(code, t, tz), tz)
  }
  return t
}

/** Whether `ms` is on the candle grid of `code` (an open). */
export function isBoundary(code: string, ms: number, tz: string = MARKET_TZ): boolean {
  return intervalStart(code, ms, tz) === ms
}


// --- schedules ------------------------------------------------------------------------------
//
// Everything above is the FX week: 17:00 New York, shut from Friday 17:00 to Sunday 17:00.
// That is one of three schedules the store carries, and the boundary rules differ between
// them -- so anything folding one interval out of another has to be told which it is walking.
//
// It is told as **data, not as a name**. A schedule's day is two offsets from the midnight
// that dates a session, plus whether every calendar day is a market day, and every rule below
// is built from those three values (wmarkettypes' `DayGeometry`, published on each tile
// manifest). The three the store holds today:
//
//   forex       (-7, +17)  the day opens 17:00 the evening before its date, closes 17:00 on it
//   crypto      ( 0, +24)  every day trades; the close IS the next open
//   equities    (+9, +16)  opens 09:00, closes 16:00 -- the overnight belongs to no candle
//
// The equity anchor is 09:00 while the market opens at 09:30, because the anchor is the hour
// containing the session open. The first candle of the day is a real candle carrying half an
// hour less data; an 09:30 anchor would put every later boundary on the half hour too.
//
// A market with another anchor needs no change here at all -- which is the point of carrying
// the geometry rather than a list of asset classes.

export interface DayGeometry {
  /** Hours from the midnight that dates a session to that day's open. */
  openOffset: number
  /** Hours from that midnight to the day's close. */
  closeOffset: number
  /** Whether every calendar day is a market day (a continuous market only). */
  everyDayTrades: boolean
}

export const FX_DAY: DayGeometry = {
  openOffset: SESSION_ANCHOR_HOUR - 24,
  closeOffset: SESSION_ANCHOR_HOUR,
  everyDayTrades: false
}
export const CONTINUOUS_DAY: DayGeometry = { openOffset: 0, closeOffset: 24, everyDayTrades: true }

/** The anchor hour the intraday grid runs on: 17, 0 or 9. */
function anchorHour(day: DayGeometry): number {
  return ((day.openOffset % 24) + 24) % 24
}

/** Does a day's close sit exactly on the next day's open? True for a whole-day market
 * (forex within its week, crypto always); false for a partial-day one, whose overnight
 * belongs to neither candle -- the FX weekend's rule applied nightly. */
function contiguous(day: DayGeometry): boolean {
  return day.closeOffset - day.openOffset >= 24
}

/** Midnight (naive wall clock) of the session date this instant belongs to. One expression
 * for every schedule: subtract the day's open offset and floor. An equity 08:00 lands on the
 * previous trading day, which has closed -- not on the one that has not opened. */
function sessionDateFor(wall: number, day: DayGeometry): number {
  return floorDay(wall - day.openOffset * HOUR)
}

function dayOpen(sessionDay: number, day: DayGeometry): number {
  return sessionDay + day.openOffset * HOUR
}

function dayClose(sessionDay: number, day: DayGeometry): number {
  return sessionDay + day.closeOffset * HOUR
}

/** The session date that NAMES the bucket `sessionDay` falls in, for a market-day market.
 * `unitStartForSessionDate` answers with that bucket's FOREX open, so adding the FX offset
 * back off it leaves the midnight the bucket is named for -- the half of the answer that is
 * the same for every weekday market. The schedule's own open is then applied to it. */
function bucketSessionDay(iv: IntervalSpec, sessionDay: number): number {
  return unitStartForSessionDate(iv, sessionDay, iv.number) - FX_DAY.openOffset * HOUR
}

function unitStartFor(iv: IntervalSpec, sessionDay: number, day: DayGeometry): number {
  if (day.everyDayTrades) {
    switch (iv.unit) {
      case 'D':
        return sessionDay - (daysSinceEpoch(sessionDay) % iv.number) * DAY
      case 'W': {
        let monday = weekMonday(sessionDay)
        if (iv.number > 1) monday -= 7 * (Math.floor(daysSinceEpoch(monday) / 7) % iv.number) * DAY
        return monday
      }
      case 'M': {
        const at = new Date(sessionDay)
        let index = at.getUTCFullYear() * 12 + at.getUTCMonth()
        index -= index % iv.number
        return Date.UTC(Math.floor(index / 12), index % 12, 1)
      }
      default: {
        const year = new Date(sessionDay).getUTCFullYear()
        return Date.UTC(year - (year % iv.number), 0, 1)
      }
    }
  }
  // Market-day buckets -- shared by forex and equities, which differ only in where the day
  // opens within the date that names the bucket.
  return dayOpen(bucketSessionDay(iv, sessionDay), day)
}

function unitStepFor(iv: IntervalSpec, sessionDay: number, count: number, day: DayGeometry): number {
  if (day.everyDayTrades) {
    switch (iv.unit) {
      case 'D':
        return sessionDay + count * iv.number * DAY
      case 'W':
        return sessionDay + count * iv.number * 7 * DAY
      case 'M': {
        const at = new Date(sessionDay)
        const index = at.getUTCFullYear() * 12 + at.getUTCMonth() + count * iv.number
        return Date.UTC(Math.floor(index / 12), index % 12, 1)
      }
      default:
        return Date.UTC(new Date(sessionDay).getUTCFullYear() + count * iv.number, 0, 1)
    }
  }
  const stepped = shiftStart(iv, dayOpen(sessionDay, FX_DAY), count)
  return dayOpen(stepped - FX_DAY.openOffset * HOUR, day)
}

/** `intervalStart` under `day`. */
export function scheduleIntervalStart(code: string, ms: number, tz: string, day: DayGeometry): number {
  const iv = parseInterval(code)
  if (iv.unit === 'D' || iv.unit === 'W' || iv.unit === 'M' || iv.unit === 'Y') {
    return fromWall(unitStartFor(iv, sessionDateFor(toWall(ms, tz), day), day), tz)
  }
  const wall = toWall(ms, tz)
  const len = unitLength(iv.unit)
  const start = ms - (wall - Math.floor(wall / len) * len)
  if (iv.number === 1) return start
  if (iv.unit === 's' || iv.unit === 'm') {
    const wallStart = toWall(start, tz)
    const within = iv.unit === 's' ? Math.floor(wallStart / 1000) % 60 : Math.floor(wallStart / 60_000) % 60
    return start - (within % iv.number) * len
  }
  // Hours, anchored on the schedule's own open hour; stepped on the wall clock so the grid
  // is DST-safe in both directions.
  const wallStart = toWall(start, tz)
  const hour = Math.floor(wallStart / HOUR) % 24
  const past = (((hour - anchorHour(day)) % iv.number) + iv.number) % iv.number
  return fromWall(wallStart - past * HOUR, tz)
}

/** `intervalEnd` under `day`: the day's own close for a partial-day market, the next open
 * for a whole-day one. */
export function scheduleIntervalEnd(code: string, ms: number, tz: string, day: DayGeometry): number {
  const iv = parseInterval(code)
  const start = scheduleIntervalStart(code, ms, tz, day)
  if (iv.unit === 's' || iv.unit === 'm' || iv.unit === 'h') return start + nominalMs(code)
  if (day.everyDayTrades) {
    return fromWall(unitStepFor(iv, sessionDateFor(toWall(start, tz), day), 1, day), tz)
  }
  // Market-day units: the period's LAST market day, closed where this schedule's day closes.
  // Which day that is -- the last weekday of the month, Friday of the week -- is schedule
  // independent, so the FX path computes it and only the closing instant differs. Its answer
  // is that day's 17:00, and the instant before it is inside the day itself.
  const asFx = fromWall(dayOpen(sessionDateFor(toWall(start, tz), day), FX_DAY), tz)
  const lastDay = sessionDateFor(toWall(intervalEnd(code, asFx, tz), tz) - 1, FX_DAY)
  return fromWall(dayClose(lastDay, day), tz)
}

/** `nextIntervalStart` under `day`. */
export function scheduleNextIntervalStart(code: string, ms: number, tz: string, day: DayGeometry): number {
  if (day.everyDayTrades) return scheduleIntervalEnd(code, ms, tz, day)
  const iv = parseInterval(code)
  const start = scheduleIntervalStart(code, ms, tz, day)
  if (iv.unit === 'D' || iv.unit === 'W' || iv.unit === 'M' || iv.unit === 'Y') {
    return fromWall(unitStepFor(iv, sessionDateFor(toWall(start, tz), day), 1, day), tz)
  }
  let cursor = start
  for (;;) {
    cursor = nextIntradayStart(code, cursor, tz)
    if (scheduleIsMarketOpen(cursor, tz, day)) return cursor
  }
}

/** `isMarketOpen` under `day` -- the BOUNDARY notion, which is not the schedule's own: an
 * equity day is boundary-open from 09:00 because that is where its grid is anchored, while
 * the session (and therefore the rows) starts at 09:30. */
export function scheduleIsMarketOpen(ms: number, tz: string, day: DayGeometry): boolean {
  if (day.everyDayTrades) return true
  const wall = toWall(ms, tz)
  const sessionDay = sessionDateFor(wall, day)
  if (weekday(sessionDay) >= 5) return false
  if (contiguous(day)) return true
  return dayOpen(sessionDay, day) <= wall && wall < dayClose(sessionDay, day)
}

/** The wire offset for daily-and-coarser bars under `day`: the negation of its open offset,
 * so a bar's label is the midnight that dates its session. +7h forex, 0 crypto, -9h equities
 * -- `wdashboard_server/services/wiredate.py` computes the identical number. */
export function scheduleWireShift(code: string, day: DayGeometry): number {
  return sessionDated(code) ? -day.openOffset * HOUR : 0
}
