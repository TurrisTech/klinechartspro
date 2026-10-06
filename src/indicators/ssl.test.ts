import { describe, expect, test } from 'bun:test'

import type { Indicator, KLineData } from 'klinecharts'

import fixture from './fixtures/ssl_parity.json'
import ssl, { SSL_MA, type Ssl, sslChannel, sslOptions, type SslMa } from './ssl'

const bars: KLineData[] = fixture.bars.ts.map((timestamp, i) => ({
  timestamp,
  open: fixture.bars.open[i] as number,
  high: fixture.bars.high[i] as number,
  low: fixture.bars.low[i] as number,
  close: fixture.bars.close[i] as number,
  volume: fixture.bars.volume[i] as number
}))

function close(actual: number | undefined, expected: number | null): boolean {
  if (expected === null) return actual === undefined
  return actual !== undefined && Math.abs(actual - expected) <= 1e-9 * Math.abs(expected)
}

describe('parity with the NNFX research port (nnfx/ports/tv_ssl_multi_ma.py)', () => {
  test('the fixture is the generated one, and covers every MA at both shifts', () => {
    expect(fixture.$comment).toContain('gen_ssl_chart_parity.py')
    for (const shift of [0, 1]) {
      expect(new Set(fixture.cases.filter((c) => c.shift === shift).map((c) => c.ma))).toEqual(new Set(SSL_MA))
    }
  })

  for (const c of fixture.cases) {
    test(`${c.ma}(${c.length}) shift ${c.shift}`, () => {
      const rows = sslChannel(bars, { length: c.length, ma: c.ma as SslMa, shift: c.shift })
      const mismatches = rows.flatMap((row, i) => {
        const ok = close(row.up, c.up[i]) && close(row.down, c.down[i]) && (row.trend ?? 0) === c.trend[i]
        return ok ? [] : [{ i, row, up: c.up[i], down: c.down[i], trend: c.trend[i] }]
      })
      expect(mismatches).toEqual([])
      // Not vacuous: both sides and some flips.
      expect(new Set(c.trend)).toEqual(new Set([0, 1, -1]))
    })
  }
})

describe('the MT4 form (shift 1) is the MQL source, read independently', () => {
  // mladen's "SSL channel chart" (the "SSL Channel Chart Alert" VP named), written the slow
  // way: every bar's SMAs summed over the Lb bars BEFORE it -- iMA(..., i+1) -- and Hlv held
  // when the close is between them.
  function mt4(data: KLineData[], lb: number): Array<{ up?: number; down?: number; trend: number }> {
    let hlv = 0
    return data.map((bar, i) => {
      if (i < lb) return { trend: 0 }
      let high = 0
      let low = 0
      for (let j = i - lb; j < i; j++) {
        high += data[j].high
        low += data[j].low
      }
      high /= lb
      low /= lb
      if (bar.close > high) hlv = 1
      if (bar.close < low) hlv = -1
      if (hlv === 0) return { trend: 0 } // MT4 draws an implicit long here; the chart draws nothing
      return hlv === -1 ? { up: low, down: high, trend: -1 } : { up: high, down: low, trend: 1 }
    })
  }

  test.each([3, 10, 15, 30])('SSL(%i)', (length) => {
    const expected = mt4(bars, length)
    const rows = sslChannel(bars, { length, ma: 'SMA', shift: 1 })
    rows.forEach((row, i) => {
      expect(row.trend ?? 0).toBe(expected[i].trend)
      if (expected[i].trend !== 0) {
        expect(row.up).toBeCloseTo(expected[i].up as number, 12)
        expect(row.down).toBeCloseTo(expected[i].down as number, 12)
      }
    })
  })
})

describe('sslChannel', () => {
  test('no lookahead: every bar of a truncated run equals the full run', () => {
    for (const ma of SSL_MA) {
      const full = sslChannel(bars, { length: 10, ma, shift: 0 })
      for (const end of [20, 47, 80, 119]) {
        expect(sslChannel(bars.slice(0, end), { length: 10, ma, shift: 0 })).toEqual(full.slice(0, end))
      }
    }
  })

  test('the lines cross exactly at a flip, and age counts from the flip bar', () => {
    const rows = sslChannel(bars, { length: 15, ma: 'SMA', shift: 0 })
    let flips = 0
    rows.forEach((row, i) => {
      if (row.up === undefined || row.down === undefined) return
      // Long: the up line is the high MA, above the down line. Short: below it.
      expect(Math.sign(row.up - row.down)).toBe(row.trend as number)
      const before = rows[i - 1]?.trend
      if (before !== undefined && before !== row.trend) {
        flips++
        expect(row.age).toBe(1)
      } else if (rows[i - 1]?.age !== undefined) {
        expect(row.age).toBe((rows[i - 1].age as number) + 1)
      }
    })
    expect(flips).toBeGreaterThan(2)
  })

  test('the trend is unknown until a close leaves the channel; its age until the first flip', () => {
    const rows = sslChannel(bars, { length: 15, ma: 'SMA', shift: 0 })
    const first = rows.findIndex((row) => row.trend !== undefined)
    const firstFlip = rows.findIndex((row, i) => i > 0 && row.trend !== undefined && rows[i - 1].trend !== undefined && row.trend !== rows[i - 1].trend)
    expect(first).toBeGreaterThanOrEqual(14)
    expect(rows.slice(0, first).every((row) => Object.keys(row).length === 0)).toBe(true)
    expect(rows.slice(first, firstFlip).every((row) => row.age === undefined)).toBe(true)
    expect(rows[firstFlip].age).toBe(1)
  })

  test('the trend is exact wherever the window starts, once a close has left the channel', () => {
    const full = sslChannel(bars, { length: 10, ma: 'SMA', shift: 1 })
    const late = sslChannel(bars.slice(40), { length: 10, ma: 'SMA', shift: 1 })
    const settled = late.findIndex((row) => row.trend !== undefined)
    late.slice(settled).forEach((row, i) => {
      expect(row.trend).toBe(full[40 + settled + i].trend)
      expect(row.up).toBeCloseTo(full[40 + settled + i].up as number, 12)
    })
  })

  test('VWMA without volume draws nothing rather than a wrong line', () => {
    const rows = sslChannel(bars.map(({ volume: _, ...bar }) => bar), { length: 10, ma: 'VWMA', shift: 0 })
    expect(rows.every((row) => row.up === undefined && row.down === undefined)).toBe(true)
  })
})

describe('SSL template', () => {
  test('defaults to the NNFX baseline: SSL(15), SMA, TradingView form, arrows, 12% fill', () => {
    expect(ssl.calcParams).toEqual([15, 0, 0, 1, 12])
    expect(sslOptions(ssl.calcParams as number[])).toEqual({ length: 15, ma: 'SMA', shift: 0 })
  })

  test('a blank or out-of-range setting reads as its default', () => {
    expect(sslOptions([undefined, 9, undefined])).toEqual({ length: 15, ma: 'SMA', shift: 0 })
    expect(sslOptions([0, -1, -3])).toEqual({ length: 1, ma: 'SMA', shift: 0 })
    expect(sslOptions([20.7, 5, 1])).toEqual({ length: 20, ma: 'HMA', shift: 1 })
  })

  test('only the two lines are figures, so the trend never enters the price axis', () => {
    expect(ssl.figures?.map((f) => f.key)).toEqual(['up', 'down'])
  })

  // -- draw and legend, against a recording canvas -------------------------------------------

  const UP = '#2dc08e'
  const DOWN = '#f92855'

  function harness(params: number[], crosshairIndex?: number) {
    const result = sslChannel(bars, sslOptions(params))
    const indicator = { name: 'SSL', shortName: 'SSL', calcParams: params, result, precision: 5 } as unknown as Indicator<Ssl>
    const chart = {
      getDataList: () => bars,
      getVisibleRange: () => ({ from: 0, to: bars.length, realFrom: 0, realTo: bars.length - 1 }),
      getBarSpace: () => ({ bar: 6 }),
      getStyles: () => ({
        candle: { bar: { upColor: UP, downColor: DOWN } },
        indicator: { tooltip: { legend: { color: '#888' }, features: [] } }
      }),
      getThousandsSeparator: () => ({ sign: ',', format: (v: string | number) => String(v) }),
      getDecimalFold: () => ({ threshold: 3, format: (v: string | number) => String(v) })
    }
    const fills: Array<{ style: string; path: unknown }> = []
    const strokes: string[] = []
    const arrows: string[] = []
    const ctx = {
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 1,
      dash: [4, 4] as number[],
      setLineDash(segments: number[]) {
        this.dash = segments
      },
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      stroke() {
        strokes.push(`${this.strokeStyle}${this.dash.length > 0 ? ' dashed' : ''}`)
      },
      fill(path?: unknown) {
        if (path) fills.push({ style: this.fillStyle, path })
        else arrows.push(this.fillStyle)
      }
    }
    const axis = { convertToPixel: (v: number) => v }
    const params_ = { chart, indicator, crosshair: { dataIndex: crosshairIndex }, ctx, xAxis: axis, yAxis: axis }
    return { result, fills, strokes, arrows, params: params_ }
  }

  // Bun has no Path2D; a recorder is enough to count what was filled.
  ;(globalThis as { Path2D?: unknown }).Path2D ??= class {
    moveTo() {}
    lineTo() {}
    closePath() {}
  }

  test('draws both lines solid in the candle colours, a fill per trend, and an arrow per flip', () => {
    const { result, fills, strokes, arrows, params } = harness([15, 0, 0, 1, 12])
    expect(ssl.draw?.(params as never)).toBe(true)
    expect(strokes).toEqual([DOWN, UP])
    expect(fills.map((f) => f.style)).toEqual(['rgba(45, 192, 142, 0.12)', 'rgba(249, 40, 85, 0.12)'])
    const flips = result.filter((row, i) => i > 0 && row.trend !== undefined && result[i - 1].trend !== undefined && row.trend !== result[i - 1].trend)
    expect(arrows).toHaveLength(flips.length)
    expect(arrows).toEqual(flips.map((row) => ((row.trend as number) > 0 ? UP : DOWN)))
  })

  test('arrows and fill switch off', () => {
    const { fills, arrows, params } = harness([15, 0, 0, 0, 0])
    ssl.draw?.(params as never)
    expect(fills).toEqual([])
    expect(arrows).toEqual([])
  })

  test('the legend names the form and reads the hovered bar', () => {
    const { result, params } = harness([10, 1, 1, 1, 12])
    const i = result.findIndex((row) => row.age === 3)
    const tooltip = ssl.createTooltipDataSource?.({ ...params, crosshair: { dataIndex: i } } as never)
    expect(tooltip?.calcParamsText).toBe('(10, EMA, shift 1)')
    const [up, down, trend] = tooltip?.legends ?? []
    expect(up.value).toMatchObject({ text: (result[i].up as number).toFixed(5), color: UP })
    expect(down.value).toMatchObject({ text: (result[i].down as number).toFixed(5), color: DOWN })
    expect(trend.value).toMatchObject({ text: `${(result[i].trend as number) > 0 ? '▲ long' : '▼ short'} · 3 bars` })
    // Reserved as wide as the widest it will be, so the row does not move under the crosshair.
    expect((trend.value as { reserve: string }).reserve.length).toBeGreaterThanOrEqual((trend.value as { text: string }).text.length)
  })

  test('the legend before the trend is known says so', () => {
    const { params } = harness([15, 0, 0, 1, 12], 0)
    const legends = ssl.createTooltipDataSource?.(params as never).legends ?? []
    expect(legends.map((l) => (l.value as { text: string }).text)).toEqual(['n/a', 'n/a', 'n/a'])
  })
})
