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

// Auxiliary arrays: a plugin whose read produces a second KIND of row (mtf01's trades
// beside its cascade events) names them on the request and reads them off `Page.arrays`.
// What matters is that a requested array is ALWAYS present -- a plugin that has to test
// for undefined before every use is how a template ends up crashing on an old server.
describe('toPage with auxiliary arrays', () => {
  test('a named array is read off the envelope beside points', () => {
    const page = toPage(
      { s: 'ok', points: [{ date: 1 }], trades: [{ date: 2, outcome: 'target' }] },
      10,
      undefined,
      ['trades']
    )
    expect(page.points).toEqual([{ date: 1 }])
    // Rows keep whatever fields they arrived with -- the page's type says only that each
    // has a `date`, which is all the host needs to know; the plugin narrows from there.
    expect(page.arrays?.trades).toEqual([{ date: 2, outcome: 'target' } as { date: number }])
  })

  test('an array the server did not send reads as empty, not undefined', () => {
    // An older server, or one that simply had no trades in the window. Both are "no
    // trades" to the plugin, and neither should need a guard at the call site.
    const page = toPage({ s: 'ok', points: [{ date: 1 }] }, 10, undefined, ['trades'])
    expect(page.arrays).toEqual({ trades: [] })
  })

  test('no_data still carries the requested arrays, empty', () => {
    expect(toPage({ s: 'no_data' }, 10, undefined, ['trades']).arrays).toEqual({ trades: [] })
  })

  test('a replaying envelope carries them too, so the retry path is not a special case', () => {
    const page = toPage({ s: 'replaying', progress: 0.5, retryAfterMs: 100 }, 10, undefined, ['trades'])
    expect(page.arrays).toEqual({ trades: [] })
    expect(page.status?.phase).toBe('replaying')
  })

  test('a window with only auxiliary rows is real data, not an empty page', () => {
    // The server says `ok` when ANY array has rows. A cascade that took a trade but
    // evaluated no new arrow must not look like an empty window to the client either.
    const page = toPage({ s: 'ok', points: [], trades: [{ date: 2 }] }, 10, undefined, ['trades'])
    expect(page.points).toEqual([])
    expect(page.arrays?.trades).toHaveLength(1)
  })

  test('paging is driven by points alone', () => {
    // `trades` is over the limit and `points` is not: the page is complete, because an
    // auxiliary array is a different kind of row and has no cursor of its own.
    const page = toPage(
      { s: 'ok', points: [{ date: 1 }], trades: [{ date: 2 }, { date: 3 }, { date: 4 }] },
      2,
      undefined,
      ['trades']
    )
    expect(page.nextFrom).toBeNull()
  })

  test('a malformed array is dropped rather than handed to a template', () => {
    const page = toPage(
      { s: 'ok', points: [{ date: 1 }], trades: [{ date: 2 }, { nope: true }, 'garbage', null] },
      10,
      undefined,
      ['trades']
    )
    expect(page.arrays).toEqual({ trades: [{ date: 2 }] })
  })

  test('asking for no arrays leaves the page shape untouched', () => {
    expect(toPage({ s: 'ok', points: [{ date: 1 }], trades: [{ date: 2 }] }, 10)).toEqual({
      points: [{ date: 1 }],
      nextFrom: null
    })
  })
})
