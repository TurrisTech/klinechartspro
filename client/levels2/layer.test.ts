import { afterEach, describe, expect, test } from 'bun:test'
import type { Chart, OverlayCreate } from 'klinecharts'
import type { ChartProPane, SymbolInfo } from '../../src'
import { fakePane, installWindow } from '../plugins/testing'
import type { ChartLayer, LayerWindow } from '../chartlayers/types'
import type { Levels2Config } from './config'
import type { Zone } from './api'

// Zones under a bar replay's read clock, through the real controller (chartlayers/controller.ts)
// and the real layer: a replay step that closes a bar of a timeframe the pane draws zones for
// re-reads them, because the server answers every zone as it stood at the clock
// (wdashboard-server services/levels2.py `clamp_zone_asof`) and a zone's role, its touches, its
// breaks and whether it is retired can all have moved at that close; a step that closes none
// re-reads nothing. Until 2026-11-28 a replay kept showing the zones as of where it started (or
// as of the five-minute fallback timer), whatever the steps did.

installWindow()

const { createLayerController } = await import('../chartlayers/controller')
const { levels2Layer } = await import('./layer')
const { DEFAULT_LEVELS2_CONFIG } = await import('./config')
const { getReadClock, setReadClock } = await import('../config')
const { FX_DAY } = await import('../time/timeframes')

const HOUR = 3_600_000
/** Wall clock in New York on Wednesday 14 January 2026, a market day in winter (UTC-5). */
const ny = (hour: number, minute = 0): number => Date.UTC(2026, 0, 14, hour + 5, minute)

/** A view samples its pane every 200ms; a little over one period, and the redraw. */
const SETTLE = 300
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const SYMBOL = {
  ticker: 'EURUSD',
  exchange: 'oanda',
  pricePrecision: 5,
  timezone: 'America/New_York',
  dayGeometry: FX_DAY
} as unknown as SymbolInfo

/** One 1h zone the server holds, broken by the 10:00 bar: the break is stamped at the open after
 * it, 11:00, and known from the bar's close at 11:00. Before then the server answers it as the
 * support it was born; from then on as the resistance the break made it. */
const BREAK_STAMP = ny(11)

function zoneAt(clock: number | null): Zone {
  const broken = clock === null || clock >= BREAK_STAMP
  return {
    interval: '1h',
    center: 1.095,
    low: 1.09,
    high: 1.1,
    direction: 'support',
    role: broken ? 'resistance' : 'support',
    bornAt: ny(2),
    effectiveAt: ny(3),
    retiredAt: null,
    touches: [],
    breaks: broken ? [BREAK_STAMP] : [],
    members: 1,
    score: 0,
    active: true,
    color: '#089981'
  }
}

interface Read {
  clock: number | null
  window: LayerWindow
}

interface TestChart {
  chart: Chart
  overlays: OverlayCreate[]
  /** A replay step as a pane sees it: a new bar, and klinecharts' range event. */
  step(): void
}

function testChart(lastOpen: number): TestChart {
  const bars = Array.from({ length: 50 }, (_, i) => ({ timestamp: lastOpen - (49 - i) * HOUR, open: 1.1, high: 1.12, low: 1.08, close: 1.1 }))
  const listeners = new Set<() => void>()
  const state: TestChart = {
    chart: null as unknown as Chart,
    overlays: [],
    step() {
      const last = bars[bars.length - 1]
      bars.push({ ...last, timestamp: last.timestamp + HOUR })
      for (const listener of listeners) listener()
    }
  }
  state.chart = {
    getIndicators: () => [{ id: 'z1', name: 'LEVELS:levels2', visible: true }],
    getDataList: () => bars,
    getVisibleRange: () => ({ from: 0, to: bars.length, realFrom: 0, realTo: bars.length - 1 }),
    getYAxes: () => [{ getRange: () => ({ from: 1.0, to: 1.2 }) }],
    createOverlay: (list: OverlayCreate[]) => {
      state.overlays.push(...list)
      return list.map(() => 'id')
    },
    removeOverlay: (filter: { groupId?: string }) => {
      state.overlays = state.overlays.filter((overlay) => overlay.groupId !== filter.groupId)
    },
    subscribeAction: (_type: string, listener: () => void) => listeners.add(listener),
    unsubscribeAction: (_type: string, listener: () => void) => listeners.delete(listener)
  } as unknown as Chart
  return state
}

let cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup) fn()
  cleanup = []
  setReadClock(null)
})

/** The real Zones layer on one pane, with the server stood in for: every read is recorded under
 * the clock it was sent at (what `apiGet` sends as `asof`) and answered as the server would. */
function setup(intervals: string[], clock: number) {
  setReadClock(clock)
  const reads: Read[] = []
  const layer: ChartLayer<Zone, Levels2Config> = {
    ...levels2Layer,
    available: () => true,
    debounceMs: 1,
    fetch: async (_ctx, _config, window) => {
      const at = getReadClock()
      reads.push({ clock: at, window })
      return [zoneAt(at)]
    }
  }
  const config: Levels2Config = {
    ...DEFAULT_LEVELS2_CONFIG,
    intervals: Object.fromEntries(Object.keys(DEFAULT_LEVELS2_CONFIG.intervals).map((code) => [code, intervals.includes(code)]))
  }
  const controller = createLayerController(layer, 'LEVELS:levels2')
  // The 1h pane's bars, through the one forming at the clock.
  const chart = testChart(clock - (clock % HOUR))
  const pane: ChartProPane = { ...fakePane('p1', chart.chart), getSymbol: () => SYMBOL }
  cleanup.push(controller.attach(pane, 'z1', config))
  const roles = (): string[] => chart.overlays.map((overlay) => (overlay.extendData as Zone).role)
  return { reads, chart, roles }
}

describe('Zones under a moving read clock', () => {
  test('a step that closes a bar of the zones drawn re-reads them, and draws them as of the new clock', async () => {
    const { reads, chart, roles } = setup(['1h'], ny(10, 15))
    await sleep(SETTLE)
    expect(reads.map((read) => read.clock)).toEqual([ny(10, 15)])
    expect(roles()).toEqual(['support'])
    // The 10:00 bar closes at 11:00, and the server now answers the zone as broken.
    setReadClock(ny(11))
    chart.step()
    await sleep(SETTLE)
    expect(reads.map((read) => read.clock)).toEqual([ny(10, 15), ny(11)])
    expect(roles()).toEqual(['resistance'])
  })

  test('a step inside the bar forming re-reads nothing', async () => {
    const { reads } = setup(['1h'], ny(10, 15))
    await sleep(SETTLE)
    setReadClock(ny(10, 45))
    await sleep(SETTLE)
    setReadClock(ny(10, 59))
    await sleep(SETTLE)
    expect(reads.map((read) => read.clock)).toEqual([ny(10, 15)])
  })

  test('only the timeframes drawn count: daily zones are re-read at the day close, not at every hour', async () => {
    const { reads, chart } = setup(['1D'], ny(10, 15))
    await sleep(SETTLE)
    for (const at of [ny(11), ny(12), ny(16, 59)]) {
      setReadClock(at)
      chart.step()
      await sleep(SETTLE)
    }
    expect(reads.map((read) => read.clock)).toEqual([ny(10, 15)])
    // The forex day closes at 17:00 New York.
    setReadClock(ny(17))
    chart.step()
    await sleep(SETTLE)
    expect(reads.map((read) => read.clock)).toEqual([ny(10, 15), ny(17)])
  })

  test('and with the clock standing still nothing is read again', async () => {
    const { reads } = setup(['1h', '4h', '1D', '1W'], ny(10, 15))
    await sleep(SETTLE * 3)
    expect(reads).toHaveLength(1)
  })
})
