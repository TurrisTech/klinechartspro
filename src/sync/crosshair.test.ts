import { describe, expect, test } from 'bun:test'
import type { Chart } from 'klinecharts'
import { crosshairPoint, crosshairReach, paneMainAt } from './crosshair'

// Click-to-scroll listens on the chart's root and asks which pane a click landed in, so that a
// click on an indicator sub-pane seeks the wall exactly as one on the candles does. Nodes are
// stand-ins: `contains` is the only thing the resolver asks of a pane's main element.

interface FakeNode {
  children: FakeNode[]
  contains(other: unknown): boolean
}

function node(...children: FakeNode[]): FakeNode {
  return {
    children,
    contains(other) {
      return other === this || this.children.some((child) => child.contains(other))
    }
  }
}

const candleCanvas = node()
const rsiCanvas = node()
const candleMain = node(candleCanvas)
const candleYAxis = node()
const rsiMain = node(rsiCanvas)
const xAxisMain = node()

function fakeChart(panes: Record<string, FakeNode>, convert?: (x: number, y?: number) => object): Chart {
  return {
    getPaneOptions: () => [...Object.keys(panes), 'x_axis_pane'].map((id) => ({ id })),
    getDom: (id: string, position: string) => {
      if (id === 'x_axis_pane') return xAxisMain
      if (position === 'yAxis' && id === 'candle_pane') return candleYAxis
      return panes[id] ?? null
    },
    convertFromPixel: ([c]: Array<{ x: number; y?: number }>) => [convert?.(c.x, c.y) ?? {}]
  } as unknown as Chart
}

describe('paneMainAt', () => {
  const chart = fakeChart({ candle_pane: candleMain, pane_1: rsiMain })

  test('a click on the candles resolves to candle_pane', () => {
    const hit = paneMainAt(chart, candleCanvas as unknown as Node)
    expect(hit?.paneId).toBe('candle_pane')
    expect(hit?.main).toBe(candleMain as unknown as HTMLElement)
  })

  test('a click on an indicator sub-pane resolves to that sub-pane', () => {
    const hit = paneMainAt(chart, rsiCanvas as unknown as Node)
    expect(hit?.paneId).toBe('pane_1')
    expect(hit?.main).toBe(rsiMain as unknown as HTMLElement)
  })

  test('a click outside every content pane main area resolves to nothing', () => {
    expect(paneMainAt(chart, candleYAxis as unknown as Node)).toBeUndefined()
    expect(paneMainAt(chart, xAxisMain as unknown as Node)).toBeUndefined()
    expect(paneMainAt(chart, null)).toBeUndefined()
  })

  test('a node from a sub-pane already removed resolves to nothing', () => {
    // The tooltip close icon removes its sub-pane on mousedown, before the click lands.
    const withoutRsi = fakeChart({ candle_pane: candleMain })
    expect(paneMainAt(withoutRsi, rsiCanvas as unknown as Node)).toBeUndefined()
  })
})

describe('crosshairPoint', () => {
  const chart = fakeChart({}, (_x, y) => (y === undefined ? { timestamp: 1000 } : { timestamp: 1000, value: 1.25 }))

  test('a sub-pane position carries the instant but never its y as a price', () => {
    expect(crosshairPoint(chart, { x: 10, y: 40, paneId: 'pane_1' })).toEqual({ timestamp: 1000 })
  })

  test('a candle_pane position carries the price too', () => {
    expect(crosshairPoint(chart, { x: 10, y: 40, paneId: 'candle_pane' })).toEqual({ timestamp: 1000, value: 1.25 })
  })
})

describe('crosshairReach', () => {
  const M = 60_000
  // A pane holding 60 one-minute bars, 600 px wide.
  const base = { first: 1_000 * M, last: 1_059 * M, periodMs: M, x: 300, width: 600, parked: false }

  test('an instant among the loaded bars, on screen, is shown', () => {
    expect(crosshairReach({ ...base, timestamp: 1_030 * M })).toEqual({ kind: 'shown' })
  })

  test('an instant before the first loaded bar is not held, whatever its x', () => {
    // On a 1D-to-5s wall this is the 5s pane under most 1D hovers: the line would sit far off
    // the left edge and the legend would read the first bar.
    expect(crosshairReach({ ...base, timestamp: 900 * M, x: -6_000 })).toEqual({ kind: 'away', side: 'left', reason: 'not-loaded' })
    expect(crosshairReach({ ...base, timestamp: 999 * M, x: 10 })).toEqual({ kind: 'away', side: 'left', reason: 'not-loaded' })
  })

  test('past the last bar is not held on a parked pane, and is the future on a live one', () => {
    expect(crosshairReach({ ...base, timestamp: 1_100 * M, x: 2_000, parked: true })).toEqual({
      kind: 'away',
      side: 'right',
      reason: 'not-loaded'
    })
    // Inside the parked pane's last bar: still that bar.
    expect(crosshairReach({ ...base, timestamp: 1_059 * M + 30_000, parked: true })).toEqual({ kind: 'shown' })
    // A live pane: drawn in the room right of the forming bar, as on the source...
    expect(crosshairReach({ ...base, timestamp: 1_061 * M, x: 590 })).toEqual({ kind: 'shown' })
    // ...or, beyond the room on the right, after the latest bar: no scroll reaches it.
    expect(crosshairReach({ ...base, timestamp: 1_061 * M, x: 900 })).toEqual({ kind: 'away', side: 'right', reason: 'after-latest' })
    // The forming bar itself, scrolled out of view, is merely off screen.
    expect(crosshairReach({ ...base, timestamp: 1_059 * M + 30_000, x: 900 })).toEqual({
      kind: 'away',
      side: 'right',
      reason: 'off-screen'
    })
  })

  test('a loaded instant scrolled out of view is off screen on its side', () => {
    expect(crosshairReach({ ...base, timestamp: 1_010 * M, x: -40 })).toEqual({ kind: 'away', side: 'left', reason: 'off-screen' })
    expect(crosshairReach({ ...base, timestamp: 1_050 * M, x: 640 })).toEqual({ kind: 'away', side: 'right', reason: 'off-screen' })
  })
})
