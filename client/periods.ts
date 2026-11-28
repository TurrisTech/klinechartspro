import type { Period } from '../src'
import { type Capabilities, capabilities } from './capabilities'
import { isInterval, parseInterval, resolutionDurationMs, resolutionToPeriod } from './time/intervals'

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

/** The canonical `vendor:SYMBOL` spelling `scopedIntervals` names instruments by: a key to match
 * the server's list against whatever case either side wrote, so not symbols.ts's `instrumentKey`,
 * which spells a key exactly as given. */
function scopedKey(vendor: string, ticker: string): string {
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
  const key = scopedKey(vendor, ticker)
  return caps.intervals.filter((code) => {
    const named = scoped[code]
    if (named) return named.some((item) => scopedKey(...splitScopedItem(item)) === key)
    return scoping || !(isInterval(code) && parseInterval(code).unit === 's')
  })
}

// Not symbols.ts's `splitInstrumentKey` either: a bare item here gets an empty vendor, so it names
// no vendor's instrument, where a bare key there is the default vendor's.
function splitScopedItem(item: string): [string, string] {
  const at = item.indexOf(':')
  return at < 0 ? ['', item] : [item.slice(0, at), item.slice(at + 1)]
}

// The period the chart opens on: 1h if the server serves it, otherwise the middle of
// whatever it does serve — short enough to show intraday shape, long enough that one
// screen of bars covers real history.
export function defaultPeriod(periods: Period[]): Period {
  return periods.find((period) => period.text === '1h') ?? periods[Math.floor(periods.length / 2)]
}
