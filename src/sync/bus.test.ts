import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Chart } from 'klinecharts'
import { type Measurement, SyncBus, type SyncPane } from './bus'
import { type PaneClock, paneClock } from './clock'
import type { CrosshairPoint } from './crosshair'

// The ruler's channel on the bus: one measurement for the whole wall, handed to every pane
// (the one dragging it included) so each decides for itself whether it is on the instrument.

function fakePane(id: string): SyncPane & { shown: Array<Measurement | null> } {
  const shown: Array<Measurement | null> = []
  return {
    id,
    shown,
    getChart: () => null,
    getPeriodMs: () => 3_600_000,
    getClock: () => ({ sessionDated: false, labelShiftMs: 0 }),
    seekTo: () => {},
    showMeasurement: (measurement) => { shown.push(measurement) },
    showCrosshair: () => {}
  }
}

const EURUSD = { ticker: 'EURUSD', exchange: 'oanda' }

function measurement(sourceId: string, to = 1.1): Measurement {
  return {
    sourceId,
    symbol: EURUSD,
    points: [{ timestamp: 1_000, value: 1.0 }, { timestamp: 2_000, value: to }],
    clock: { sessionDated: false, labelShiftMs: 0 }
  }
}

describe('SyncBus measurement', () => {
  test('reaches every pane, the source included', () => {
    const bus = new SyncBus()
    const a = fakePane('a')
    const b = fakePane('b')
    bus.register(a)
    bus.register(b)
    const m = measurement('a')
    bus.setMeasurement(m)
    expect(a.shown).toEqual([m])
    expect(b.shown).toEqual([m])
    expect(bus.getMeasurement()).toBe(m)
  })

  test('each move of the drag is passed on', () => {
    const bus = new SyncBus()
    const b = fakePane('b')
    bus.register(b)
    bus.setMeasurement(measurement('a', 1.1))
    bus.setMeasurement(measurement('a', 1.2))
    expect(b.shown.map((m) => m?.points[1].value)).toEqual([1.1, 1.2])
  })

  test('clearing tells every pane once, and clearing nothing tells no one', () => {
    const bus = new SyncBus()
    const a = fakePane('a')
    bus.register(a)
    bus.setMeasurement(null)
    expect(a.shown).toEqual([])
    bus.setMeasurement(measurement('a'))
    bus.setMeasurement(null)
    bus.setMeasurement(null)
    expect(a.shown.at(-1)).toBeNull()
    expect(a.shown.length).toBe(2)
    expect(bus.getMeasurement()).toBeNull()
  })

  test('a pane added to the wall while a measurement is up shows it', () => {
    const bus = new SyncBus()
    const m = measurement('a')
    bus.register(fakePane('a'))
    bus.setMeasurement(m)
    const late = fakePane('late')
    bus.register(late)
    expect(late.shown).toEqual([m])
    const empty = new SyncBus()
    const quiet = fakePane('quiet')
    empty.register(quiet)
    expect(quiet.shown).toEqual([])
  })

  test('the source leaving the wall takes its measurement with it; another pane leaving does not', () => {
    const bus = new SyncBus()
    const a = fakePane('a')
    const b = fakePane('b')
    const c = fakePane('c')
    for (const pane of [a, b, c]) bus.register(pane)
    bus.setMeasurement(measurement('a'))
    bus.unregister('b')
    expect(bus.getMeasurement()).not.toBeNull()
    bus.unregister('a')
    expect(bus.getMeasurement()).toBeNull()
    expect(c.shown.at(-1)).toBeNull()
    // The pane already gone is not drawn on.
    expect(b.shown.length).toBe(1)
  })
})

// Every instant the bus carries is read on the source pane's bar clock and restated on each
// target's (src/sync/clock.ts): an FX daily bar is labelled 00:00 New York on its session date,
// and reaches an intraday pane as the 17:00 the evening before, when the candle opened.

const FX = { dayGeometry: { openOffset: -7, closeOffset: 17, everyDayTrades: false } }
const CRYPTO = { dayGeometry: { openOffset: 0, closeOffset: 24, everyDayTrades: true } }
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
// EURUSD's session dated 2026-10-09: labelled 00:00 EDT on the 9th, opened 17:00 EDT on the 8th.
const LABEL_OCT9 = Date.parse('2026-10-09T04:00:00Z')
const OPEN_OCT9 = Date.parse('2026-10-08T21:00:00Z')

// A chart as far as the bus reads one: its bars, its width, and a linear timestamp -> x scale.
function fakeChart(bars: number[], originMs: number, msPerPx: number): Chart & { scrolledTo: number[] } {
  const scrolledTo: number[] = []
  const toX = (timestamp: number) => (timestamp - originMs) / msPerPx
  return {
    scrolledTo,
    getDataList: () => bars.map((timestamp) => ({ timestamp })),
    getSize: () => ({ width: 1000, height: 500, left: 0, top: 0, right: 0, bottom: 0 }),
    convertToPixel: ({ timestamp }: { timestamp: number }) => ({ x: toX(timestamp) }),
    scrollByDistance: (distance: number) => {
      scrolledTo.push(originMs + (500 - distance) * msPerPx)
    }
  } as unknown as Chart & { scrolledTo: number[] }
}

function clockedPane(
  id: string,
  clock: PaneClock,
  periodMs: number,
  chart: Chart | null = null
): SyncPane & { crosshairs: Array<CrosshairPoint | null> } {
  const crosshairs: Array<CrosshairPoint | null> = []
  return {
    id,
    crosshairs,
    getChart: () => chart,
    getPeriodMs: () => periodMs,
    getClock: () => clock,
    seekTo: () => {},
    showMeasurement: () => {},
    showCrosshair: (point) => { crosshairs.push(point) }
  }
}

describe('SyncBus across bar clocks', () => {
  // The bus dispatches on animation frames; these tests run them by hand.
  let frames: FrameRequestCallback[] = []
  const realRaf = globalThis.requestAnimationFrame
  beforeEach(() => {
    frames = []
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => frames.push(callback)) as typeof requestAnimationFrame
  })
  afterEach(() => {
    globalThis.requestAnimationFrame = realRaf
  })
  const flush = () => {
    const run = frames
    frames = []
    for (const callback of run) callback(0)
  }

  test('a daily hover reaches an hourly pane at the candle\'s open, and a daily pane at its date', () => {
    const bus = new SyncBus()
    const daily = clockedPane('d', paneClock({ timespan: 'day' }, FX), DAY_MS)
    const hourly = clockedPane('h', paneClock({ timespan: 'hour' }, FX), HOUR_MS)
    const btcDaily = clockedPane('btc', paneClock({ timespan: 'day' }, CRYPTO), DAY_MS)
    for (const pane of [daily, hourly, btcDaily]) bus.register(pane)
    bus.broadcastCrosshair('d', { timestamp: LABEL_OCT9, value: 1.1 })
    flush()
    expect(hourly.crosshairs).toEqual([{ timestamp: OPEN_OCT9, value: 1.1 }])
    expect(btcDaily.crosshairs).toEqual([{ timestamp: LABEL_OCT9, value: 1.1 }])
    expect(daily.crosshairs).toEqual([])
  })

  test('an hourly hover after 17:00 reaches the daily pane inside the next session date', () => {
    const bus = new SyncBus()
    const daily = clockedPane('d', paneClock({ timespan: 'day' }, FX), DAY_MS)
    bus.register(daily)
    bus.register(clockedPane('h', paneClock({ timespan: 'hour' }, FX), HOUR_MS))
    bus.broadcastCrosshair('h', { timestamp: OPEN_OCT9 + HOUR_MS })
    flush()
    expect(daily.crosshairs).toEqual([{ timestamp: LABEL_OCT9 + HOUR_MS }])
  })

  test('a click on a daily bar marks its open on an hourly pane, and centres the candle\'s span', () => {
    const bus = new SyncBus()
    const dailyChart = fakeChart([LABEL_OCT9 - DAY_MS, LABEL_OCT9, LABEL_OCT9 + DAY_MS], LABEL_OCT9 - 3 * DAY_MS, DAY_MS / 100)
    // An hourly pane holding 10-07 through 10-10, ten pixels an hour from 10-08 00:00 EDT: the
    // candle 10-08 17:00 -> 10-09 17:00 is 240 px and fits.
    const origin = Date.parse('2026-10-08T04:00:00Z')
    const hourlyChart = fakeChart([origin - DAY_MS, origin + 2 * DAY_MS], origin, HOUR_MS / 10)
    bus.register(clockedPane('d', paneClock({ timespan: 'day' }, FX), DAY_MS, dailyChart))
    const hourly = clockedPane('h', paneClock({ timespan: 'hour' }, FX), HOUR_MS, hourlyChart)
    bus.register(hourly)
    bus.broadcastSeek('d', { timestamp: LABEL_OCT9, value: 1.1 }, 0.5)
    flush()
    expect(hourly.crosshairs).toEqual([{ timestamp: OPEN_OCT9, value: 1.1 }])
  })

  test('an auto-sync pan on a daily pane aligns an hourly pane on the same instant', () => {
    const bus = new SyncBus()
    bus.setOptions({ crosshair: true, time: true, auto: true })
    const origin = Date.parse('2026-10-08T04:00:00Z')
    const hourlyChart = fakeChart([origin - DAY_MS, origin + 2 * DAY_MS], origin, HOUR_MS / 10)
    bus.register(clockedPane('d', paneClock({ timespan: 'day' }, FX), DAY_MS))
    bus.register(clockedPane('h', paneClock({ timespan: 'hour' }, FX), HOUR_MS, hourlyChart))
    bus.broadcastPan('d', LABEL_OCT9)
    flush()
    expect(hourlyChart.scrolledTo).toEqual([OPEN_OCT9])
  })
})
