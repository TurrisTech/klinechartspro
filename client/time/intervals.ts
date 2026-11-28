// PURE. Interval CODES -- `15m`, `4h`, `1D`, the `f"{number}{unit}"` scheme of wmarkettypes'
// `Interval.get_normalised_string()` -- and nothing about when a candle opens (that is
// timeframes.ts, on an instrument's schedule). The one parser of a code in the client: the period
// picker's conversions, the nominal lengths everything sizes and orders by, divisibility and the
// base ladders all read it. Case-SENSITIVE, as on the server: 'm' is minute and 'M' is month.

import type { Period } from '../../src'

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

/** One unit's nominal length in ms. A month is the mean Julian month (365.25 / 12 days) and a
 * year 365.25 days: there was a second table (30 and 365 days, in this file) beside the period
 * picker's until 2026-11-28, so a monthly fetch page and a monthly sort disagreed by 1.5%. */
const UNIT_MS: Record<Unit, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  D: 86_400_000,
  W: 604_800_000,
  M: 2_629_800_000,
  Y: 31_557_600_000
}

/** Nominal length in ms (calendar units are nominal). For sizing fetch pages and ordering,
 * never for boundary arithmetic -- every candle boundary is the schedule's (timeframes.ts). */
export function nominalMs(code: string): number {
  const iv = parseInterval(code)
  return iv.number * UNIT_MS[iv.unit]
}

/** One unit's length in ms: exact for s/m/h/D/W, nominal for M/Y. */
export function unitMs(unit: Unit): number {
  return UNIT_MS[unit]
}

/** `nominalMs`, or Infinity for a string that is not an interval code -- which sorts it last.
 * What the period picker and the plugin facilities order and size by. */
export function resolutionDurationMs(code: string): number {
  return isInterval(code) ? nominalMs(code) : Number.POSITIVE_INFINITY
}

export function isIntraday(code: string): boolean {
  const unit = parseInterval(code).unit
  return unit === 's' || unit === 'm' || unit === 'h'
}

// --- divisibility ---------------------------------------------------------------------------

function seconds(iv: IntervalSpec): number {
  return (iv.number * UNIT_MS[iv.unit]) / 1000
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
const CANDIDATE_LADDER: readonly string[] = [
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

/** The part of the stored ladder an instrument of one vendor can hold: `STORED_LADDER` cut to
 * the intervals the server says that vendor stores (`/capabilities` `baseIntervals`), or all of
 * it where the server states nothing (an older server: probe everything, as before).
 *
 * The cut is what keeps "stored" meaning stored. `/getbars` answers an interval the vendor does
 * not hold as readily as one it does -- it folds it -- so a probe that only asks "is there a
 * bar?" counted schwab's 1h as stored, though schwab stores 1m, 30m and 1D and every 1h bar is
 * a fold of 30m. Two folds that disagree, as it happens: the browser's (client/tiles/derive.ts)
 * keeps the 09:00-09:30 pre-market half hour a stored read carries, the server's drops it
 * (prod SPY 2026-10-05..23: the 09:00 hour differed in open and volume on 15 of 15 days, in its
 * high or low on 9, and no other hour differed at all). Taken for stored, it became a replay
 * base (`validateBase` requires a stored one), a rung of every 4h/1D forming candle
 * (`composeLadder`) and a step of the fill engine's refinement (`finerStored`), each answering
 * from whichever fold its period landed in.
 * The cut also spares the probe the reads the server can only refuse: 5s for schwab and
 * coinbase is a 500. */
export function storedLadderFor(advertised: readonly string[] | null): string[] {
  return advertised === null ? [...STORED_LADDER] : STORED_LADDER.filter((code) => advertised.includes(code))
}

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

// --- the chart's periods ------------------------------------------------------------------------
//
// KLineChart Pro's Period.timespan is a word; the server's `resolution`/`interval` strings use a
// single unit letter. Neither direction may normalise case.

const TIMESPAN_UNIT: Record<string, Unit> = {
  second: 's',
  minute: 'm',
  hour: 'h',
  day: 'D',
  week: 'W',
  month: 'M',
  year: 'Y'
}

const UNIT_TIMESPAN: Record<Unit, string> = {
  s: 'second',
  m: 'minute',
  h: 'hour',
  D: 'day',
  W: 'week',
  M: 'month',
  Y: 'year'
}

export function periodToResolution(period: Period): string {
  const unit = TIMESPAN_UNIT[period.timespan]
  if (!unit) throw new Error(`Unsupported period timespan: ${period.timespan}`)
  return `${period.multiplier}${unit}`
}

export function resolutionToPeriod(code: string): Period | null {
  if (!isInterval(code)) return null
  const iv = parseInterval(code)
  return { multiplier: iv.number, timespan: UNIT_TIMESPAN[iv.unit], text: code }
}
