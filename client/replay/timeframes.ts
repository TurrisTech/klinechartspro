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

/** Daily-and-coarser bars are dated on the wire by their canonical date (00:00 New York of
 * the session): open + 7h. Intraday bars are dated by their open. (`services/wiredate.py`.) */
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
