import { describe, expect, test } from 'bun:test'
import { type TileManifest, tilesCovering } from './manifest'

// Coverage is the only thing standing between a tiled read and a chart that silently ends
// early. Tiles stop at the last closed calendar period, so every window reaching past that
// seam MUST fall through to /getbars — a partial answer here is indistinguishable, to every
// caller above, from "this is all the history there is".

const MIN = 60_000
const JUL_1 = Date.UTC(2026, 6, 1)
const JUL_31_LAST_BAR = Date.UTC(2026, 6, 31, 20, 59)
const AUG_1 = Date.UTC(2026, 7, 1)

const manifest: TileManifest = {
  vendor: 'oanda',
  symbol: 'EURUSD',
  interval: '1m',
  granularity: 'month',
  precision: 5,
  sessionDated: false,
  coveredFrom: Date.UTC(2026, 5, 1),
  // The period boundary, deliberately later than the last bar: the month covers the
  // weekend that closes it.
  coveredTo: AUG_1,
  tiles: [
    { name: '2026-06.parquet', from: Date.UTC(2026, 5, 1), to: Date.UTC(2026, 5, 30, 20, 59), rows: 30000, bytes: 129000 },
    { name: '2026-07.parquet', from: JUL_1, to: JUL_31_LAST_BAR, rows: 30000, bytes: 129000 }
  ]
}

describe('tilesCovering', () => {
  test('serves a window wholly inside the tiled range', () => {
    const hits = tilesCovering(manifest, JUL_1 + 100 * MIN, JUL_1 + 600 * MIN)
    expect(hits?.map((t) => t.name)).toEqual(['2026-07.parquet'])
  })

  test('spans consecutive tiles in order', () => {
    const hits = tilesCovering(manifest, Date.UTC(2026, 5, 20), Date.UTC(2026, 6, 10))
    expect(hits?.map((t) => t.name)).toEqual(['2026-06.parquet', '2026-07.parquet'])
  })

  test('refuses a window straddling the seam', () => {
    // The regression: this once returned the July tile alone, dropping every August bar.
    expect(tilesCovering(manifest, JUL_31_LAST_BAR - 2 * 86_400_000, AUG_1 + 5 * 86_400_000)).toBeNull()
  })

  test('refuses the live edge outright', () => {
    const now = AUG_1 + 25 * 86_400_000
    expect(tilesCovering(manifest, now - 500 * MIN, now)).toBeNull()
  })

  test('serves a window ending in the weekend gap after the last bar', () => {
    // Between the last July bar and the month boundary there are no bars, but the period
    // is complete. Comparing against the last bar rather than coveredTo would refuse this.
    const hits = tilesCovering(manifest, JUL_1, JUL_31_LAST_BAR + 30 * MIN)
    expect(hits?.map((t) => t.name)).toEqual(['2026-07.parquet'])
  })

  test('serves a window starting before the series began', () => {
    // Nothing exists before coveredFrom, so the tiles are still the complete answer.
    const hits = tilesCovering(manifest, Date.UTC(2020, 0, 1), Date.UTC(2026, 5, 10))
    expect(hits?.map((t) => t.name)).toEqual(['2026-06.parquet'])
  })

  test('returns null when no tile overlaps at all', () => {
    expect(tilesCovering(manifest, Date.UTC(2019, 0, 1), Date.UTC(2019, 1, 1))).toBeNull()
  })
})
