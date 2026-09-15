import { describe, expect, test } from 'bun:test'
import type { Chart } from 'klinecharts'
import { crosshairPoint, paneMainAt } from './crosshair'

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
