import { fetchBars } from '../history'
import type { Page, Range, SourceSpec } from '../plugins/types'

// The one thing TradeTalk reads that the chart does not already hold: DAILY bars.
//
// The map is built from calendar candles -- the yearly open, last month's high, last week's
// low -- and a 5m pane holds hours. So this source reads `1D` for the chart's window widened
// back to the start of the year before it, which is the least that can answer "what did last
// year's candle do" and, incidentally, far more than the 21 sessions the daily EMA needs.
//
// Nothing new on the server: `/getbars` has always served daily bars, and `fetchBars` reads
// the closed part of the window straight from the chart tiles, so a pane that pans through
// history costs no extra request. The read clock (a bar replay) is applied by the URL builder
// every read goes through, and the source declares its resolution so the host knows how far a
// reply taken at a cursor was final.

export interface DailyPoint {
  /** The bar's canonical date: 00:00 on the instrument's own clock, of its session. */
  date: number
  open: number
  high: number
  low: number
  close: number
}

export const DAILY_RESOLUTION = '1D'

const DAY_MS = 86_400_000
/** `/getbars` 413s past the server's cap; a chunk well under it, as the other bar readers use. */
const CHUNK_BARS = 4000
/** Slack on the left edge, so the first session of a year is never cut off by the hours
 * between a candle's open and the date it is filed under. */
const MARGIN_MS = 7 * DAY_MS

export function dailySourceKey(vendor: string, ticker: string): string {
  return `tradetalk-daily|${vendor}:${ticker}|${DAILY_RESOLUTION}`
}

/** The window the map needs: back to the start of the calendar year before the chart's own
 * first bar, so the previous year's candle is whole and the year in progress is complete
 * from its open. */
export function dailyWindow(range: Range): Range {
  const year = new Date(range.from).getUTCFullYear()
  const from = Date.UTC(year - 1, 0, 1) - MARGIN_MS
  return { from: Math.max(0, Math.min(from, range.from)), to: range.to }
}

export function dailySource(vendor: string, ticker: string): SourceSpec<DailyPoint> {
  const vendorSymbol = `${vendor}:${ticker}`
  return {
    id: 'daily',
    key: dailySourceKey(vendor, ticker),
    resolution: DAILY_RESOLUTION,
    window: dailyWindow,
    fetch: async (range: Range): Promise<Page<DailyPoint>> => {
      const to = Math.min(range.to, range.from + CHUNK_BARS * DAY_MS)
      const bars = await fetchBars(vendorSymbol, DAILY_RESOLUTION, range.from, to, null)
      return {
        points: bars.map((bar) => ({ date: bar.timestamp, open: bar.open, high: bar.high, low: bar.low, close: bar.close })),
        nextFrom: to < range.to ? to : null
      }
    }
  }
}
