// PURE. How the client writes an instant: always on a named zone -- the instrument's own clock
// (New York for the FX week, UTC for a coinbase pair), the one its chart pane is drawn on -- and
// to the second (user, 2026-11-13): a replay on 5s bars steps between minutes, and a paper fill
// lands on a tick, so two instants a few seconds apart must not read as one. `hourCycle: 'h23'`
// rather than `hour12: false`, which prints midnight as "24:00" in some engines.
//
// The replay writes its clock WITH the weekday: a cursor lands in the weekend as readily as
// anywhere (the default start, a Random draw, a step from Friday's close), and "Sep 26, 20:00"
// does not say that nothing trades then -- "Sat, Sep 26, 20:00:00" does.

type Shape = 'clock' | 'dated' | 'instant'

const TO_THE_SECOND: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23'
}

const SHAPES: Record<Shape, Intl.DateTimeFormatOptions> = {
  clock: { weekday: 'short', ...TO_THE_SECOND },
  dated: { weekday: 'short', year: 'numeric', ...TO_THE_SECOND },
  instant: TO_THE_SECOND
}

/** One formatter per shape and zone, made on first use. */
const formats = new Map<string, Intl.DateTimeFormat>()

function format(shape: Shape, timezone: string): Intl.DateTimeFormat {
  const key = `${shape}|${timezone}`
  let f = formats.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...SHAPES[shape] })
    formats.set(key, f)
  }
  return f
}

/** "Sat, Sep 26, 20:00:00" on `timezone` -- the replay's clock, the walk's reach, a picked start. */
export function formatClock(ms: number, timezone: string): string {
  return format('clock', timezone).format(new Date(ms))
}

/** An instant on `zone`'s clock, to the second: 'Nov 13, 14:05:09' -- every time the trading UI
 * prints. `zone` is the instrument's own (`InstrumentInfo.timezone`, from its schedule), so a
 * trade's times read as its candles do. With no zone (the instrument's config not in hand yet, or
 * none), the time is UTC and says so: 'Nov 13, 19:05:09 UTC'. Never a guessed market zone: that
 * reads as right and is not. */
export function formatInstant(ms: number | null | undefined, zone: string | null): string {
  if (ms === null || ms === undefined) return '—'
  const text = format('instant', zone ?? 'UTC').format(new Date(ms))
  return zone ? text : `${text} UTC`
}

/** How a zone is named next to a time: "New York time", "UTC", "Tokyo time". */
export function zoneName(timezone: string): string {
  if (timezone === 'UTC' || timezone === 'Etc/UTC' || timezone === 'GMT') return 'UTC'
  const city = timezone.split('/').pop() ?? timezone
  return `${city.replace(/_/g, ' ')} time`
}

/** Where a replay started and how far it got, on the instrument's clock: the year once, unless
 * the two fall in different years. */
export function formatSpan(from: number, to: number, timezone: string): string {
  const year = (ms: number): string => new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric' }).format(new Date(ms))
  const dated = (ms: number): string => format('dated', timezone).format(new Date(ms))
  const end = year(from) === year(to) ? formatClock(to, timezone) : dated(to)
  return `${dated(from)} → ${end}`
}
