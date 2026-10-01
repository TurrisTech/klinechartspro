import { describe, expect, test } from 'bun:test'
import { AtomIndex, type Atoms, quantumFor, REMAINDER_TOLERANCE, type SourceBar, slotAtoms, spread } from './atoms'

// Spreading a bar's volume over its range, one chart bar's histogram, and the per-pane index
// that keeps them -- conservation first, because a profile that loses or invents volume looks
// exactly as plausible as one that does not.

const Q = 0.0001

function sum(a: Atoms | null): { up: number; down: number } {
  if (!a) return { up: 0, down: 0 }
  let up = 0
  let down = 0
  for (let k = 0; k < a.up.length; k++) {
    up += a.up[k]
    down += a.down[k]
  }
  return { up, down }
}

function bar(date: number, open: number, high: number, low: number, close: number, volume: number): SourceBar {
  return { date, open, high, low, close, volume }
}

function empty(first: number, size: number): Atoms {
  return { first, up: new Float64Array(size), down: new Float64Array(size), total: 0, coarse: 0 }
}

describe('spreading one bar', () => {
  test('evenly over its range, in proportion to how much of each atom it covers', () => {
    // 1.00005 .. 1.00035: half of atom 10000, all of 10001 and 10002, half of 10003.
    const a = empty(10000, 4)
    spread(a, { open: 1.00005, high: 1.00035, low: 1.00005, close: 1.00035 }, 30, Q)
    expect([...a.up].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([5, 10, 10, 5])
    expect([...a.down]).toEqual([0, 0, 0, 0])
    expect(a.total).toBe(30)
  })

  test('a bar that closed down is down volume; one that closed where it opened is split evenly', () => {
    const down = empty(10000, 2)
    spread(down, { open: 1.00015, high: 1.00015, low: 1.00005, close: 1.00005 }, 8, Q)
    expect(sum(down)).toEqual({ up: 0, down: 8 })
    const doji = empty(10000, 2)
    spread(doji, { open: 1.0001, high: 1.00015, low: 1.00005, close: 1.0001 }, 8, Q)
    expect(sum(doji)).toEqual({ up: 4, down: 4 })
  })

  test('a bar with no range puts everything in the atom of its close', () => {
    const a = empty(10000, 3)
    spread(a, { open: 1.00012, high: 1.00012, low: 1.00012, close: 1.00012 }, 7, Q)
    expect([...a.up].map((v, k) => v + a.down[k])).toEqual([0, 7, 0])
  })
})

describe('one chart bar', () => {
  const chartBar = { open: 1.0, high: 1.001, low: 0.999, close: 1.0005, volume: 100 }
  const sources = [bar(0, 1.0, 1.0005, 0.999, 1.0004, 60), bar(1, 1.0004, 1.001, 1.0003, 1.0005, 40)]

  test('its source bars, when they account for its volume, and nothing from the chart bar', () => {
    const a = slotAtoms(chartBar, sources, Q)
    expect(a?.total).toBe(100)
    expect(a?.coarse).toBe(0)
    const s = sum(a)
    expect(s.up + s.down).toBeCloseTo(100, 9)
  })

  test("the chart bar's own volume, spread over the chart bar, where there is no source", () => {
    const a = slotAtoms(chartBar, [], Q)
    expect(a?.total).toBe(100)
    expect(a?.coarse).toBe(100)
  })

  test('only the difference, when the source covers part of it -- a profile never loses volume', () => {
    const a = slotAtoms(chartBar, [sources[0]], Q)
    expect(a?.coarse).toBe(40)
    expect(a?.total).toBe(100)
  })

  test('a difference inside the tolerance is noise between two reads, not missing volume', () => {
    const a = slotAtoms({ ...chartBar, volume: 100 * (1 + REMAINDER_TOLERANCE / 2) }, sources, Q)
    expect(a?.coarse).toBe(0)
    expect(a?.total).toBe(100)
  })

  test('no volume anywhere is no histogram', () => {
    expect(slotAtoms({ ...chartBar, volume: 0 }, [], Q)).toBeNull()
  })
})

describe('the atom height', () => {
  test('an eighth of the median range, in whole ticks, never below one tick', () => {
    expect(quantumFor([0.0008, 0.0016, 0.0024], 0.00001)).toBeCloseTo(0.0002, 12)
    expect(quantumFor([0.00001], 0.00001)).toBe(0.00001)
    expect(quantumFor([], 0.01)).toBe(0.01)
  })
})

// A 1h chart of three bars over 1m sources, and the same chart one live tick later.
const H = 3_600_000
const M = 60_000
function hourly(n: number) {
  const bars = Array.from({ length: n }, () => ({ open: 1, high: 1.002, low: 0.998, close: 1.001, volume: 60 }))
  const starts = Array.from({ length: n }, (_, i) => i * H)
  return { starts, bars, lastEnd: n * H }
}
function minutes(n: number, volume = 1): SourceBar[] {
  return Array.from({ length: n }, (_, i) => bar(i * M, 1, 1.001 + (i % 7) * 0.0001, 0.999, 1.0005, volume))
}

describe('the per-pane index', () => {
  test('each source bar lands in the chart bar whose span holds its open', () => {
    const idx = new AtomIndex()
    const out = idx.update(hourly(3), { bars: minutes(150), shift: 0 }, Q, Number.NEGATIVE_INFINITY)
    expect(out.map((a) => a?.total)).toEqual([60, 60, 60])
    // The third hour holds 30 source minutes; the other 30 of its volume come from the bar.
    expect(out.map((a) => a?.coarse)).toEqual([0, 0, 30])
  })

  test('a live tick rebuilds the forming bar and gives what a full rebuild gives', () => {
    const idx = new AtomIndex()
    const src = minutes(150)
    idx.update(hourly(3), { bars: src, shift: 0 }, Q, Number.NEGATIVE_INFINITY)
    const ticked = [...src.slice(0, -1), bar(149 * M, 1, 1.004, 0.997, 1.003, 5)]
    const chart = hourly(3)
    chart.bars[2] = { ...chart.bars[2], high: 1.004, low: 0.997, volume: 64 }
    const incremental = idx.update(chart, { bars: ticked, shift: 0 }, Q, 149 * M)
    const full = new AtomIndex().update(chart, { bars: ticked, shift: 0 }, Q, Number.NEGATIVE_INFINITY)
    expect(incremental).toEqual(full)
  })

  test('a new chart bar on the right rebuilds the bar before it, whose span it ends', () => {
    const idx = new AtomIndex()
    const src = minutes(200)
    idx.update(hourly(3), { bars: src, shift: 0 }, Q, null)
    const grown = idx.update(hourly(4), { bars: src, shift: 0 }, Q, null)
    expect(grown).toEqual(new AtomIndex().update(hourly(4), { bars: src, shift: 0 }, Q, Number.NEGATIVE_INFINITY))
  })

  test('history loaded on the left rebuilds everything', () => {
    const idx = new AtomIndex()
    const src = minutes(240)
    const later = hourly(4)
    idx.update({ starts: later.starts.slice(2), bars: later.bars.slice(2), lastEnd: later.lastEnd }, { bars: src, shift: 0 }, Q, null)
    expect(idx.update(later, { bars: src, shift: 0 }, Q, null).map((a) => a?.total)).toEqual([60, 60, 60, 60])
  })

  test('a session-dated source is mapped by its open instant, not its wire date', () => {
    // A monthly chart over daily bars dated 7h after their open (the FX wire shift).
    const D = 86_400_000
    const shift = 7 * H
    const days = Array.from({ length: 40 }, (_, i) => bar(i * D + shift, 1, 1.01, 0.99, 1, 1))
    const chart = { starts: [0, 20 * D], bars: [{ open: 1, high: 1.01, low: 0.99, close: 1, volume: 20 }, { open: 1, high: 1.01, low: 0.99, close: 1, volume: 20 }], lastEnd: 40 * D }
    const out = new AtomIndex().update(chart, { bars: days, shift }, 0.001, null)
    expect(out.map((a) => a?.coarse)).toEqual([0, 0])
  })
})
