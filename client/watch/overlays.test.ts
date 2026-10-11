import { describe, expect, test } from 'bun:test'
import type { OverlayCreate } from 'klinecharts'
import { installWindow } from '../plugins/testing'
import type { Watch } from './types'

installWindow()
const { WatchOverlays } = await import('./overlays')
const { fakeChart, fakePane } = await import('../plugins/testing')
const { PRICE_FIELD, PRICE_SOURCE } = await import('./types')

// A watch line is anchored to the pane's oldest bar, so it is redrawn when that bar, the pane's
// instrument or the watches change -- and not on every tick, which klinecharts announces as a
// visible-range change like any other: rebuilding every line per tick was a teardown and a
// repaint of the overlay layer per tick, and could take a line out from under a drag.

function watch(level: number): Watch {
  return {
    id: `w${level}`,
    source: PRICE_SOURCE,
    target: 'oanda:EURUSD',
    condition: { field: PRICE_FIELD, op: 'gte', value: level },
    createdAt: level,
    status: 'armed',
    enabled: true
  } as unknown as Watch
}

describe('the watch lines', () => {
  test('are rebuilt when the anchor or the watches change, not on a tick', () => {
    const fc = fakeChart()
    fc.data = [1, 2, 3].map((timestamp) => ({ timestamp }))
    let created = 0
    const chart = fc.chart as unknown as Record<string, unknown>
    chart.createOverlay = (overlay: OverlayCreate) => {
      created++
      return overlay.name
    }
    chart.removeOverlay = () => true
    const overlays = new WatchOverlays({ onDragEnd() {} })
    overlays.sync([fakePane('p1', fc.chart)])
    overlays.update([watch(1.1), watch(1.2)])
    expect(created).toBe(2)
    fc.fireRange()
    fc.fireRange()
    expect(created).toBe(2)
    // A page of history moves the anchor.
    fc.data = [0, 1, 2, 3].map((timestamp) => ({ timestamp }))
    fc.fireRange()
    expect(created).toBe(4)
    overlays.update([watch(1.1)])
    expect(created).toBe(5)
    overlays.teardown()
  })
})
