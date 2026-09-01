import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { intradayMs, nearSource, profileSource, totalsSource, GRID_MS, PROFILE_DEPTH } = await import('./api')
const { flowValue, parseTemplateName, sentimentValue, templateName } = await import('./templates')
import type { PluginFacilities, PointsRequest } from '../plugins/types'

// The BOOK templates and sources: name parsing, the sub-pane value maths, and the store
// keys — in particular that the depth overlay and the hover viewer of one kind read ONE
// key (a wall showing both pays for one fetch, the same sharing the AREV sub-pane and the
// MTF overlay rely on), while a flow range change is a different key entirely.

const facilities = {
  points: (request: PointsRequest) => {
    captured.push(request)
    return Promise.resolve({ points: [], nextFrom: null })
  }
} as unknown as PluginFacilities
const captured: PointsRequest[] = []

describe('template names', () => {
  test('round-trip every display', () => {
    expect(parseTemplateName(templateName('depth', 'order'))).toEqual({ display: 'depth', kind: 'order' })
    expect(parseTemplateName(templateName('view', 'position'))).toEqual({ display: 'view', kind: 'position' })
    expect(parseTemplateName(templateName('sentiment', 'position'))).toEqual({ display: 'sentiment', kind: 'position' })
    expect(parseTemplateName(templateName('flow'))).toEqual({ display: 'flow', kind: 'order' })
  })
  test('junk is rejected', () => {
    expect(parseTemplateName('BOOK:depth:junk')).toBeNull()
    expect(parseTemplateName('BOOK:junk:order')).toBeNull()
    expect(parseTemplateName('AREV:arev21')).toBeNull()
  })
})

describe('sub-pane values', () => {
  test('sentiment is the long share of the counts, against 50', () => {
    expect(sentimentValue({ date: 0, ts: 0, long: 60, short: 40 })).toEqual({ pctLong: 60, mid: 50 })
    expect(sentimentValue(undefined)).toEqual({})
    expect(sentimentValue({ date: 0, ts: 0, long: 0, short: 0 })).toEqual({})
  })
  test('flow maps the near split to limits and stops', () => {
    expect(
      flowValue({ date: 0, ts: 0, price: 1.1, longBelow: 5, longAbove: 4, shortBelow: 3, shortAbove: 6 })
    ).toEqual({ limitBuy: 5, limitSell: 6, stopBuy: 4, stopSell: 3 })
  })
})

describe('source keys', () => {
  test('depth and view share the profile key and both leave the store to the default factory', () => {
    const a = profileSource(facilities, 'order', 'oanda', 'EURUSD', '10m')
    const b = profileSource(facilities, 'order', 'oanda', 'EURUSD', '10m')
    expect(a.key).toBe(b.key)
    expect(a.key).toContain(`d${PROFILE_DEPTH}`)
    expect(a.createStore).toBeUndefined()
    expect(b.createStore).toBeUndefined()
    expect(a.resolution).toBe('10m')
  })
  test('kind, interval and flow range are all part of the identity', () => {
    expect(profileSource(facilities, 'order', 'oanda', 'EURUSD', '10m').key).not.toBe(
      profileSource(facilities, 'position', 'oanda', 'EURUSD', '10m').key
    )
    expect(totalsSource(facilities, 'position', 'oanda', 'EURUSD', '1h').key).not.toBe(
      totalsSource(facilities, 'position', 'oanda', 'EURUSD', '4h').key
    )
    expect(nearSource(facilities, 'order', 'oanda', 'EURUSD', '1h', 2).key).not.toBe(
      nearSource(facilities, 'order', 'oanda', 'EURUSD', '1h', 5).key
    )
  })
  test('fetch carries the metric and the variant to the unified wire', async () => {
    captured.length = 0
    await nearSource(facilities, 'order', 'oanda', 'EURUSD', '1h', 3).fetch({ from: 0, to: 1 }, 5000)
    await profileSource(facilities, 'position', 'oanda', 'EURUSD', '10m').fetch({ from: 0, to: 1 }, 5000)
    expect(captured[0]).toMatchObject({
      pluginId: 'books',
      variant: 'order',
      params: { metric: 'near', range: 3 }
    })
    expect(captured[1]).toMatchObject({
      variant: 'position',
      params: { metric: 'profile', depth: PROFILE_DEPTH }
    })
  })
})

describe('intradayMs', () => {
  test('intraday codes parse; session-dated ones do not', () => {
    expect(intradayMs('10m')).toBe(600_000)
    expect(intradayMs('1h')).toBe(3_600_000)
    expect(intradayMs('1D')).toBeNull()
    expect(intradayMs('1W')).toBeNull()
    expect(GRID_MS / (intradayMs('10m') as number)).toBe(2)
  })
})
