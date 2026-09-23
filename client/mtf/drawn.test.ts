import { afterEach, describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// What the overlay publishes about what it drew, and the three answers `drawsSignal` gives --
// drawn, not drawn, and "nobody can say". The replay's "next signal" skips only the middle one,
// so the difference between the last two is the whole point of the module.
installWindow()
const { drawsSignal, publishDrawn, resetDrawn, signalKey } = await import('./drawn')

const REF = 'arev21_outlier:arev21_outlier_rank:long'
const SYM = 'oanda:EURUSD'
const H = 3_600_000

const pane = (over: Partial<Parameters<typeof publishDrawn>[1] & object> = {}) => ({
  symbol: SYM,
  plugin: 'arev21_outlier',
  variant: 'arev21_outlier_rank',
  intervals: ['1h', '4h'] as const,
  drawn: new Set([signalKey('4h', 100)]),
  known: new Set([signalKey('4h', 100), signalKey('4h', 200)]),
  coversTo: 10 * H,
  ...over
})

afterEach(() => resetDrawn())

describe('drawsSignal', () => {
  test('drawn, hidden, and a timeframe the pane does not draw at all', () => {
    publishDrawn('p1', pane())
    expect(drawsSignal(SYM, REF, '4h', 100, 1 * H)).toBe(true)
    // Placed and then filtered out by "hide signals outside the graph".
    expect(drawsSignal(SYM, REF, '4h', 200, 1 * H)).toBe(false)
    // 1D is not among the timeframes this pane draws.
    expect(drawsSignal(SYM, REF, '1D', 300, 1 * H)).toBe(false)
    // A 4h bar it has never placed: it cannot say, so nothing is skipped on its account.
    expect(drawsSignal(SYM, REF, '4h', 999, 1 * H)).toBeNull()
  })

  test('nothing can say for another instrument, another plugin, or an empty wall', () => {
    publishDrawn('p1', pane())
    expect(drawsSignal('oanda:GBPUSD', REF, '4h', 200, 1 * H)).toBeNull()
    expect(drawsSignal(SYM, 'arev:arev21:long', '4h', 200, 1 * H)).toBeNull()
    resetDrawn()
    expect(drawsSignal(SYM, REF, '4h', 100, 1 * H)).toBeNull()
  })

  test('a pane whose data stops short of the signal cannot say -- which also retires a stale one', () => {
    publishDrawn('p1', pane({ coversTo: 2 * H }))
    expect(drawsSignal(SYM, REF, '4h', 200, 1 * H)).toBe(false)
    // The replay has moved past what that pane last held: no answer rather than a stale one.
    expect(drawsSignal(SYM, REF, '4h', 200, 3 * H)).toBeNull()
  })

  test('one pane drawing it is enough, whatever the others say', () => {
    publishDrawn('p1', pane({ intervals: ['1h'] as const, drawn: new Set(), known: new Set() }))
    publishDrawn('p2', pane())
    expect(drawsSignal(SYM, REF, '4h', 100, 1 * H)).toBe(true)
    // Neither pane draws this one, and both could have: not drawn.
    expect(drawsSignal(SYM, REF, '4h', 200, 1 * H)).toBe(false)
  })

  test('the instrument is compared without regard to case', () => {
    publishDrawn('p1', pane({ symbol: 'oanda:EURUSD' }))
    expect(drawsSignal('OANDA:EURUSD', REF, '4h', 100, 1 * H)).toBe(true)
  })
})
