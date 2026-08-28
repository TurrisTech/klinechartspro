import { describe, expect, it } from 'bun:test'
import {
  AXIS_CLEARANCE,
  clampDockHeight,
  clampPosition,
  clampSize,
  defaultPosition,
  DOCK_ZONE,
  EDGE_MARGIN,
  inDropZone,
  MAX_DOCK_FRACTION
} from './window'

// The dockable window's geometry. The rest of window.ts is DOM.

const CHART = { left: 40, top: 60, right: 1240, bottom: 860 }
const SIZE = { width: 320, height: 140 }
const MIN = { width: 260, height: 120 }

describe('clampPosition', () => {
  it('leaves a position that is already inside alone', () => {
    expect(clampPosition({ x: 300, y: 300 }, SIZE, CHART)).toEqual({ x: 300, y: 300 })
  })

  it('pulls a window back inside each edge', () => {
    expect(clampPosition({ x: -500, y: -500 }, SIZE, CHART)).toEqual({ x: 48, y: 68 })
    expect(clampPosition({ x: 5000, y: 5000 }, SIZE, CHART)).toEqual({
      x: CHART.right - EDGE_MARGIN - SIZE.width,
      y: CHART.bottom - EDGE_MARGIN - SIZE.height
    })
  })

  it('pins a window bigger than its bounds to the top-left rather than off the far side', () => {
    const huge = { width: 4000, height: 4000 }
    expect(clampPosition({ x: 900, y: 900 }, huge, CHART)).toEqual({ x: 48, y: 68 })
  })

  it('follows the bounds when a window docks under the chart', () => {
    // #app shrinks by the dock column's height; a window resting on the old bottom edge moves up.
    const resting = clampPosition({ x: 300, y: 5000 }, SIZE, CHART)
    const shrunk = { ...CHART, bottom: 500 }
    expect(clampPosition(resting, SIZE, shrunk)).toEqual({ x: 300, y: 500 - EDGE_MARGIN - SIZE.height })
  })
})

describe('defaultPosition', () => {
  it('opens centred on the bottom of the chart, clear of the time axis', () => {
    const pos = defaultPosition(SIZE, CHART)
    expect(pos.x + SIZE.width / 2).toBe((CHART.left + CHART.right) / 2)
    expect(pos.y).toBe(CHART.bottom - SIZE.height - AXIS_CLEARANCE)
  })

  it('centres a large window instead, clear of the strip the small ones anchor to', () => {
    const big = { width: 820, height: 380 }
    const pos = defaultPosition(big, CHART, 'center')
    expect(pos.y + big.height / 2).toBe((CHART.top + CHART.bottom) / 2)
    // …and clear of a bottom-anchored window of the usual size.
    expect(pos.y + big.height).toBeLessThan(defaultPosition(SIZE, CHART).y)
  })

  it('is itself clamped, so a short chart still shows the whole window', () => {
    const short = { left: 0, top: 0, right: 400, bottom: 150 }
    const pos = defaultPosition(SIZE, short)
    expect(pos.y).toBeGreaterThanOrEqual(short.top + EDGE_MARGIN)
    expect(pos.y + SIZE.height).toBeLessThanOrEqual(short.bottom)
  })
})

describe('clampSize', () => {
  const origin = { x: 200, y: 200 }

  it('passes a size that fits straight through', () => {
    expect(clampSize({ width: 600, height: 400 }, origin, CHART, MIN)).toEqual({ width: 600, height: 400 })
  })

  it('never goes below the minimum, however far the drag went', () => {
    expect(clampSize({ width: 10, height: -200 }, origin, CHART, MIN)).toEqual(MIN)
  })

  it('stops at the far edge, because resizing does not move the window', () => {
    const grown = clampSize({ width: 9999, height: 9999 }, origin, CHART, MIN)
    expect(origin.x + grown.width).toBe(CHART.right - EDGE_MARGIN)
    expect(origin.y + grown.height).toBe(CHART.bottom - EDGE_MARGIN)
  })

  it('keeps the minimum even when the window starts outside the bounds', () => {
    expect(clampSize({ width: 500, height: 500 }, { x: 5000, y: 5000 }, CHART, MIN)).toEqual(MIN)
  })
})

describe('clampDockHeight', () => {
  it('leaves the chart at least 1 - MAX_DOCK_FRACTION of the page', () => {
    expect(clampDockHeight(5000, 1000)).toBe(1000 * MAX_DOCK_FRACTION)
  })

  it('has a floor, so a drag to the bottom does not collapse the window to its title bar', () => {
    expect(clampDockHeight(0, 1000, 120)).toBe(120)
  })

  it('honours the floor even on a page too short to give it the fraction', () => {
    expect(clampDockHeight(0, 100, 120)).toBe(120)
  })
})

describe('inDropZone', () => {
  it('is the strip along the bottom of the chart', () => {
    expect(inDropZone(CHART.bottom - 1, CHART)).toBe(true)
    expect(inDropZone(CHART.bottom - DOCK_ZONE, CHART)).toBe(true)
    expect(inDropZone(CHART.bottom - DOCK_ZONE - 1, CHART)).toBe(false)
  })

  it('does not follow the pointer past the chart, onto an already docked window', () => {
    expect(inDropZone(CHART.bottom + 40, CHART)).toBe(false)
  })
})
