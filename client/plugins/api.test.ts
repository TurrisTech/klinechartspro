import { describe, expect, test } from 'bun:test'
import { installWindow } from './testing'

// client/config.ts reads `window` at import, so the DOM stub has to exist before api.ts is
// loaded -- hence the dynamic import.
installWindow()
const { toPage } = await import('./api')

describe('toPage', () => {
  test('a capped ok page continues from its last point', () => {
    const page = toPage({ s: 'ok', points: [{ date: 1 }, { date: 2 }] }, 2)
    expect(page).toEqual({ points: [{ date: 1 }, { date: 2 }], nextFrom: 3 })
  })
  test('a short ok page is the end of the gap', () => {
    expect(toPage({ s: 'ok', points: [{ date: 1 }] }, 2).nextFrom).toBeNull()
  })
  test('no_data covers the gap with nothing', () => {
    expect(toPage({ s: 'no_data' }, 2)).toEqual({ points: [], nextFrom: null })
  })
  test('replaying reports a status to retry on', () => {
    const page = toPage({ s: 'replaying', phase: 'queued', progress: 0.5, retryAfterMs: 900 }, 2)
    expect(page.status).toEqual({ phase: 'queued', progress: 0.5, retryAfterMs: 900 })
  })
  test('the envelope is handed back for keys a plugin wants (the server seriesKey, say)', () => {
    let seen: unknown = null
    toPage({ s: 'ok', points: [], seriesKey: 'abc' }, 5, (e) => {
      seen = e.seriesKey
    })
    expect(seen).toBe('abc')
  })
})
