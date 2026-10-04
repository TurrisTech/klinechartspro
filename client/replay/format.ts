// PURE. How the replay writes an instant: on the INSTRUMENT's clock -- the zone its chart is
// drawn on (New York for the FX week, UTC for a coinbase pair) -- and WITH the weekday. A
// replay's cursor lands in the weekend as readily as anywhere (the default start, a Random draw,
// a step from Friday's close), and "Sep 26, 20:00" does not say that nothing trades then --
// "Sat, Sep 26, 20:00" does.

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
      hour12: false
    })
    formats.set(timezone, f)
  }
  return f
}

/** "Sat, Sep 26, 20:00" on `timezone` -- the replay's clock, the walk's reach, a picked start. */
export function formatClock(ms: number, timezone: string): string {
  return format(timezone).format(new Date(ms))
}

/** How a zone is named next to a time: "New York time", "UTC", "Tokyo time". */
export function zoneName(timezone: string): string {
  if (timezone === 'UTC' || timezone === 'Etc/UTC' || timezone === 'GMT') return 'UTC'
  const city = timezone.split('/').pop() ?? timezone
  return `${city.replace(/_/g, ' ')} time`
}
