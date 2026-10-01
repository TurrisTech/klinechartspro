import { describe, expect, test } from 'bun:test'
import { AtomIndex, type Atoms, type SourceBar } from './atoms'
import { sumAtoms, toProfile, valueAreaOf } from './profile'

// Rows, the point of control and the value area -- and the property the whole design is for:
// the same span profiled on two timeframes, from the same source, is the same profile.

function atoms(first: number, up: number[], down: number[] = up.map(() => 0)): Atoms {
  const total = up.reduce((s, v) => s + v, 0) + down.reduce((s, v) => s + v, 0)
  return { first, up: Float64Array.from(up), down: Float64Array.from(down), total, coarse: 0 }
}

describe('summing chart bars', () => {
  test('onto one grid wide enough for all of them, coarse volume carried through', () => {
    const a = atoms(10, [1, 2])
    const b = { ...atoms(11, [4, 0, 8]), coarse: 3 }
    const s = sumAtoms([a, null, b], 0, 2)
    expect(s?.first).toBe(10)
    expect([...(s?.up ?? [])]).toEqual([1, 6, 0, 8])
    expect(s?.total).toBe(15)
    expect(s?.coarse).toBe(3)
  })

  test('only the range asked for', () => {
    expect(sumAtoms([atoms(0, [1]), atoms(5, [2])], 1, 1)?.first).toBe(5)
    expect(sumAtoms([null, null], 0, 1)).toBeNull()
  })
})

describe('rows', () => {
  test('cut over the span that traded, every unit of volume in exactly one place', () => {
    const p = toProfile(atoms(100, [0, 3, 1, 1, 1, 5, 0]), 0.01, 5, 0.7)
    expect(p?.lo).toBeCloseTo(1.01, 12)
    expect(p?.hi).toBeCloseTo(1.06, 12)
    const rows = [...(p?.up ?? [])]
    expect(rows).toHaveLength(5)
    for (const [r, v] of [3, 1, 1, 1, 5].entries()) expect(rows[r]).toBeCloseTo(v, 9)
    expect(p?.poc).toBe(4)
  })

  test('an atom straddling two rows is shared between them by overlap, not given to one', () => {
    // Three atoms into two rows: the middle one is half in each.
    const p = toProfile(atoms(0, [2, 2, 2]), 1, 2, 0.7)
    expect(p?.up[0]).toBeCloseTo(3, 9)
    expect(p?.up[1]).toBeCloseTo(3, 9)
  })

  test('never finer than the grid it is summed from', () => {
    expect(toProfile(atoms(0, [1, 1, 1]), 1, 50, 0.7)?.up.length).toBe(3)
  })

  test('nothing traded is no profile', () => {
    expect(toProfile(atoms(0, [0, 0]), 1, 10, 0.7)).toBeNull()
  })
})

describe('the value area', () => {
  test('grows from the POC by the heavier neighbour until it holds the share asked for', () => {
    const up = Float64Array.from([1, 2, 10, 4, 1, 1])
    const down = new Float64Array(6)
    // 19 in all; 70% is 13.3: POC 10, then 4 (above) = 14.
    expect(valueAreaOf(up, down, 2, 0.7)).toEqual([2, 3])
    // 90% is 17.1: then 2 (below) = 16, then 1 above on the tie = 17, then 1 above again = 18.
    expect(valueAreaOf(up, down, 2, 0.9)).toEqual([1, 5])
  })
})

// A deterministic 1m random walk over two days, folded into 1h and 4h chart bars exactly as the
// tiles fold them (the volume of a candle is the sum of its minutes').
function walk(minutes: number): SourceBar[] {
  let seed = 7
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
    return seed / 2 ** 31
  }
  const out: SourceBar[] = []
  let price = 1.1
  for (let i = 0; i < minutes; i++) {
    const open = price
    const close = open + (rand() - 0.5) * 0.0006
    const high = Math.max(open, close) + rand() * 0.0002
    const low = Math.min(open, close) - rand() * 0.0002
    out.push({ date: i * 60_000, open, high, low, close, volume: 1 + Math.floor(rand() * 20) })
    price = close
  }
  return out
}

function fold(src: SourceBar[], perBar: number) {
  const starts: number[] = []
  const bars: Array<{ open: number; high: number; low: number; close: number; volume: number }> = []
  for (let i = 0; i < src.length; i += perBar) {
    const chunk = src.slice(i, i + perBar)
    starts.push(chunk[0].date)
    bars.push({
      open: chunk[0].open,
      high: Math.max(...chunk.map((b) => b.high)),
      low: Math.min(...chunk.map((b) => b.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, b) => s + b.volume, 0)
    })
  }
  return { starts, bars, lastEnd: src[src.length - 1].date + 60_000 }
}

describe('the same span on two timeframes', () => {
  test('is the same profile when both are built from the same source', () => {
    const src = walk(48 * 60)
    const q = 0.00002
    const oneHour = new AtomIndex().update(fold(src, 60), { bars: src, shift: 0 }, q, null)
    const fourHour = new AtomIndex().update(fold(src, 240), { bars: src, shift: 0 }, q, null)
    const a = toProfile(sumAtoms(oneHour, 0, oneHour.length - 1), q, 40, 0.7)
    const b = toProfile(sumAtoms(fourHour, 0, fourHour.length - 1), q, 40, 0.7)
    expect(a).not.toBeNull()
    expect(b?.lo).toBe(a?.lo as number)
    expect(b?.hi).toBe(a?.hi as number)
    expect(b?.poc).toBe(a?.poc as number)
    expect([b?.vaLow, b?.vaHigh]).toEqual([a?.vaLow, a?.vaHigh])
    for (let r = 0; r < 40; r++) {
      expect(b?.up[r]).toBeCloseTo(a?.up[r] as number, 9)
      expect(b?.down[r]).toBeCloseTo(a?.down[r] as number, 9)
    }
    expect(a?.coarse).toBe(0)
  })

  test('and is NOT when each is built from its own bars -- which is why the source is finer', () => {
    const src = walk(48 * 60)
    const q = 0.00002
    const oneHour = new AtomIndex().update(fold(src, 60), null, q, null)
    const fourHour = new AtomIndex().update(fold(src, 240), null, q, null)
    const a = toProfile(sumAtoms(oneHour, 0, oneHour.length - 1), q, 40, 0.7)
    const b = toProfile(sumAtoms(fourHour, 0, fourHour.length - 1), q, 40, 0.7)
    let differs = 0
    for (let r = 0; r < 40; r++) differs += Math.abs((a?.up[r] ?? 0) + (a?.down[r] ?? 0) - (b?.up[r] ?? 0) - (b?.down[r] ?? 0))
    expect(differs / (a?.total ?? 1)).toBeGreaterThan(0.05)
  })
})
