import { describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'
import { installWindow } from '../plugins/testing'
import { FX_DAY } from '../replay/timeframes'

installWindow()
const { computeValues } = await import('./templates')
const { BarStore } = await import('./source')
const { VP_DEFAULTS } = await import('./config')
import type { SourceBar } from './atoms'
import type { ExtendData } from './templates'

// `calc`: source bars into chart bars on the instrument's own schedule, and chart bars into
// sessions. The wire dates daily bars carry are where a naive timestamp comparison goes wrong.

const H = 3_600_000
const NY = 'America/New_York'
const EQUITY_DAY = { openOffset: 9, closeOffset: 16, everyDayTrades: false }

let seq = 0
function extend(over: Partial<ExtendData>): ExtendData {
  seq++
  return {
    seriesKey: 'k',
    rev: 0,
    config: VP_DEFAULTS,
    cacheKey: `test-${seq}`,
    chart: '1h',
    source: null,
    chartShift: 0,
    sourceShift: 0,
    schedule: null,
    clock: null,
    tick: 0.00001,
    quantumKey: `q-${seq}`,
    ...over
  }
}

function kline(timestamp: number, volume: number): KLineData {
  return { timestamp, open: 1.1, high: 1.102, low: 1.098, close: 1.101, volume }
}

function src(date: number, volume = 1): SourceBar {
  return { date, open: 1.1, high: 1.1015, low: 1.0985, close: 1.1005, volume }
}

function storeOf(key: string, bars: SourceBar[]) {
  const s = new BarStore(key)
  s.ingest(bars, { from: bars[0].date, to: bars[bars.length - 1].date + 1 })
  return s
}

describe('source bars onto a daily chart', () => {
  test("forex: the Sunday 17:00 New York hour belongs to Monday's session", () => {
    // Monday 2026-09-14's session opens Sunday 21:00Z; its wire date is 7h later.
    const mondayOpen = Date.UTC(2026, 8, 13, 21)
    const hours = Array.from({ length: 48 }, (_, i) => src(mondayOpen + i * H, i === 0 ? 100 : 1))
    const chart = [kline(mondayOpen + 7 * H, 123), kline(mondayOpen + 24 * H + 7 * H, 24)]
    const e = extend({ chart: '1D', source: '1h', chartShift: 7 * H, schedule: { timezone: NY, day: FX_DAY }, seriesKey: 'fx' })
    const out = computeValues(chart, e, storeOf('fx', hours))
    expect(out.map((v) => v.atoms?.total)).toEqual([123, 24])
    expect(out.map((v) => v.atoms?.coarse)).toEqual([0, 0])
  })

  test('equities: a 09:00-anchored day holds the 09:30 to 16:00 bars, dated 9h before its open', () => {
    // Tuesday 2026-09-15: wire date 00:00 New York (04:00Z), open 09:00 (13:00Z).
    const wire = Date.UTC(2026, 8, 15, 4)
    const halfHours = Array.from({ length: 13 }, (_, i) => src(Date.UTC(2026, 8, 15, 13, 30) + i * 30 * 60_000))
    const e = extend({ chart: '1D', source: '30m', chartShift: -9 * H, schedule: { timezone: NY, day: EQUITY_DAY }, seriesKey: 'eq' })
    const out = computeValues([kline(wire, 13)], e, storeOf('eq', halfHours))
    expect(out[0].atoms?.total).toBe(13)
    expect(out[0].atoms?.coarse).toBe(0)
  })

  test('a daily chart without a schedule maps nothing rather than guessing a zone', () => {
    const out = computeValues([kline(Date.UTC(2026, 8, 15, 4), 10)], extend({ chart: '1D', chartShift: null }), undefined)
    expect(out[0].atoms).toBeNull()
  })
})

describe("the chart's own bars as the source", () => {
  test('every unit of their volume, all of it marked as coming from the chart bar', () => {
    const out = computeValues([kline(0, 5), kline(H, 7)], extend({}), undefined)
    expect(out.map((v) => [v.atoms?.total, v.atoms?.coarse])).toEqual([
      [5, 5],
      [7, 7]
    ])
  })
})

describe('sessions', () => {
  test("an hourly forex chart changes session at 17:00 New York, not at midnight", () => {
    // Monday 2026-09-14, 15:00 to 18:00 New York (EDT, 19:00Z to 22:00Z).
    const chart = [19, 20, 21, 22].map((h) => kline(Date.UTC(2026, 8, 14, h), 1))
    const config = { ...VP_DEFAULTS, mode: 'session' as const }
    const e = extend({ config, clock: { timezone: NY, openOffset: -7, sessionDated: false } })
    const keys = computeValues(chart, e, undefined).map((v) => v.session)
    expect(keys[0]).toBe(keys[1])
    expect(keys[2]).toBe(keys[3])
    expect(keys[2]).toBe(keys[1] + 1)
  })

  test('weekly sessions group Monday to Friday', () => {
    const chart = [14, 15, 16, 17, 18, 21].map((d) => kline(Date.UTC(2026, 8, d, 14), 1))
    const config = { ...VP_DEFAULTS, mode: 'session' as const, session: 'W' as const }
    const e = extend({ config, clock: { timezone: NY, openOffset: -7, sessionDated: false } })
    const keys = computeValues(chart, e, undefined).map((v) => v.session)
    expect(new Set(keys.slice(0, 5)).size).toBe(1)
    expect(keys[5]).toBe(keys[0] + 1)
  })

  test('no session is claimed in visible mode, or without a clock', () => {
    const out = computeValues([kline(0, 1)], extend({ config: { ...VP_DEFAULTS, mode: 'session' } }), undefined)
    expect(Number.isNaN(out[0].session)).toBe(true)
  })
})
