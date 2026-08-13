import type { Period } from '../src'
import { capabilities } from './capabilities'

// KLineChart Pro's Period.timespan is a word; wdashboard-server's `resolution`/`interval`
// strings use a single unit letter, the `f"{number}{unit}"` scheme of
// `Interval.get_normalised_string()`. The mapping is case-SENSITIVE on the server side —
// 'm' is minute and 'M' is month — so neither direction may normalise case.
const TIMESPAN_UNIT: Record<string, string> = {
  minute: 'm',
  hour: 'h',
  day: 'D',
  week: 'W',
  month: 'M'
}

const UNIT_TIMESPAN: Record<string, string> = {
  m: 'minute',
  h: 'hour',
  D: 'day',
  W: 'week',
  M: 'month'
}

// Nominal duration of one unit, for ordering the period picker only. Months are the mean
// Gregorian month; nothing here is used for bar arithmetic.
const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  D: 86_400_000,
  W: 604_800_000,
  M: 2_629_800_000
}

const INTERVAL_PATTERN = /^(\d+)([mhDWM])$/

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

// The period the chart opens on: 1h if the server serves it, otherwise the middle of
// whatever it does serve — short enough to show intraday shape, long enough that one
// screen of bars covers real history.
export function defaultPeriod(periods: Period[]): Period {
  return periods.find((period) => period.text === '1h') ?? periods[Math.floor(periods.length / 2)]
}
