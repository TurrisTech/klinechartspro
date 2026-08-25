import { describe, expect, test } from 'bun:test'
import { installWindow } from './testing'

// The published-signals contract as the client consumes it: the ref grammar, the URL a
// signals read builds, and that the two labelling plugins and the MTF overlay all read
// the server's label rather than restating its rule -- except where a pre-`plugins.signals`
// server sends the old boolean, which the normalisers map with that rule, once.
installWindow()
const { parseSignalRef, signalRef, signalsUrl } = await import('./api')
const { arevSignal } = await import('../arev/api')
const { krevSignal } = await import('../krev/api')
const { barValue } = await import('../arev/templates')
const { shiftSignals } = await import('../mtf/shift')

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

describe('signal refs', () => {
  test('round-trip, with an empty variant and an empty (every-label) id', () => {
    expect(signalRef('arev', 'arev21', 'long')).toBe('arev:arev21:long')
    expect(signalRef('fake', null)).toBe('fake::')
    expect(parseSignalRef('arev:arev21:long')).toEqual({ plugin: 'arev', variant: 'arev21', id: 'long' })
    expect(parseSignalRef('fake::go')).toEqual({ plugin: 'fake', variant: null, id: 'go' })
    expect(() => parseSignalRef('arev/long')).toThrow()
  })
  test('a signals read names the plugin in the path and the variant/label in the query', () => {
    const url = signalsUrl({ ref: 'arev:arev21:long', vendorSymbol: 'oanda:EURUSD', resolution: '4h', from: 1, to: 2, limit: 10 })
    expect(url.pathname).toEndWith('/plugins/arev/signals')
    expect(url.searchParams.get('variant')).toBe('arev21')
    expect(url.searchParams.get('signal')).toBe('long')
    const all = signalsUrl({ ref: 'arev:arev21:', vendorSymbol: 'EURUSD', resolution: '1h', from: 1, to: 2, limit: 10 })
    expect(all.searchParams.has('signal')).toBe(false)
  })
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
  test('krevSignal likewise, the side being the label', () => {
    expect(krevSignal({ signal: 'top', side: 'bottom' })).toBe('top')
    expect(krevSignal({ signal: true, side: 'bottom' })).toBe('bottom')
    expect(krevSignal({ signal: false, side: 'top' })).toBeNull()
  })
  test('the AREV pane marks exactly the labelled bars, whatever p did between them', () => {
    // p sits above the band on both bars: the old crossing rule drew one arrow (a red one);
    // the label rule draws a green one on each labelled bar and none on the unlabelled.
    expect(barValue(point({ p: 0.6, signal: 'long' })).mark).toBe('long')
    expect(barValue(point({ p: 0.62, signal: null })).mark).toBeUndefined()
    expect(barValue(point({ p: 0.4, signal: 'short' })).mark).toBe('short')
    expect(barValue(undefined)).toEqual({})
    expect(barValue(point({ p: 0.6 })).upper).toBeCloseTo(0.575)
  })
  test('the MTF overlay places a labelled vote and takes its direction from the label', () => {
    const H = 3_600_000
    const grid = [0, 4 * H, 8 * H, 12 * H]
    const chartBars = Array.from({ length: 13 }, (_, i) => ({ timestamp: i * H }) as never)
    const placed = shiftSignals({
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
