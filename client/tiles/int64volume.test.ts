import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { decodeTile } from './decode'

// Tile volume became INT64 in wmarketdata 0.31.0. The prices stayed int32 -- they are a value
// scaled by a per-instrument power of ten, so they have a ceiling worth designing against --
// but a volume is a raw count and coinbase XRPUSD trades ~13.3 billion in a month, six times
// what int32 holds. Postgres had already widened to BIGINT (migration 0011); an int32 tile
// column would have reinstated the clamp in the artifact the browser actually reads.
//
// The reason this file exists rather than a code review: hyparquet hands an INT64 column back
// as **BigInt**, not number. `decodeTile` already coerces every column with `Number(...)` --
// `ts` has been INT64 through that same line since the format was written -- so this is
// expected to pass unchanged. That is exactly why it is worth pinning: the coercion looks
// removable to anyone reading the loop, and dropping it would put BigInts into KLineData,
// where the first arithmetic on a volume throws "Cannot mix BigInt and other types".
//
// The fixture is a real published tile: s3://marketdata-tiles-dev
// v2/coinbase/XRPUSD/1M/all-1bdf00cf.parquet, built 2026-09-09 straight from the repaired
// Postgres rows, 62 monthly bars of which 26 are above the old int32 ceiling.

const TILE = `${import.meta.dir}/fixtures/coinbase-XRPUSD-1M-int64-volume.parquet`
// From the series' own manifest, never guessed: a tile holds only scaled integers, and
// inferring the scale from their magnitude is exactly the mistake the format was designed
// against. XRPUSD is 4, not coinbase's display precision of 2.
const PRECISION = 4

function bytes(): ArrayBuffer {
  const b = readFileSync(TILE)
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

describe('a tile whose volume column is INT64', () => {
  test('decodes volumes above the int32 ceiling to their exact value', async () => {
    const bars = await decodeTile(bytes(), PRECISION)
    expect(bars.length).toBe(62)

    const december2020 = bars.find(
      (b) => new Date(b.timestamp).toISOString().startsWith('2020-12')
    )
    expect(december2020).toBeDefined()
    // The vendor's figure, summed from its own daily buckets. Stored as 2147483647 until
    // 2026-09-09, i.e. 16.1% of the truth -- the single worst of the 26 clamped months.
    expect(december2020?.volume).toBe(13_313_711_610)
  })

  test('volumes arrive as numbers, not BigInt, so they survive arithmetic', async () => {
    const bars = await decodeTile(bytes(), PRECISION)
    const big = bars.filter((b) => b.volume > 2_147_483_647)
    expect(big.length).toBe(26)
    for (const b of big) expect(typeof b.volume).toBe('number')
    // The operation that throws on a BigInt, and the one every volume pane does.
    const total = bars.reduce((sum, b) => sum + b.volume, 0)
    expect(total).toBe(162_077_097_209)
  })

  test('the int32 price columns are unaffected by the widening', async () => {
    const bars = await decodeTile(bytes(), PRECISION)
    for (const b of bars) {
      expect(typeof b.open).toBe('number')
      expect(Number.isFinite(b.close)).toBe(true)
    }
    // A sub-dollar price must come back with its decimals intact, which is the half of the
    // format the widening must not disturb.
    const december2020 = bars.find(
      (b) => new Date(b.timestamp).toISOString().startsWith('2020-12')
    )
    expect(december2020?.open).toBeCloseTo(0.6649, 4)
  })
})
