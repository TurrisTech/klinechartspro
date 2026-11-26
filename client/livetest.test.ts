import { afterEach, describe, expect, test } from 'bun:test'
import { authHeaders } from './authtoken'
import { assertSignedIn, holdLiveToken, liveHeaders } from './livetest'

describe('the login for live tests', () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: unknown }).localStorage
  })

  test('a token becomes a bearer header, and no token sends none', () => {
    expect(liveHeaders('abc')).toEqual({ Authorization: 'Bearer abc' })
    expect(liveHeaders('')).toEqual({})
  })

  test('a 401 says what to set instead of reading as no data', () => {
    expect(() => assertSignedIn(new Response('{}', { status: 401 }), '/getbars')).toThrow(
      'sign in: set OHLCV_API_TOKEN (/getbars answered 401)'
    )
  })

  test('any other status is left to the caller', () => {
    expect(() => assertSignedIn(new Response('[]', { status: 200 }), '/getbars')).not.toThrow()
    expect(() => assertSignedIn(new Response('{}', { status: 500 }), '/getbars')).not.toThrow()
  })

  test('a held token is the one serverFetch presents', () => {
    holdLiveToken('abc')
    expect(authHeaders()).toEqual({ Authorization: 'Bearer abc' })
  })

  test('no token leaves localStorage alone', () => {
    holdLiveToken('')
    expect((globalThis as { localStorage?: unknown }).localStorage).toBeUndefined()
  })
})
