import { describe, expect, test } from 'bun:test'
import { type TileManifest, tilesUpTo } from './manifest'

// Tiles hold every closed calendar period and nothing of the one still forming, so this
// decides two things at once: how much of a window tiles answer, and exactly where the
// caller must pick up from the API. Get the boundary wrong in either direction and the
// joined series is silently wrong — short if the split is late, double-counted if early.

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

// Narrows away the null the API returns for "tiles cannot answer this", so assertions read
// as plain values instead of non-null assertions.
function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}, got ${value}`)
  return value
}

describe('tilesUpTo', () => {
  test('answers a window wholly inside tiled history, and says so', () => {
    const span = tilesUpTo(manifest, JUL_1 + 100 * MIN, JUL_1 + 600 * MIN)
    expect(present(span, 'a tiled span').entries.map((t) => t.name)).toEqual(['2026-07.parquet'])
    // coveredTo past `to` is how the caller knows no API call is needed at all.
    expect(present(span, 'a tiled span').coveredTo).toBeGreaterThan(JUL_1 + 600 * MIN)
  })

  test('spans consecutive tiles in order', () => {
    const span = tilesUpTo(manifest, Date.UTC(2026, 5, 20), Date.UTC(2026, 6, 10))
    expect(present(span, 'a tiled span').entries.map((t) => t.name)).toEqual(['2026-06.parquet', '2026-07.parquet'])
  })

  test('answers the historical part of a seam-straddling window and stops at the boundary', () => {
    // The point of the redesign: this is no longer refused. Tiles cover through July and
    // the caller fetches August, so the pan costs network only for the unfinished period.
    const span = tilesUpTo(manifest, JUL_31_LAST_BAR - 2 * 86_400_000, AUG_1 + 5 * 86_400_000)
    expect(present(span, 'a tiled span').entries.map((t) => t.name)).toEqual(['2026-07.parquet'])
    expect(present(span, 'a tiled span').coveredTo).toBe(AUG_1)
  })

  test('splits on the period boundary, not the last bar', () => {
    // Between the last July bar and the month end there are no bars, but the period is
    // complete. Splitting at the last bar would make the caller re-request that empty
    // stretch — and worse, re-request it from inside an already-tiled period.
    const span = tilesUpTo(manifest, JUL_1, AUG_1 + 86_400_000)
    expect(present(span, 'a tiled span').coveredTo).toBe(AUG_1)
    expect(present(span, 'a tiled span').coveredTo).toBeGreaterThan(JUL_31_LAST_BAR)
  })

  test('contributes nothing when the window lies entirely in the unfinished period', () => {
    const now = AUG_1 + 25 * 86_400_000
    expect(tilesUpTo(manifest, now - 500 * MIN, now)).toBeNull()
  })

  test('serves a window starting before the series began', () => {
    // Nothing exists before coveredFrom, so the tiles are still the complete answer.
    const span = tilesUpTo(manifest, Date.UTC(2020, 0, 1), Date.UTC(2026, 5, 10))
    expect(present(span, 'a tiled span').entries.map((t) => t.name)).toEqual(['2026-06.parquet'])
  })

  test('returns null when no tile overlaps at all', () => {
    expect(tilesUpTo(manifest, Date.UTC(2019, 0, 1), Date.UTC(2019, 1, 1))).toBeNull()
  })

  test('a gap INSIDE coverage is answered, emptily, rather than handed to the API', () => {
    // The FX weekend, which is two days in every seven and which the pagination widener
    // probes constantly while panning back through history. No tile overlaps it, but the
    // tiles cover it and their answer is definite: no bars. Returning null here sent every
    // such probe to /getbars for a range already settled -- and the API said `no_data` each
    // time. Measured on the live 3m series: a window of Fri 20:57:00.001Z -> Sat 21:57Z,
    // sitting between the June tile's last bar and the July tile's first.
    const weekend = tilesUpTo(manifest, Date.UTC(2026, 5, 30, 20, 59) + 1, JUL_1 - MIN)
    expect(present(weekend, 'an authoritative empty span').entries).toEqual([])
    expect(present(weekend, 'an authoritative empty span').coveredTo).toBe(AUG_1)
  })

  test('but a gap reaching BEFORE coverage still falls back', () => {
    // Part of this window predates the tiles, so they are not the whole answer and the
    // caller has to ask.
    expect(tilesUpTo(manifest, Date.UTC(2026, 4, 1), Date.UTC(2026, 4, 20))).toBeNull()
  })

  test('an empty window whose tail runs past coverage still splits at the boundary', () => {
    // Nothing tiled to serve, but the caller must still pick up from coveredTo rather than
    // from its own `from`, or the forming period is fetched twice.
    const span = tilesUpTo(manifest, JUL_31_LAST_BAR + 1, AUG_1 + 10 * MIN)
    expect(present(span, 'a span').entries).toEqual([])
    expect(present(span, 'a span').coveredTo).toBe(AUG_1)
  })
})
