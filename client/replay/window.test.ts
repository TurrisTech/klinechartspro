import { describe, expect, it } from 'bun:test'
import { AXIS_CLEARANCE, clampPosition, defaultPosition, EDGE_MARGIN } from './window'

// The floating window's geometry. The rest of window.ts is DOM.

const CHART = { left: 40, top: 60, right: 1240, bottom: 860 }
const SIZE = { width: 320, height: 140 }

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

  it('follows the bounds when the dock opens under the chart', () => {
    // #app shrinks by the dock's height; a window resting on the old bottom edge moves up.
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

  it('is itself clamped, so a short chart still shows the whole window', () => {
    const short = { left: 0, top: 0, right: 400, bottom: 150 }
    const pos = defaultPosition(SIZE, short)
    expect(pos.y).toBeGreaterThanOrEqual(short.top + EDGE_MARGIN)
    expect(pos.y + SIZE.height).toBeLessThanOrEqual(short.bottom)
  })
})
