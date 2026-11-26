// PURE. How the replay writes an instant: on the INSTRUMENT's clock -- the zone its chart is
// drawn on (New York for the FX week, UTC for a coinbase pair) -- and WITH the weekday. A
// replay's cursor lands in the weekend as readily as anywhere (the default start, a Random draw,
// a step from Friday's close), and "Sep 26, 20:00" does not say that nothing trades then --
// "Sat, Sep 26, 20:00:00" does.
//
// To the second (user, 2026-11-13), like every other time the trading UI prints: a replay on
// 5s bars steps between minutes, and a clock that read the same for twelve steps hid it.

const formats = new Map<string, Intl.DateTimeFormat>()

function format(timezone: string): Intl.DateTimeFormat {
  let f = formats.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
    formats.set(timezone, f)
  }
  return f
}

/** "Sat, Sep 26, 20:00:00" on `timezone` -- the replay's clock, the walk's reach, a picked start. */
export function formatClock(ms: number, timezone: string): string {
  return format(timezone).format(new Date(ms))
}

/** How a zone is named next to a time: "New York time", "UTC", "Tokyo time". */
export function zoneName(timezone: string): string {
  if (timezone === 'UTC' || timezone === 'Etc/UTC' || timezone === 'GMT') return 'UTC'
  const city = timezone.split('/').pop() ?? timezone
  return `${city.replace(/_/g, ' ')} time`
}

const dated = new Map<string, Intl.DateTimeFormat>()

/** "Tue, Jan 03, 2023, 17:00:00" on `timezone`: `formatClock` with the year, for an instant that
 * may be any year back -- a past replay's start and end in the Sessions list. */
export function formatDate(ms: number, timezone: string): string {
  let f = dated.get(timezone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    })
    dated.set(timezone, f)
  }
  return f.format(new Date(ms))
}

/** Where a replay started and how far it got, on the instrument's clock: the year once, unless
 * the two fall in different years. */
export function formatSpan(from: number, to: number, timezone: string): string {
  const year = (ms: number): string => new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric' }).format(new Date(ms))
  const end = year(from) === year(to) ? formatClock(to, timezone) : formatDate(to, timezone)
  return `${formatDate(from, timezone)} → ${end}`
}
