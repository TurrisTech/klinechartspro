// PURE. How the replay writes an instant: on the market's clock (New York, the zone every chart
// on the wall uses) and WITH the weekday. A replay's cursor lands in the weekend as readily as
// anywhere (the default start, a Random draw, a step from Friday's close), and "Sep 26, 20:00"
// does not say that nothing trades then -- "Sat, Sep 26, 20:00" does.

const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})

/** "Sat, Sep 26, 20:00" -- the replay's clock, the walk's reach, a picked start. */
export function formatClock(ms: number): string {
  return clockFormat.format(new Date(ms))
}
