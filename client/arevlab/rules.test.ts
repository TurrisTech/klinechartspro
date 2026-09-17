import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/rules_parity.json'
import {
  MIN_WINDOW_VALUES,
  bandLines,
  countingBars,
  entrySides,
  fixedSides,
  medianLines,
  quantileSorted,
  rankLines,
  type LabPoint
} from './rules'

// Two halves. The parity cases are wdashboard-server's own output (fixtures/generate.py) for the
// pieces the lab still shares with services/arev21outlier.py -- the quantile, the band and the
// entry rule -- since the lab's windows are spans of days, which that module has no form of. The
// rest pins the day window itself, in cases small enough to check by eye.

const HOUR = 3_600_000
const DAY = 86_400_000

const points: LabPoint[] = fixture.rows.map((r) => ({ date: r.date, p: r.p ?? Number.NaN, n: r.n, atCross: r.atCross }))

describe('parity with the server', () => {
  test('the quantile is numpy linear, on every shape the fixture holds', () => {
    for (const c of fixture.quantiles) {
      expect(Math.abs(quantileSorted(c.sorted, c.q) - c.value), `q=${c.q} n=${c.sorted.length}`).toBeLessThan(1e-12)
    }
  })

  test('the band and the entry rule match `derive` + `sides`', () => {
    // `sides()` counts a bar only at a sample, which is `samplesOnly`.
    const counts = countingBars(points, fixture.minNeighbours, true)
    for (const c of fixture.entryCases) {
      const centre = Float64Array.from(c.centreIn.map((v) => v ?? Number.NaN))
      const lines = bandLines(centre, c.width)
      c.hi.forEach((want, i) => {
        if (want === null) expect(Number.isNaN(lines.hi[i])).toBe(true)
        else expect(Math.abs(lines.hi[i] - want)).toBeLessThan(1e-12)
      })
      c.lo.forEach((want, i) => {
        if (want === null) expect(Number.isNaN(lines.lo[i])).toBe(true)
        else expect(Math.abs(lines.lo[i] - want)).toBeLessThan(1e-12)
      })
      expect(Array.from(entrySides(points, counts, lines))).toEqual(c.side)
    }
  })

  test('the fixture exercises both sides', () => {
    for (const c of fixture.entryCases) {
      expect(c.side.filter((s) => s === 1).length).toBeGreaterThan(0)
      expect(c.side.filter((s) => s === -1).length).toBeGreaterThan(0)
    }
  })
})

/** `count` hourly bars of p, ascending from date 0. */
const hourly = (ps: number[], atCross = true): LabPoint[] => ps.map((p, i) => ({ date: i * HOUR, p, n: 100, atCross }))
const flat = (count: number, p = 0.5): number[] => Array.from({ length: count }, () => p)

describe('countingBars', () => {
  const pts: LabPoint[] = [
    { date: 0, p: 0.6, n: 100, atCross: true },
    { date: 1, p: 0.6, n: 100, atCross: false },
    { date: 2, p: 0.6, n: 49, atCross: true },
    { date: 3, p: Number.NaN, n: 100, atCross: true }
  ]

  test('by default every bar with a usable p counts, sample or not', () => {
    expect(countingBars(pts, 50, false)).toEqual([true, true, false, false])
  })

  test('samplesOnly narrows it to the bars the model predicts on', () => {
    expect(countingBars(pts, 50, true)).toEqual([true, false, false, false])
  })
})

describe('the windows', () => {
  test('a bar is judged against the window BEFORE it, never against itself', () => {
    const pts = hourly([...flat(30, 0.5), 0.9])
    const lines = medianLines(pts, countingBars(pts, 0, false), 2 * DAY, 0.01)
    expect(lines.centre[30]).toBeCloseTo(0.5, 12)
    expect(entrySides(pts, countingBars(pts, 0, false), lines)[30]).toBe(1)
  })

  test('nothing is drawn until the window holds enough values', () => {
    const pts = hourly(flat(MIN_WINDOW_VALUES + 1, 0.5))
    const lines = medianLines(pts, countingBars(pts, 0, false), 2 * DAY, 0.01)
    expect(Number.isNaN(lines.centre[MIN_WINDOW_VALUES - 1])).toBe(true)
    expect(lines.centre[MIN_WINDOW_VALUES]).toBeCloseTo(0.5, 12)
  })

  test('values older than the span roll off', () => {
    // 30 bars at 0.30, then 30 at 0.70, one an hour. At bar 60 a 24h window holds only the
    // second block (bars 36..59), so its median is 0.70 and not the 0.50 of both blocks.
    const pts = hourly([...flat(30, 0.3), ...flat(31, 0.7)])
    const counts = countingBars(pts, 0, false)
    expect(medianLines(pts, counts, DAY, 0).centre[60]).toBeCloseTo(0.7, 12)
    expect(medianLines(pts, counts, 30 * DAY, 0).centre[60]).toBeCloseTo(0.5, 12)
  })

  test('the window is a span, not a count: a gap empties it', () => {
    const pts = hourly(flat(40, 0.5))
    pts[39].date = 40 * DAY // a market gap far longer than the window
    const lines = medianLines(pts, countingBars(pts, 0, false), DAY, 0.01)
    expect(Number.isNaN(lines.centre[39])).toBe(true)
  })

  test('q = 1 is the window high and q = 0 its low -- the rolling extreme', () => {
    // rank counts bars, so its window is the previous 30 counting bars here.
    // A quiet base cycling 0.48..0.51, one old spike of 0.70, and then 0.60.
    const base = Array.from({ length: 30 }, (_, i) => [0.48, 0.49, 0.5, 0.51][i % 4])
    base[10] = 0.7
    const pts = hourly([...base, 0.6])
    const counts = countingBars(pts, 0, false)
    const extreme = rankLines(pts, counts, 30, 1)
    expect(extreme.hi[30]).toBeCloseTo(0.7, 12)
    expect(extreme.lo[30]).toBeCloseTo(0.48, 12)
    // At the extreme, 0.60 is short of the window's own high and prints nothing; a shade below
    // the extreme, the same bar is past the line and prints an arrow. That is the whole
    // difference between a high and a quantile, in one bar.
    expect(entrySides(pts, counts, extreme)[30]).toBe(0)
    expect(entrySides(pts, counts, rankLines(pts, counts, 30, 0.98))[30]).toBe(1)
  })

  test('rank draws nothing until its bar count is complete, then rolls one bar at a time', () => {
    const pts = hourly([...flat(9, 0.5), 0.9])
    const counts = countingBars(pts, 0, false)
    const lines = rankLines(pts, counts, 5, 0.9)
    expect(Number.isNaN(lines.hi[4])).toBe(true)
    expect(lines.hi[5]).toBeCloseTo(0.5, 12)
    expect(entrySides(pts, counts, lines)[9]).toBe(1)
  })

  test('non-counting bars are neither compared nor part of the window', () => {
    const pts = hourly([...flat(25, 0.5), 0.99, 0.5])
    pts[25].atCross = false
    const counts = countingBars(pts, 0, true)
    const lines = medianLines(pts, counts, 30 * DAY, 0.01)
    expect(entrySides(pts, counts, lines)[25]).toBe(0)
    expect(lines.centre[26]).toBeCloseTo(0.5, 12)
  })
})

describe('entrySides', () => {
  test('an arrow on entering a zone, not on every bar inside it', () => {
    const pts = hourly([0.6, 0.61, 0.62, 0.5, 0.63, 0.3, 0.31])
    const size = pts.length
    const lines = { centre: new Float64Array(size).fill(0.5), hi: new Float64Array(size).fill(0.55), lo: new Float64Array(size).fill(0.45) }
    expect(Array.from(entrySides(pts, countingBars(pts, 0, false), lines))).toEqual([1, 0, 0, 0, 1, -1, 0])
  })

  test('a bar that does not count does not end the run', () => {
    const pts = hourly([0.6, 0.5, 0.61])
    pts[1].atCross = false
    const counts = countingBars(pts, 0, true)
    const lines = { centre: new Float64Array(3).fill(0.5), hi: new Float64Array(3).fill(0.55), lo: new Float64Array(3).fill(0.45) }
    expect(Array.from(entrySides(pts, counts, lines))).toEqual([1, 0, 0])
  })
})

describe('fixedSides', () => {
  test('is a level: every confident counting bar, not only the first', () => {
    const pts = hourly([0.576, 0.58, 0.5, 0.424, 0.43])
    expect(Array.from(fixedSides(pts, countingBars(pts, 0, false), 0.075))).toEqual([1, 1, 0, -1, 0])
  })

  test("with samplesOnly on it is the server's published `signal`, float comparison included", () => {
    // services/arev.py: `abs(p - 0.5) >= SIGNAL_CONFIDENCE` on a sample bar with a full
    // neighbourhood. 0.575 - 0.5 is a hair under 0.075 in binary, so neither side fires there.
    const counts = countingBars(points, fixture.minNeighbours, true)
    const expected = points.map((pt, i) =>
      counts[i] && Math.abs(pt.p - 0.5) >= 0.075 ? (pt.p > 0.5 ? 1 : -1) : 0
    )
    expect(Array.from(fixedSides(points, counts, 0.075))).toEqual(expected)
    expect(expected.filter((s) => s !== 0).length).toBeGreaterThan(0)
  })
})
