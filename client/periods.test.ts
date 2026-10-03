import { afterAll, describe, expect, test } from 'bun:test'
import { periodDurationMs, periodFor } from '../src/utils/period'
import type { Period } from '../src'
import type { Capabilities } from './capabilities'

// `window` does not exist under bun, and client/config.ts reads it at MODULE LOAD -- this
// module reaches it through ./capabilities. Installed before the dynamic import, as
// client/layout.test.ts does, because a static import would be hoisted above it.
const hadWindow = 'window' in globalThis
;(globalThis as Record<string, unknown>).window = {
  location: { href: 'http://localhost/', origin: 'http://localhost' }
}

const { offeredIntervalCodes, periodToResolution, resolutionDurationMs, resolutionToPeriod } =
  await import('./periods')

afterAll(() => {
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window
})

const at = (code: string): Period => {
  const period = resolutionToPeriod(code)
  if (period === null) throw new Error(`not a period: ${code}`)
  return period
}

const caps = (over: Partial<Capabilities>): Capabilities => ({
  version: 'test',
  serverTime: 0,
  intervals: ['1D', '1h', '1m', '5s'],
  features: ['scopedIntervals'],
  limits: {
    maxBarsPerRequest: 5000,
    maxBatchRequests: 12,
    maxBackfillBarCount: 500,
    maxSubscriptionsPerConnection: 32
  },
  levels: [],
  ...over
})

describe('the seconds unit', () => {
  test('5s round-trips as a second period', () => {
    const period = at('5s')
    expect(period).toEqual({ multiplier: 5, timespan: 'second', text: '5s' })
    expect(periodToResolution(period)).toBe('5s')
  })

  test('5s has a finite duration on both sides of the library seam', () => {
    expect(resolutionDurationMs('5s')).toBe(5000)
    expect(periodDurationMs(at('5s'))).toBe(5000)
  })
})

describe('offeredIntervalCodes', () => {
  const scoped = caps({ scopedIntervals: { '5s': ['oanda:EURUSD', 'oanda:GBPUSD'] } })

  test('a scoped code is offered only for the instruments the server names', () => {
    expect(offeredIntervalCodes('oanda', 'EURUSD', scoped)).toEqual(['1D', '1h', '1m', '5s'])
    expect(offeredIntervalCodes('oanda', 'XAUUSD', scoped)).toEqual(['1D', '1h', '1m'])
    expect(offeredIntervalCodes('coinbase', 'EURUSD', scoped)).toEqual(['1D', '1h', '1m'])
  })

  test('names compare on the canonical spelling', () => {
    expect(offeredIntervalCodes('OANDA', 'eurusd', scoped)).toContain('5s')
  })

  test('an empty list offers the code nowhere', () => {
    const none = caps({ scopedIntervals: { '5s': [] } })
    expect(offeredIntervalCodes('oanda', 'EURUSD', none)).not.toContain('5s')
  })

  test('a server without the map offers no seconds code at all, and everything else', () => {
    const older = caps({ features: [] })
    expect(offeredIntervalCodes('oanda', 'EURUSD', older)).toEqual(['1D', '1h', '1m'])
  })
})

describe('periodFor', () => {
  const periods = ['5s', '1m', '1h', '1D'].map(at)

  test('an offered period is kept, as the same object', () => {
    const period = at('5s')
    expect(periodFor(period, periods, { ticker: 'EURUSD', periods: ['5s', '1m'] })).toBe(period)
  })

  test('a symbol without 5s moves the pane to the shortest offered period at least as long', () => {
    const symbol = { ticker: 'XAUUSD', periods: ['1m', '1h', '1D'] }
    expect(periodFor(at('5s'), periods, symbol).text).toBe('1m')
  })

  test('with nothing long enough offered, the longest offered', () => {
    const symbol = { ticker: 'X', periods: ['5s', '1m'] }
    expect(periodFor(at('1D'), periods, symbol).text).toBe('1m')
  })

  test('a symbol that states no list is offered everything', () => {
    const period = at('5s')
    expect(periodFor(period, periods, { ticker: 'EURUSD' })).toBe(period)
  })
})
