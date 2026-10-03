import type { Period } from '../src'
import { type Capabilities, capabilities } from './capabilities'

// KLineChart Pro's Period.timespan is a word; wdashboard-server's `resolution`/`interval`
// strings use a single unit letter, the `f"{number}{unit}"` scheme of
// `Interval.get_normalised_string()`. The mapping is case-SENSITIVE on the server side —
// 'm' is minute and 'M' is month — so neither direction may normalise case.
const TIMESPAN_UNIT: Record<string, string> = {
  second: 's',
  minute: 'm',
  hour: 'h',
  day: 'D',
  week: 'W',
  month: 'M',
  year: 'Y'
}

const UNIT_TIMESPAN: Record<string, string> = {
  s: 'second',
  m: 'minute',
  h: 'hour',
  D: 'day',
  W: 'week',
  M: 'month',
  Y: 'year'
}

// Nominal duration of one unit, for ordering the period picker only. Months are the mean
// Gregorian month, years the mean Gregorian year; nothing here is used for bar arithmetic —
// every candle boundary (weekly Sunday 17:00 -> Friday 17:00 New York, monthly/yearly from
// the evening before the first market day) is computed by the server, which also derives
// any interval it does not store from the nearest one it does. The client never buckets.
export const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  D: 86_400_000,
  W: 604_800_000,
  M: 2_629_800_000,
  Y: 31_557_600_000
}

const INTERVAL_PATTERN = /^(\d+)([smhDWMY])$/

export function periodToResolution(period: Period): string {
  const unit = TIMESPAN_UNIT[period.timespan]
  if (!unit) throw new Error(`Unsupported period timespan: ${period.timespan}`)
  return `${period.multiplier}${unit}`
}

export function resolutionToPeriod(code: string): Period | null {
  const match = INTERVAL_PATTERN.exec(code)
  if (!match) return null
  const multiplier = Number(match[1])
  const timespan = UNIT_TIMESPAN[match[2]]
  if (!timespan || multiplier < 1) return null
  return { multiplier, timespan, text: code }
}

export function resolutionDurationMs(code: string): number {
  const match = INTERVAL_PATTERN.exec(code)
  if (!match) return Number.POSITIVE_INFINITY
  return Number(match[1]) * (UNIT_MS[match[2]] ?? Number.POSITIVE_INFINITY)
}

// The selectable periods are exactly what the server advertises in /capabilities.intervals
// — asking for anything else is a guaranteed 400. Sorted shortest-first; the server sends
// them longest-first, which is the opposite of what a period bar should read like.
export function availablePeriods(): Period[] {
  const periods = capabilities()
    .intervals.map((code) => ({ code, period: resolutionToPeriod(code) }))
    .filter((entry): entry is { code: string; period: Period } => entry.period !== null)
    .sort((a, b) => resolutionDurationMs(a.code) - resolutionDurationMs(b.code))
    .map((entry) => entry.period)
  return periods.length > 0 ? periods : [{ multiplier: 1, timespan: 'hour', text: '1h' }]
}

/** The canonical `vendor:SYMBOL` spelling `scopedIntervals` names instruments by. */
function instrumentKey(vendor: string, ticker: string): string {
  return `${vendor.toLowerCase()}:${ticker.toUpperCase()}`
}

/**
 * The advertised interval codes `vendor:ticker` can be charted at.
 *
 * A code the server scopes (`scopedIntervals`; 5s, which exists for the FX pairs it is fed
 * for and nowhere else) is offered only for the instruments it names. Fails CLOSED: from a
 * server that does not advertise the map, a seconds code is offered nowhere -- such a server
 * cannot say where one exists, and offering it everywhere offers an empty chart almost
 * everywhere. Every other code is derived from a base every instrument stores.
 */
export function offeredIntervalCodes(
  vendor: string,
  ticker: string,
  caps: Capabilities = capabilities()
): string[] {
  const scoped = caps.scopedIntervals ?? {}
  const scoping = caps.features.includes('scopedIntervals')
  const key = instrumentKey(vendor, ticker)
  return caps.intervals.filter((code) => {
    const named = scoped[code]
    if (named) return named.some((item) => instrumentKey(...splitKey(item)) === key)
    return scoping || INTERVAL_PATTERN.exec(code)?.[2] !== 's'
  })
}

function splitKey(item: string): [string, string] {
  const at = item.indexOf(':')
  return at < 0 ? ['', item] : [item.slice(0, at), item.slice(at + 1)]
}

// The period the chart opens on: 1h if the server serves it, otherwise the middle of
// whatever it does serve — short enough to show intraday shape, long enough that one
// screen of bars covers real history.
export function defaultPeriod(periods: Period[]): Period {
  return periods.find((period) => period.text === '1h') ?? periods[Math.floor(periods.length / 2)]
}
