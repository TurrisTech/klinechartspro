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

describe('a close equal to a line holds the trend, at the quotes\' precision', () => {
  // The published rule in exact arithmetic: integer ticks, so n * close vs the window's sum is
  // exact. Long when the close is strictly above the high MA, short strictly below the low one,
  // and HOLD on equality -- which the floats must reproduce although every price is stored with
  // noise (ticks / 1e5 is not exact in binary) and a tie then arrives as +-1e-17.
  function exactTrend(high: bigint[], low: bigint[], close: bigint[], n: number, shift: number, weighted: boolean): number[] {
    const norm = BigInt(weighted ? (n * (n + 1)) / 2 : n)
    const ma = (xs: bigint[], t: number) => {
      let sum = 0n
      for (let k = 0; k < n; k++) sum += xs[t - k] * BigInt(weighted ? n - k : 1)
      return sum
    }
    let trend = 0
    return close.map((c, i) => {
      const t = i - shift
      if (t - n + 1 < 0) return trend
      const scaled = c * norm
      if (scaled > ma(high, t)) trend = 1
      else if (scaled < ma(low, t)) trend = -1
      return trend
    })
  }

  // Five-decimal quotes on a coarse grid, so the close lands exactly on an average often.
  let seed = 11
  const rand = () => {
    seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
    return seed / 2 ** 31
  }
  let mid = 110_000
  const ticks = Array.from({ length: 4_000 }, () => {
    mid += Math.round((rand() - 0.5) * 6) * 2
    const high = mid + Math.round(rand() * 3) * 2
    const low = mid - Math.round(rand() * 3) * 2
    const close = low + Math.round(rand() * ((high - low) / 2)) * 2
    return { high, low, close }
  })
  const quoted: KLineData[] = ticks.map((t, i) => ({ timestamp: i, open: t.close / 1e5, high: t.high / 1e5, low: t.low / 1e5, close: t.close / 1e5 }))
  const big = (k: 'high' | 'low' | 'close') => ticks.map((t) => BigInt(t[k]))

  for (const ma of ['SMA', 'WMA'] as const) {
    for (const shift of [0, 1]) {
      test(`${ma}, shift ${shift}: the trend is the exact rule's on every bar`, () => {
        let ties = 0
        for (const length of [1, 2, 3, 4, 10, 15]) {
          const expected = exactTrend(big('high'), big('low'), big('close'), length, shift, ma === 'WMA')
          const rows = sslChannel(quoted, { length, ma, shift })
          expect(rows.map((r) => r.trend ?? 0)).toEqual(expected)
          // Not vacuous: count the bars whose close sits exactly on a line.
          const s = sslChannel(quoted, { length, ma, shift })
          s.forEach((r, i) => {
            if (r.up !== undefined && (r.up === quoted[i].close || r.down === quoted[i].close)) ties++
          })
        }
        expect(ties).toBeGreaterThan(0)
      })
    }
  }

  test('a tie arriving as float noise holds: 0.1 + 0.2 is not above 0.3', () => {
    const bars: KLineData[] = [
      { timestamp: 0, open: 0.2, high: 0.1, low: 0.05, close: 0.06 },
      // high MA (0.1 + 0.5) / 2 = 0.3, low MA 0.05: a close of 0.04 is below it -- short
      { timestamp: 1, open: 0.2, high: 0.5, low: 0.05, close: 0.04 },
      // high MA (0.5 + 0.1) / 2 = 0.3 again, and the close is 0.1 + 0.2 = 0.30000000000000004: a tie
      { timestamp: 2, open: 0.2, high: 0.1, low: 0.05, close: 0.1 + 0.2 }
    ]
    const rows = sslChannel(bars, { length: 2, ma: 'SMA', shift: 0 })
    expect(rows[1].trend).toBe(-1)
    expect(0.1 + 0.2 > (0.5 + 0.1) / 2).toBe(true) // the naive comparison would flip it long
    expect(rows[2].trend).toBe(-1)
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
