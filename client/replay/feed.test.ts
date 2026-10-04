import { afterAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { KLineData } from 'klinecharts'
import type { ChartProPane, SymbolInfo } from '../../src'
import type { BarSource, Columns, ReplayBar } from './cache'
import { CONTINUOUS_DAY, type CandleGrid } from './timeframes'

// feed.ts reaches config.ts, which reads `window` at import: a DOM for this file only.
GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())
const { ReplayFeedHub } = await import('./feed')
const { resolutionToPeriod } = await import('../periods')

// THE HUB ON ANOTHER MARKET'S CLOCK. Every pane is brought up to the cursor on the schedule of
// the instrument IT shows, so a coinbase pane's forming day is labelled at UTC midnight -- the
// label /getbars gives the whole bar -- and not at the FX week's 17:00 New York. A pane whose
// instrument has no resolved market hours gets no guessed label at all.

const H = 3_600_000
const UTC = (d: number, h = 0): number => Date.UTC(2024, 2, d, h)

/** One bar per hour for the base, one per UTC day for the pane, labelled on the given grid. */
class CryptoSource implements BarSource {
  async fetch(_symbol: string, interval: string, from: number, to: number, _columns: Columns, grid: CandleGrid): Promise<ReplayBar[]> {
    const out: ReplayBar[] = []
    for (let open = grid.start(interval, from); open < to; open = grid.nextStart(interval, open)) {
      if (open < from) continue
      out.push({ open, end: grid.end(interval, open), date: grid.toWire(interval, open), o: 1, h: 2, l: 0.5, c: 1.5, v: 10 })
    }
    return out
  }
}

/** A pane over a chart that keeps klinecharts' updateData semantics: a bar at the last bar's
 * timestamp replaces it, a newer one is appended. */
function pane(symbol: Partial<SymbolInfo>, interval: string, bars: KLineData[]): { pane: ChartProPane; data: KLineData[] } {
  const data = [...bars]
  const callback = (bar: KLineData): void => {
    if (data.at(-1)?.timestamp === bar.timestamp) data[data.length - 1] = bar
    else data.push(bar)
  }
  const fake = {
    id: 'p1',
    getSymbol: () => ({ ticker: 'BTCUSD', exchange: 'coinbase', ...symbol }) as SymbolInfo,
    getPeriod: () => resolutionToPeriod(interval),
    getDatafeed: () => ({ callbackFor: () => callback }),
    getChart: () => ({ getDataList: () => data, resetData: () => {} })
  }
  return { pane: fake as unknown as ChartProPane, data }
}

const bar = (timestamp: number): KLineData => ({ timestamp, open: 1, high: 1, low: 1, close: 1, volume: 1 })

describe('ReplayFeedHub on a pane\'s own schedule', () => {
  test('a coinbase daily pane forms Saturday\'s candle from UTC midnight, and labels it there', async () => {
    const cursor = UTC(9, 12) // Saturday 12:00 UTC -- inside the FX weekend, a trading day here
    const hub = new ReplayFeedHub(new CryptoSource(), '1h', cursor)
    const { pane: p, data } = pane({ timezone: 'UTC', dayGeometry: CONTINUOUS_DAY }, '1D', [bar(UTC(8))])
    const [report] = await hub.push([p], cursor - H)
    expect(report.problem).toBeNull()
    expect(report.forming).toBe(true)
    // Friday's whole bar (closed at Saturday 00:00) and Saturday's forming one, from 12 hours.
    expect(data.map((b) => b.timestamp)).toEqual([UTC(8), UTC(9)])
    expect(data[1].volume).toBe(12 * 10)
  })

  test('a pane whose instrument has no market hours is refused, not labelled on a guess', async () => {
    const cursor = UTC(9, 12)
    const hub = new ReplayFeedHub(new CryptoSource(), '1h', cursor)
    const { pane: p, data } = pane({}, '1D', [bar(UTC(8))])
    const [report] = await hub.push([p], cursor - H)
    expect(report.problem).toBe('no market hours for coinbase:BTCUSD')
    expect(data.map((b) => b.timestamp)).toEqual([UTC(8)])
  })
})
