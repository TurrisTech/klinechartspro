import { describe, expect, test } from 'bun:test'
import type { OverlayCreate } from 'klinecharts'
import { overlaySignature } from './paint'

// The gate that stops a live chart tearing down and rebuilding several hundred overlays a
// second for lines that have not moved. Two properties matter and they pull opposite ways:
// it must be blind to nothing that shows on the chart, and it must be blind to everything
// that doesn't.

function line(timestamp: number, value: number, over: Partial<OverlayCreate> = {}): OverlayCreate {
  return {
    name: 'horizontalSegment',
    paneId: 'candle_pane',
    lock: true,
    points: [
      { timestamp, value },
      { timestamp: timestamp + 1000, value }
    ],
    styles: { line: { style: 'dashed', dashedValue: [6, 4], size: 1, color: 'rgba(8, 153, 129, 1)' } },
    ...over
  }
}

describe('overlaySignature', () => {
  test('the same overlays give the same signature', () => {
    const a = [line(1000, 1.1), line(2000, 1.2)]
    const b = [line(1000, 1.1), line(2000, 1.2)]
    expect(overlaySignature(a)).toBe(overlaySignature(b))
  })

  test('nothing drawn is the empty signature -- the same state clearOverlays leaves', () => {
    expect(overlaySignature([])).toBe('')
  })

  test('every visible difference changes it', () => {
    const base = overlaySignature([line(1000, 1.1)])
    expect(overlaySignature([line(1001, 1.1)])).not.toBe(base) // moved in time
    expect(overlaySignature([line(1000, 1.10001)])).not.toBe(base) // moved in price
    expect(overlaySignature([line(1000, 1.1, { name: 'horizontalRayLine' })])).not.toBe(base)
    expect(overlaySignature([line(1000, 1.1, { paneId: 'pane_1' })])).not.toBe(base)
    expect(
      overlaySignature([
        line(1000, 1.1, {
          styles: { line: { style: 'solid', dashedValue: [], size: 1, color: 'rgba(8, 153, 129, 1)' } }
        })
      ])
    ).not.toBe(base) // pattern
    expect(
      overlaySignature([
        line(1000, 1.1, {
          styles: { line: { style: 'dashed', dashedValue: [6, 4], size: 3, color: 'rgba(8, 153, 129, 1)' } }
        })
      ])
    ).not.toBe(base) // width, which is how the invalidation-count emphasis reads
    expect(
      overlaySignature([
        line(1000, 1.1, {
          styles: { line: { style: 'dashed', dashedValue: [6, 4], size: 1, color: 'rgba(8, 153, 129, 0.9)' } }
        })
      ])
    ).not.toBe(base) // alpha, which is how the age emphasis reads
  })

  test('adding, removing or reordering an overlay changes it', () => {
    const base = overlaySignature([line(1000, 1.1)])
    expect(overlaySignature([line(1000, 1.1), line(2000, 1.2)])).not.toBe(base)
    expect(overlaySignature([line(2000, 1.2), line(1000, 1.1)])).not.toBe(
      overlaySignature([line(1000, 1.1), line(2000, 1.2)])
    )
  })

  test('extendData is not part of it -- nobody can see the datum stashed on an overlay', () => {
    const withDatum = line(1000, 1.1, { extendData: { price: 1.1, note: 'anything' } })
    expect(overlaySignature([withDatum])).toBe(overlaySignature([line(1000, 1.1)]))
  })

  test('an overlay with no points or styles is still distinguishable', () => {
    const bare = { name: 'horizontalRayLine', paneId: 'candle_pane' } as OverlayCreate
    expect(overlaySignature([bare])).not.toBe('')
    expect(overlaySignature([bare])).not.toBe(overlaySignature([line(1000, 1.1)]))
  })
})
