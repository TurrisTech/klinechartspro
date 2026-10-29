import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { StoredProbeDeps } from './source'

// The stored-ladder probe: which intervals a replay may treat as STORED for an instrument --
// its bases, the rungs its forming candles are composed from, its fill refinement.

installWindow()
const { OhlcvApiError } = await import('../config')
const { probeStoredIntervals } = await import('./source')
const { FX_GRID, gridOf, STORED_LADDER, storedLadderFor } = await import('./timeframes')

const AT = Date.UTC(2026, 9, 21, 16, 0) // Wed 2026-10-21 12:00 New York
const EQUITIES = gridOf({ timezone: 'America/New_York', day: { openOffset: 9, closeOffset: 16, everyDayTrades: false } })

/** As prod's /capabilities states them (2026-10-29). */
const BASE_INTERVALS: Record<string, string[]> = {
  oanda: ['5s', '1m', '1h', '1D', '1M'],
  coinbase: ['1m', '1h', '1D', '1M'],
  schwab: ['1m', '30m', '1D']
}

/** A server that answers a bar for every interval it is asked about -- as prod's does for one it
 * would fold (schwab 1h) -- and records what it was asked. `refuse` are answered as prod answers
 * an interval finer than the vendor's floor (a 500 naming it). */
function server(advertised: Record<string, string[]> | null, refuse: readonly string[] = []): StoredProbeDeps & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    advertised: (vendor) => advertised?.[vendor] ?? null,
    get: async <T>(_path: string, params: Record<string, unknown>): Promise<T> => {
      const resolution = String(params.resolution)
      asked.push(resolution)
      if (refuse.includes(resolution)) throw new OhlcvApiError(500, 'internal', `Interval(${resolution}) is finer than the base interval stored`)
      return [{ date: Number(params.to) - 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }] as T
    }
  }
}

describe('storedLadderFor', () => {
  test("cuts the ladder to what the vendor stores: schwab's 1h is a fold of its 30m, not stored", () => {
    expect(storedLadderFor(BASE_INTERVALS.schwab)).toEqual(['1m', '1D'])
    expect(storedLadderFor(BASE_INTERVALS.coinbase)).toEqual(['1m', '1h', '1D'])
    expect(storedLadderFor(BASE_INTERVALS.oanda)).toEqual(['5s', '1m', '1h', '1D'])
  })

  test('a server that states nothing is probed for the whole ladder, as before', () => {
    expect(storedLadderFor(null)).toEqual([...STORED_LADDER])
  })
})

describe('probeStoredIntervals', () => {
  test('schwab: a 1h bar the server folds does not make 1h stored, and 5s is never asked', async () => {
    const deps = server(BASE_INTERVALS, ['5s'])
    expect(await probeStoredIntervals('schwab:SPY', AT, EQUITIES, deps)).toEqual(['1m', '1D'])
    expect(deps.asked.sort()).toEqual(['1D', '1m'])
  })

  test('oanda: every rung the vendor stores and the instrument holds', async () => {
    const deps = server(BASE_INTERVALS)
    expect(await probeStoredIntervals('oanda:EURUSD', AT, FX_GRID, deps)).toEqual(['5s', '1m', '1h', '1D'])
  })

  test('a rung the vendor stores but this instrument does not (5s off the majors) is left out', async () => {
    const deps = server(BASE_INTERVALS, ['5s'])
    expect(await probeStoredIntervals('oanda:USDTRY', AT, FX_GRID, deps)).toEqual(['1m', '1h', '1D'])
  })

  test('with no baseIntervals from the server, the probe alone decides', async () => {
    const deps = server(null, ['5s'])
    expect(await probeStoredIntervals('schwab:SPY', AT, EQUITIES, deps)).toEqual(['1m', '1h', '1D'])
  })

  test('the window ends at the cursor on the wire clock: a daily read is session-dated', async () => {
    const params: Array<Record<string, unknown>> = []
    const deps: StoredProbeDeps = {
      advertised: () => ['1D'],
      get: async <T>(_path: string, p: Record<string, unknown>): Promise<T> => {
        params.push(p)
        return [] as T
      }
    }
    expect(await probeStoredIntervals('schwab:SPY', AT, EQUITIES, deps)).toEqual([])
    // An equity day is dated 9 hours before its 09:00 open; the read is one bar, unclamped.
    expect(params).toEqual([{ symbol: 'schwab:SPY', resolution: '1D', from: AT - 30 * 86_400_000 - 9 * 3_600_000, to: AT - 9 * 3_600_000, limit: 1, asof: null }])
  })

  test('an error that is not the API refusing still fails the probe', async () => {
    const deps: StoredProbeDeps = {
      advertised: () => null,
      get: async () => {
        throw new TypeError('network down')
      }
    }
    await expect(probeStoredIntervals('oanda:EURUSD', AT, FX_GRID, deps)).rejects.toThrow('network down')
  })
})
