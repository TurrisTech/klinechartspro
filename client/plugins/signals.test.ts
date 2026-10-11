import { describe, expect, test } from 'bun:test'
import { installWindow } from './testing'

// The published-signals contract as the client consumes it: the AREV pane and the MTF overlay
// read the server's label rather than restating its rule -- except where a
// pre-`plugins.signals` server sends the old boolean, which `arevSignal` maps with that rule,
// once.
installWindow()
const { arevSignal } = await import('../arev/api')
const { matches } = await import('../tsregistry/api')
const { shiftSignals } = await import('../mtf/shift')
const { FX_GRID } = await import('../replay/timeframes')

import type { ArevPoint } from '../arev/api'

const point = (over: Partial<ArevPoint>): ArevPoint => ({
  date: 0,
  prediction: 0,
  n: 200,
  p: 0.5,
  confidence: 0,
  atCross: true,
  signal: null,
  ...over
})

describe('the label is read, not re-derived', () => {
  test('arevSignal passes a published label through and maps the old boolean by the server rule', () => {
    expect(arevSignal({ signal: 'long', p: 0.3 })).toBe('long')
    expect(arevSignal({ signal: 'short', p: 0.9 })).toBe('short')
    expect(arevSignal({ signal: null, p: 0.9 })).toBeNull()
    expect(arevSignal({ signal: false, p: 0.9 })).toBeNull()
    expect(arevSignal({ signal: true, p: 0.6 })).toBe('long')
    expect(arevSignal({ signal: true, p: 0.4 })).toBe('short')
  })
  test('the AREV pane marks exactly the labelled bars, whatever p did between them', () => {
    // The registry row's marks, as wtradingindicators declares them: each selects on the
    // server's published label, never on where p happens to sit. p is above the band on
    // both of the first two bars -- the old crossing rule drew one arrow (a red one), the
    // label rule draws a green one on the labelled bar and none on the unlabelled.
    const up = { field: 'signal', eq: 'long' }
    const down = { field: 'signal', eq: 'short' }
    expect(matches(up, point({ p: 0.6, signal: 'long' }))).toBe(true)
    expect(matches(up, point({ p: 0.62, signal: null }))).toBe(false)
    expect(matches(down, point({ p: 0.62, signal: null }))).toBe(false)
    expect(matches(down, point({ p: 0.4, signal: 'short' }))).toBe(true)
    expect(matches(up, undefined)).toBe(false)
  })
  test('the MTF overlay places a labelled vote and takes its direction from the label', () => {
    const H = 3_600_000
    const grid = [0, 4 * H, 8 * H, 12 * H]
    const chartBars = Array.from({ length: 13 }, (_, i) => ({ timestamp: i * H }) as never)
    const placed = shiftSignals({
      clock: FX_GRID,
      sourceInterval: '4h',
      chartInterval: '1h',
      points: [point({ date: 0, p: 0.4, signal: 'short' }), point({ date: 4 * H, p: 0.6, signal: null })],
      grid,
      chartBars
    })
    expect([...placed.keys()]).toEqual([4 * H])
    expect(placed.get(4 * H)?.[0]).toMatchObject({ sourceDate: 0, knownAt: 4 * H, up: false })
  })
})
