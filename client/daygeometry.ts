import type { DayGeometry } from '../src'
import type { MarketHours } from './symbols'

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']
const WEEK_SECONDS = 7 * 86_400

/** Seconds after local midnight of an 'HH:MM' / 'HH:MM:SS' reading. */
function secondsOf(time: string): number {
  const [h = 0, m = 0, s = 0] = time.split(':').map(Number)
  return h * 3600 + m * 60 + s
}

/** The day geometry a schedule's candle grid describes -- a port of wmarkettypes'
 * `day_geometry`, which is where the rule lives: continuous (a session spanning the whole
 * week) is (0, +24) on every day; otherwise the anchor is the hour containing the earliest
 * session open (past noon reads as the evening before), and the day closes at the latest
 * session close rounded up to the hour, or a whole day after the open when the two coincide.
 * Read off the grid (`sessions`), never `trading`. Null for a schedule with no sessions. */
export function dayGeometryOf(hours: MarketHours | null | undefined): DayGeometry | null {
  const sessions = hours?.sessions ?? []
  if (sessions.length === 0) return null
  const continuous = sessions.some((session) => {
    const open = DAYS.indexOf(session.openDay) * 86_400 + secondsOf(session.openTime)
    const close = DAYS.indexOf(session.closeDay) * 86_400 + secondsOf(session.closeTime)
    return (((close - open) % WEEK_SECONDS) + WEEK_SECONDS) % WEEK_SECONDS === 0
  })
  if (continuous) return { openOffset: 0, closeOffset: 24, everyDayTrades: true }
  const opens = Math.min(...sessions.map((session) => secondsOf(session.openTime)))
  const closes = Math.max(...sessions.map((session) => secondsOf(session.closeTime)))
  const anchor = Math.floor(opens / 3600)
  const openOffset = anchor >= 12 ? anchor - 24 : anchor
  if (opens === closes) return { openOffset, closeOffset: openOffset + 24, everyDayTrades: false }
  return { openOffset, closeOffset: Math.ceil(closes / 3600), everyDayTrades: false }
}
