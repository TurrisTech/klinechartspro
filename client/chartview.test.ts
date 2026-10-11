import { describe, expect, test } from 'bun:test'
import { installWindow } from './plugins/testing'

installWindow()
const { onViewMoved } = await import('./chartview')
const { fakeChart } = await import('./plugins/testing')

// klinecharts announces a tick on the forming bar as a visible-range change; the subscribers
// that only care whether the view moved must not run once per tick.

describe('onViewMoved', () => {
  test('a tick on the forming bar is not a move; a new bar, a page of history and a release are', () => {
    const fc = fakeChart()
    fc.data = [1, 2, 3].map((timestamp) => ({ timestamp }))
    let calls = 0
    const release = onViewMoved(fc.chart, () => {
      calls++
    })
    fc.fireRange()
    expect(calls).toBe(1)
    // The forming bar's prices moved: same bars, same range.
    fc.fireRange()
    fc.fireRange()
    expect(calls).toBe(1)
    fc.data = [1, 2, 3, 4].map((timestamp) => ({ timestamp }))
    fc.fireRange()
    expect(calls).toBe(2)
    fc.data = [0, 1, 2, 3, 4].map((timestamp) => ({ timestamp }))
    fc.fireRange()
    expect(calls).toBe(3)
    release()
    fc.data = [5].map((timestamp) => ({ timestamp }))
    fc.fireRange()
    expect(calls).toBe(3)
  })
})
