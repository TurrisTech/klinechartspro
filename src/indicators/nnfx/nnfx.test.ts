import { describe, expect, test } from 'bun:test'

import type { Indicator, IndicatorTemplate, KLineData } from 'klinecharts'

import { indicatorSettingsFor } from '../../config/indicators'
import libraryFixture from './fixtures/library_parity.json'
import fixture from './fixtures/parity.json'
import nnfx from './index'
import { trendAges } from './paint'

const bars: KLineData[] = fixture.bars.ts.map((timestamp, i) => ({
  timestamp,
  open: fixture.bars.open[i] as number,
  high: fixture.bars.high[i] as number,
  low: fixture.bars.low[i] as number,
  close: fixture.bars.close[i] as number,
  volume: fixture.bars.volume[i] as number
}))

type Row = Record<string, number | undefined>
type Template = IndicatorTemplate<Row, number>

const templates = new Map(nnfx.map((t) => [t.name, t as unknown as Template]))

// Each template's calcParams, in order, by the names the fixture's `chart` uses.
const PARAM_ORDER: Record<string, string[]> = {
  DODA_STOCH: ['slw', 'pds', 'signal'],
  BANDPASS: ['period', 'delta', 'price'],
  CORR_TREND: ['short', 'long', 'price'],
  HA_SMOOTHED: ['period', 'method', 'period2', 'method2'],
  OSCAR: ['length', 'smoothing'],
  TTF: ['period', 't3', 'b'],
  CHANDELIER: ['range', 'atr', 'mult', 'shift'],
  TREND_AKKAM: ['atr', 'factor']
}

// How each template's row reads as the port's outputs.
const READ: Record<string, Record<string, (row: Row) => number | undefined>> = {
  DODA_STOCH: { stoch: (r) => r.stoch, signal: (r) => r.signal },
  BANDPASS: { bp: (r) => r.bp, trend: (r) => r.trend, slope: (r) => r.slope },
  CORR_TREND: { short: (r) => r.short, long: (r) => r.long },
  HA_SMOOTHED: {
    ha_open: (r) => r.open,
    ha_close: (r) => r.close,
    ha_high: (r) => r.high,
    ha_low: (r) => r.low,
    trend: (r) => r.trend ?? 0
  },
  OSCAR: { rough: (r) => r.rough, oscar: (r) => r.oscar, trend: (r) => r.trend ?? 0 },
  TTF: { ttf: (r) => r.ttf },
  CHANDELIER: { stop: (r) => r.long ?? r.short, trend: (r) => r.trend ?? 0 },
  TREND_AKKAM: { stop: (r) => r.long ?? r.short }
}

function run(name: string, calcParams: number[], data: KLineData[] = bars): Row[] {
  const template = templates.get(name)
  if (template === undefined) throw new Error(`no template ${name}`)
  return template.calc(data, { calcParams } as unknown as Indicator<Row, number>) as Row[]
}

function same(actual: number | undefined, expected: number | null): boolean {
  if (expected === null) return actual === undefined
  return actual !== undefined && Math.abs(actual - expected) <= 1e-9 * Math.abs(expected) + 1e-12
}

describe('parity with the NNFX research ports (notes/research/NoNonSenseForex/nnfx/ports)', () => {
  test('the fixture is the generated one, and with library_parity.json covers every template', () => {
    expect(fixture.$comment).toContain('gen_nnfx_chart_parity.py')
    const covered = new Set([...fixture.cases.map((c) => c.template), ...libraryFixture.cases.map((c) => c.template)])
    expect(covered).toEqual(new Set(templates.keys()))
  })

  for (const c of fixture.cases) {
    const chart = c.chart as unknown as Record<string, number>
    const params = PARAM_ORDER[c.template].map((k) => chart[k])
    test(`${c.template}(${params.join(', ')})`, () => {
      const rows = run(c.template, params)
      expect(rows.length).toBe(bars.length)
      const out = c.out as unknown as Record<string, Array<number | null>>
      for (const [key, read] of Object.entries(READ[c.template])) {
        const expected = out[key]
        expect(expected).toBeDefined()
        const mismatches = rows.flatMap((row, i) => (same(read(row), expected[i]) ? [] : [{ i, actual: read(row), expected: expected[i] }]))
        expect({ key, mismatches: mismatches.slice(0, 5) }).toEqual({ key, mismatches: [] })
        // Not vacuous: the series has values.
        expect(expected.filter((v) => v !== null && v !== 0).length).toBeGreaterThan(bars.length / 4)
      }
    })
  }

  test('the signals the chart draws take both sides in the fixture', () => {
    // Trend Akkam at its default 6 x ATR(150) never turns in the fixture's 100 bars with a value.
    for (const [name, params] of [['CHANDELIER', [6, 7, 2.5, 0]], ['TREND_AKKAM', [20, 3]]] as const) {
      const rows = run(name, [...params])
      expect(new Set(rows.map((r) => r.trend).filter((t) => t !== undefined))).toEqual(new Set([1, -1]))
      // Exactly one of the two lines on a bar with a direction, so the line breaks at a flip.
      for (const r of rows) expect(r.trend === undefined || (r.long === undefined) !== (r.short === undefined)).toBe(true)
    }
    const oscar = run('OSCAR', [8, 0])
    expect(new Set(oscar.map((r) => r.signal).filter((s) => s !== undefined))).toEqual(new Set([1, -1]))
  })
})

describe('no lookahead', () => {
  // Every value at bar i is a function of bars 0..i only: a run on a prefix of the bars gives the
  // same rows, bar for bar, as the full run gives for that prefix.
  for (const [name, template] of templates) {
    test(name, () => {
      const full = run(name, template.calcParams as number[])
      for (const cut of [60, 120, 200]) {
        expect(run(name, template.calcParams as number[], bars.slice(0, cut))).toEqual(full.slice(0, cut))
      }
    })
  }
})

describe('settings', () => {
  for (const [name, template] of templates) {
    test(`${name}: the dialog's defaults are the template's calcParams`, () => {
      expect(indicatorSettingsFor(name).map((s) => s.default)).toEqual(template.calcParams as number[])
    })
  }

  test('a blank settings field falls back to the default rather than breaking the calc', () => {
    for (const [name, template] of templates) {
      const blank = (template.calcParams as number[]).map(() => undefined) as unknown as number[]
      expect(run(name, blank)).toEqual(run(name, template.calcParams as number[]))
    }
  })
})

describe('trendAges', () => {
  test('counts from the first change, not from the first known side', () => {
    expect(trendAges([undefined, 1, 1, -1, -1, -1, 1, 0, 1])).toEqual([undefined, undefined, undefined, 1, 2, 3, 1, undefined, undefined])
  })
})
