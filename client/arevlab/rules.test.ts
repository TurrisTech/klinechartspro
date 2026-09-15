import { describe, expect, test } from 'bun:test'
import fixture from './fixtures/rules_parity.json'
import {
  bandLines,
  entrySides,
  fixedSides,
  medianLines,
  quantileSorted,
  rankLines,
  validSamples,
  type LabPoint,
  type RuleLines
} from './rules'

// The lab's rules are a port of wdashboard-server services/arev21outlier.py. The parity cases
// are that module's own output on seeded data (fixtures/generate.py); the rest pins the
// semantics a reader of the chart relies on, in cases small enough to check by eye.

interface Case {
  kind: 'rank' | 'median' | 'prior'
  window?: number
  q?: number
  width: number
  centreIn?: (number | null)[]
  centre: (number | null)[]
  hi: (number | null)[]
  lo: (number | null)[]
  side: number[]
}

const points: LabPoint[] = fixture.rows.map((r) => ({ date: r.date, p: r.p ?? Number.NaN, n: r.n, atCross: r.atCross }))

function expectLines(actual: RuleLines, expected: Case, label: string): void {
  for (const name of ['centre', 'hi', 'lo'] as const) {
    expected[name].forEach((want, i) => {
      const got = actual[name][i]
      if (want === null) expect(Number.isNaN(got), `${label} ${name}[${i}]`).toBe(true)
      else expect(Math.abs(got - want), `${label} ${name}[${i}] ${got} vs ${want}`).toBeLessThan(1e-12)
    })
  }
}

describe('parity with the server rules', () => {
  const valid = validSamples(points, fixture.minNeighbours)

  for (const c of fixture.cases as Case[]) {
    const label = `${c.kind} window=${c.window} q=${c.q} width=${c.width}`
    test(label, () => {
      let lines: RuleLines
      if (c.kind === 'rank') lines = rankLines(points, valid, c.window as number, c.q as number)
      else if (c.kind === 'median') lines = medianLines(points, valid, c.window as number, c.width)
      else lines = bandLines(Float64Array.from((c.centreIn ?? []).map((v) => v ?? Number.NaN)), c.width)
      expectLines(lines, c, label)
      expect(Array.from(entrySides(points, valid, lines))).toEqual(c.side)
    })
  }

  test('the fixture exercises both sides of every rule', () => {
    for (const c of fixture.cases as Case[]) {
      expect(c.side.filter((s) => s === 1).length).toBeGreaterThan(0)
      expect(c.side.filter((s) => s === -1).length).toBeGreaterThan(0)
    }
  })
})

const pt = (p: number, atCross = true, n = 100): LabPoint => ({ date: 0, p, n, atCross })
const series = (ps: number[]): LabPoint[] => ps.map((p, i) => ({ ...pt(p), date: i }))

describe('quantileSorted', () => {
  test('is numpy linear interpolation', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.25)).toBeCloseTo(1.75, 12)
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 12)
    expect(quantileSorted([1, 2, 3, 4], 0.85)).toBeCloseTo(3.55, 12)
    expect(quantileSorted([7], 0.9)).toBe(7)
  })
})

describe('validSamples', () => {
  test('a sample bar with enough neighbours and a finite p', () => {
    expect(validSamples([pt(0.6), pt(0.6, false), pt(0.6, true, 49), pt(Number.NaN)], 50)).toEqual([true, false, false, false])
  })
})

describe('the rolling rules', () => {
  test('a bar is judged against the samples BEFORE it, and is blank until a full window', () => {
    const pts = series([0.5, 0.52, 0.48, 0.9])
    const lines = medianLines(pts, validSamples(pts, 0), 3, 0.01)
    expect(Number.isNaN(lines.centre[2])).toBe(true)
    // bar 3's window is bars 0..2 -- its own 0.9 is not in it, or no outlier could ever be.
    expect(lines.centre[3]).toBeCloseTo(0.5, 12)
    expect(entrySides(pts, validSamples(pts, 0), lines)[3]).toBe(1)
  })

  test('non-samples neither enter the window nor move it', () => {
    const pts = series([0.4, 0.5, 0.6, 0.99, 0.55])
    pts[3].atCross = false
    const lines = rankLines(pts, validSamples(pts, 0), 3, 0.5)
    expect(lines.centre[4]).toBeCloseTo(0.5, 12)
    expect(lines.centre[3]).toBeCloseTo(0.5, 12)
  })
})

describe('entrySides', () => {
  test('an arrow on entering a zone, not on every sample inside it', () => {
    const pts = series([0.6, 0.61, 0.62, 0.5, 0.63, 0.3, 0.31])
    const size = pts.length
    const lines = { centre: new Float64Array(size).fill(0.5), hi: new Float64Array(size).fill(0.55), lo: new Float64Array(size).fill(0.45) }
    expect(Array.from(entrySides(pts, validSamples(pts, 0), lines))).toEqual([1, 0, 0, 0, 1, -1, 0])
  })

  test('an invalid sample in between does not end the run', () => {
    const pts = series([0.6, 0.5, 0.61])
    pts[1].atCross = false
    const lines = { centre: new Float64Array(3).fill(0.5), hi: new Float64Array(3).fill(0.55), lo: new Float64Array(3).fill(0.45) }
    expect(Array.from(entrySides(pts, validSamples(pts, 0), lines))).toEqual([1, 0, 0])
  })
})

describe('fixedSides', () => {
  test('is a level: every confident valid sample, not only the first', () => {
    const pts = series([0.576, 0.58, 0.5, 0.424, 0.43])
    expect(Array.from(fixedSides(pts, validSamples(pts, 0), 0.075))).toEqual([1, 1, 0, -1, 0])
  })

  test("compares in floating point exactly as the server's published `signal` does", () => {
    // services/arev.py: `abs(p - 0.5) >= SIGNAL_CONFIDENCE`, and 0.575 - 0.5 is a hair under
    // 0.075 in binary -- so neither side draws an arrow there, and the lab at its defaults
    // draws the AREV pane's arrows rather than one more.
    const pts = series([0.575, 0.425])
    expect(Array.from(fixedSides(pts, validSamples(pts, 0), 0.075))).toEqual(
      pts.map((x) => (Math.abs(x.p - 0.5) >= 0.075 ? (x.p > 0.5 ? 1 : -1) : 0))
    )
  })
})
