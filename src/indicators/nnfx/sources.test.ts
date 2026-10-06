import { describe, expect, test } from 'bun:test'

import type { Indicator, KLineData } from 'klinecharts'

import fixture from './fixtures/parity.json'
import nnfx from './index'

// The NNFX templates against their PUBLISHED source code, transliterated literally -- MQL's
// timeseries indexing (0 = the newest bar, i + 1 the bar before), its loops in its order, its
// globals as globals -- so each check is independent of both the templates and the Python ports
// that fixtures/parity.json is generated from. The sources (README.md, "Checked against the
// published code"): Stonehill's MQL4/MQL5 files, the public MQ4 of Heiken Ashi Smoothed, mladen's
// MQL5 Correlation Trend, and the OSCAR Pine script. MT4's built-ins the sources call -- iMA,
// iMAOnArray, iATR -- are written out from MetaQuotes' own "Moving Averages.mq4" and "ATR.mq4".
//
// Where a template departs from its source on purpose (a seed, a warm-up), the check says so and
// either removes exactly that difference or compares only after it has decayed.

const bars: KLineData[] = fixture.bars.ts.map((timestamp, i) => ({
  timestamp,
  open: fixture.bars.open[i] as number,
  high: fixture.bars.high[i] as number,
  low: fixture.bars.low[i] as number,
  close: fixture.bars.close[i] as number,
  volume: fixture.bars.volume[i] as number
}))
const Bars = bars.length
const series = (f: (b: KLineData) => number) => bars.map(f).reverse()
const Open = series((b) => b.open)
const High = series((b) => b.high)
const Low = series((b) => b.low)
const Close = series((b) => b.close)
const EMPTY = Number.NaN

type Row = Record<string, number | undefined>
const templates = new Map(nnfx.map((t) => [t.name, t]))
function run(name: string, calcParams: number[]): Row[] {
  const t = templates.get(name)
  if (t === undefined) throw new Error(name)
  return (t.calc as (d: KLineData[], i: Indicator) => Row[])(bars, { calcParams } as unknown as Indicator)
}
/** A series array (0 = newest) as a chronological one. */
const chrono = (s: number[]) => [...s].reverse()

function near(a: number | undefined, b: number, tol = 1e-9): boolean {
  if (!Number.isFinite(b)) return a === undefined
  return a !== undefined && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b))
}
/** Bars (chronological) from `from` on where `actual` differs from `expected`. */
function mismatches(actual: Array<number | undefined>, expected: number[], from = 0, tol = 1e-9) {
  const out: Array<{ i: number; actual: number | undefined; expected: number }> = []
  for (let i = from; i < expected.length; i++) if (!near(actual[i], expected[i], tol)) out.push({ i, actual: actual[i], expected: expected[i] })
  return out.slice(0, 5)
}
/** The first bar from which `actual` equals `expected` to the end. */
function matchingTailFrom(actual: Array<number | undefined>, expected: number[], tol = 1e-9): number {
  let k = expected.length
  while (k > 0 && near(actual[k - 1], expected[k - 1], tol)) k--
  return k
}

// -- MT4 built-ins, from MetaQuotes' Moving Averages.mq4 and ATR.mq4 ---------------------------

/** iMA / iMAOnArray over a series array, for every bar; an EMPTY (NaN) older tail is not data. */
function iMAOnArray(price: number[], period: number, method: number): number[] {
  const out = new Array<number>(price.length).fill(EMPTY)
  let oldest = price.length - 1
  while (oldest >= 0 && !Number.isFinite(price[oldest])) oldest--
  if (method === 1) {
    // ema(): the oldest bar is its own value, then Close*pr + prev*(1-pr).
    const pr = 2 / (period + 1)
    out[oldest] = price[oldest]
    for (let pos = oldest - 1; pos >= 0; pos--) out[pos] = price[pos] * pr + out[pos + 1] * (1 - pr)
  } else if (method === 2) {
    // smma(): the first value the sum of the oldest `period`, then (prev*(n-1) + price)/n.
    let pos = oldest - period + 1
    let sum = 0
    for (let k = pos; k < pos + period; k++) sum += price[k]
    out[pos] = sum / period
    for (pos--; pos >= 0; pos--) out[pos] = (out[pos + 1] * (period - 1) + price[pos]) / period
  } else {
    for (let i = 0; i + period - 1 <= oldest; i++) {
      let sum = 0
      let weight = 0
      for (let k = 0; k < period; k++) {
        const w = method === 3 ? period - k : 1
        sum += price[i + k] * w
        weight += w
      }
      out[i] = sum / weight
    }
  }
  return out
}

/** iATR: ATR.mq4's true range (the oldest bar's is its high - low), averaged by an SMA. */
function iATR(period: number, warmupZero = false): number[] {
  const tr = Close.map((_, i) =>
    i === Bars - 1 ? High[i] - Low[i] : Math.max(High[i], Close[i + 1]) - Math.min(Low[i], Close[i + 1])
  )
  const atr = iMAOnArray(tr, period, 0)
  // ATR.mq4 zeroes its oldest bars; a source that reads them sees 0 there.
  return warmupZero ? atr.map((v) => (Number.isFinite(v) ? v : 0)) : atr
}

/** Highest / Lowest(NULL, 0, mode, count, start): the index of the extreme of [start, start+count-1]. */
function Highest(xs: number[], count: number, start: number): number {
  let best = start
  for (let k = start; k < Math.min(start + count, Bars); k++) if (xs[k] > xs[best]) best = k
  return best
}
function Lowest(xs: number[], count: number, start: number): number {
  let best = start
  for (let k = start; k < Math.min(start + count, Bars); k++) if (xs[k] < xs[best]) best = k
  return best
}

// -- mladen's getPrice (band pass filter.mq4), its enPrices numbering ---------------------------

function getPriceSeries(tprice: number): number[] {
  const out = new Array<number>(Bars).fill(EMPTY)
  const workHa: number[][] = []
  for (let i = Bars - 1; i >= 0; i--) {
    const r = Bars - i - 1
    const [o, h, l, c] = [Open[i], High[i], Low[i], Close[i]]
    if (tprice >= 11) {
      const haOpen = r > 0 ? (workHa[r - 1][2] + workHa[r - 1][3]) / 2.0 : (o + c) / 2
      let haClose = (o + h + l + c) / 4.0
      if (tprice >= 22 && tprice <= 32) haClose = h !== l ? (o + c) / 2.0 + ((c - o) / (h - l)) * Math.abs((c - o) / 2.0) : (o + c) / 2.0
      const haHigh = Math.max(h, Math.max(haOpen, haClose))
      const haLow = Math.min(l, Math.min(haOpen, haClose))
      workHa[r] = haOpen < haClose ? [haLow, haHigh, haOpen, haClose] : [haHigh, haLow, haOpen, haClose]
      const t = tprice >= 22 ? tprice - 11 : tprice
      out[i] =
        t === 11 ? haClose
        : t === 12 ? haOpen
        : t === 13 ? haHigh
        : t === 14 ? haLow
        : t === 15 ? (haHigh + haLow) / 2.0
        : t === 19 ? (haOpen + haClose) / 2.0
        : t === 16 ? (haHigh + haLow + haClose) / 3.0
        : t === 17 ? (haHigh + haLow + haClose + haClose) / 4.0
        : t === 18 ? (haHigh + haLow + haClose + haOpen) / 4.0
        : t === 20 ? (haClose > haOpen ? (haHigh + haClose) / 2.0 : (haLow + haClose) / 2.0)
        : haClose > haOpen ? haHigh : haClose < haOpen ? haLow : haClose
      continue
    }
    out[i] =
      tprice === 0 ? c
      : tprice === 1 ? o
      : tprice === 2 ? h
      : tprice === 3 ? l
      : tprice === 4 ? (h + l) / 2.0
      : tprice === 8 ? (o + c) / 2.0
      : tprice === 5 ? (h + l + c) / 3.0
      : tprice === 6 ? (h + l + c + c) / 4.0
      : tprice === 7 ? (h + l + c + o) / 4.0
      : tprice === 9 ? (c > o ? (h + c) / 2.0 : (l + c) / 2.0)
      : c > o ? h : c < o ? l : c
  }
  return out
}

// -- the sources ----------------------------------------------------------------------------------

describe('Doda-Stochastic-modified.mq4 (Niels, 2023)', () => {
  function source(Slw: number, Pds: number, Slwsignal: number) {
    const ExtHistoBuffer3 = iMAOnArray(Close, Slw, 1) // iMA(NULL,0,Slw,0,MODE_EMA,PRICE_CLOSE,shift)
    const ExtHistoBuffer4 = new Array<number>(Bars).fill(EMPTY)
    for (let shift = Bars - 1; shift >= 0; shift--) {
      const window = ExtHistoBuffer3.slice(shift, shift + Pds) // ArrayMinimum/Maximum(…, Pds, shift)
      const minval = Math.min(...window)
      const maxval = Math.max(...window)
      ExtHistoBuffer4[shift] = maxval - minval !== 0 ? (100 * (ExtHistoBuffer3[shift] - minval)) / (maxval - minval) : 0.0
    }
    // iMAOnArray(…, MODE_EMA, shift) inside the loop reads only shift and older: the same as after it.
    const ExtHistoBuffer = iMAOnArray(ExtHistoBuffer4, Slw, 1)
    const ExtHistoBuffer2 = iMAOnArray(ExtHistoBuffer, Slwsignal, 1)
    return { stoch: chrono(ExtHistoBuffer), signal: chrono(ExtHistoBuffer2) }
  }
  test.each([[12, 20, 14], [8, 13, 9], [3, 30, 5]])('(%i, %i, %i): every bar', (slw, pds, sig) => {
    const src = source(slw, pds, sig)
    const rows = run('DODA_STOCH', [slw, pds, sig])
    expect(mismatches(rows.map((r) => r.stoch), src.stoch)).toEqual([])
    expect(mismatches(rows.map((r) => r.signal), src.signal)).toEqual([])
  })
})

describe('band pass filter.mq4 (mladen, after Ehlers)', () => {
  function source(BandPassPeriod: number, Price: number, Delta: number, seedWithPrice: boolean) {
    const prices = getPriceSeries(Price)
    const bp = new Array<number>(Bars).fill(EMPTY)
    const slope = new Array<number>(Bars).fill(EMPTY)
    const trend = new Array<number>(Bars).fill(EMPTY)
    const beta = Math.cos((2.0 * Math.PI) / BandPassPeriod)
    const gamma = 1.0 / Math.cos((4.0 * Math.PI * Delta) / BandPassPeriod)
    const alpha = gamma - Math.sqrt(gamma * gamma - 1.0)
    for (let i = Bars - 1; i >= 0; i--) {
      bp[i] =
        i < Bars - 2
          ? 0.5 * (1.0 - alpha) * (prices[i] - prices[i + 2]) + beta * (1.0 + alpha) * bp[i + 1] - alpha * bp[i + 2]
          : seedWithPrice ? prices[i] : 0 // the template's one departure: a zero seed
      slope[i] = i < Bars - 1 ? (bp[i] > bp[i + 1] ? 1 : bp[i] < bp[i + 1] ? -1 : slope[i + 1]) : 0
      trend[i] = i < Bars - 1 ? (bp[i] > 0 ? 1 : bp[i] < 0 ? -1 : trend[i + 1]) : 0
    }
    return { bp: chrono(bp), slope: chrono(slope), trend: chrono(trend), alpha, beta }
  }
  test.each([[50, 4, 0.1], [20, 0, 0.3], [30, 15, 0.1], [40, 26, 0.2], [25, 9, 0.1]])(
    '(%i, price %i, delta %f): every bar, with the seed made the same',
    (period, price, delta) => {
      const src = source(period, price, delta, false)
      const rows = run('BANDPASS', [period, delta, price])
      expect(mismatches(rows.map((r) => r.bp), src.bp, 2)).toEqual([])
      expect(mismatches(rows.map((r) => r.slope), src.slope)).toEqual([])
      expect(mismatches(rows.map((r) => r.trend), src.trend)).toEqual([])
    }
  )
  test("the source's own price seed is the only other difference: the gap obeys the bare recursion", () => {
    const src = source(50, 4, 0.1, true)
    const rows = run('BANDPASS', [50, 0.1, 4])
    const gap = src.bp.map((v, i) => v - (i < 2 ? 0 : (rows[i].bp as number)))
    for (let i = 2; i < Bars; i++) {
      const homogeneous = src.beta * (1 + src.alpha) * gap[i - 1] - src.alpha * gap[i - 2]
      expect(Math.abs(gap[i] - homogeneous)).toBeLessThan(1e-12)
    }
    // ...and it is not small on a chart's window: still over a tenth of the filter's range here.
    const range = Math.max(...rows.slice(100).map((r) => Math.abs(r.bp as number)))
    expect(Math.abs(gap[Bars - 1])).toBeGreaterThan(0.1 * range)
  })
})

describe('Correlation_trend_indicator.mq5 (mladen, 2020)', () => {
  // The MQL5 reads close[]; the MT4 build Stonehill carries takes mladen's price list instead.
  function source(inpPeriodShort: number, inpPeriodLong: number, price: number[]) {
    const _longPeriod = Math.max(inpPeriodShort, inpPeriodLong)
    const _shortPeriod = Math.min(inpPeriodShort, inpPeriodLong)
    const vals: number[] = []
    const vall: number[] = []
    for (let i = 0; i < Bars; i++) {
      let [SumSx, SumLx, SumSy, SumLy, SumSxx, SumLxx, SumSxy, SumLxy, SumSyy, SumLyy] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      for (let k = 0; k < _longPeriod && i >= k; k++) {
        const y = -k
        if (k < _shortPeriod) {
          SumSx += price[i - k]
          SumSxx += price[i - k] * price[i - k]
          SumSxy += price[i - k] * y
          SumSy += y
          SumSyy += y * y
        }
        SumLx += price[i - k]
        SumLxx += price[i - k] * price[i - k]
        SumLxy += price[i - k] * y
        SumLy += y
        SumLyy += y * y
      }
      const _ts1 = _shortPeriod * SumSxx - SumSx * SumSx
      const _ts2 = _shortPeriod * SumSyy - SumSy * SumSy
      const _tl1 = _longPeriod * SumLxx - SumLx * SumLx
      const _tl2 = _longPeriod * SumLyy - SumLy * SumLy
      vals[i] = _ts1 > 0 && _ts2 > 0 ? (_shortPeriod * SumSxy - SumSx * SumSy) / Math.sqrt(_ts1 * _ts2) : 0
      vall[i] = _tl1 > 0 && _tl2 > 0 ? (_longPeriod * SumLxy - SumLx * SumLy) / Math.sqrt(_tl1 * _tl2) : 0
    }
    return { short: vals, long: vall, shortPeriod: _shortPeriod, longPeriod: _longPeriod }
  }
  test.each([[40, 80, 15], [20, 40, 15], [20, 10, 0], [14, 30, 26], [10, 25, 32], [12, 24, 9]])(
    '(%i, %i, price %i): every bar once its window is full',
    (a, b, price) => {
      const src = source(a, b, chrono(getPriceSeries(price)))
      const rows = run('CORR_TREND', [a, b, price])
      expect(mismatches(rows.map((r) => r.short), src.short, src.shortPeriod - 1)).toEqual([])
      expect(mismatches(rows.map((r) => r.long), src.long, src.longPeriod - 1)).toEqual([])
      // The departure: the source prints partial windows too (divided by the full period).
      expect(rows.slice(0, src.longPeriod - 1).every((r) => r.long === undefined)).toBe(true)
    }
  )
})

describe('Heiken Ashi Smoothed.mq4 (Forex-TSD 2006, mod by Raff)', () => {
  function source(MaMetod: number, MaPeriod: number, MaMetod2: number, MaPeriod2: number) {
    const ExtMapBuffer5 = new Array<number>(Bars).fill(EMPTY)
    const ExtMapBuffer6 = new Array<number>(Bars).fill(EMPTY)
    const ExtMapBuffer7 = new Array<number>(Bars).fill(EMPTY)
    const ExtMapBuffer8 = new Array<number>(Bars).fill(EMPTY)
    const mo = iMAOnArray(Open, MaPeriod, MaMetod)
    const mc = iMAOnArray(Close, MaPeriod, MaMetod)
    const ml = iMAOnArray(Low, MaPeriod, MaMetod)
    const mh = iMAOnArray(High, MaPeriod, MaMetod)
    const limit = Bars - 1 - Math.max(1, Math.max(MaPeriod, MaPeriod2))
    for (let pos = limit; pos >= 0; pos--) {
      const [maOpen, maClose, maLow, maHigh] = [mo[pos], mc[pos], ml[pos], mh[pos]]
      // The source reads an uninitialised buffer at its first bar; the template's seed instead.
      const haOpen = pos === limit ? (maOpen + maClose) / 2 : (ExtMapBuffer5[pos + 1] + ExtMapBuffer6[pos + 1]) / 2
      const haClose = (maOpen + maHigh + maLow + maClose) / 4
      const haHigh = Math.max(maHigh, Math.max(haOpen, haClose))
      const haLow = Math.min(maLow, Math.min(haOpen, haClose))
      if (haOpen < haClose) {
        ExtMapBuffer7[pos] = haLow
        ExtMapBuffer8[pos] = haHigh
      } else {
        ExtMapBuffer7[pos] = haHigh
        ExtMapBuffer8[pos] = haLow
      }
      ExtMapBuffer5[pos] = haOpen
      ExtMapBuffer6[pos] = haClose
    }
    const b1 = iMAOnArray(ExtMapBuffer7, MaPeriod2, MaMetod2)
    const b2 = iMAOnArray(ExtMapBuffer8, MaPeriod2, MaMetod2)
    const b3 = iMAOnArray(ExtMapBuffer5, MaPeriod2, MaMetod2)
    const b4 = iMAOnArray(ExtMapBuffer6, MaPeriod2, MaMetod2)
    // MT4 draws each histogram pair in the colour of the buffer holding the larger value:
    // buffers 2 and 4 are Lime (up), 1 and 3 Red (down).
    const body = b3.map((o, i) => (b4[i] > o ? 1 : b4[i] < o ? -1 : 0))
    const wick = b1.map((v, i) => (b2[i] > v ? 1 : b2[i] < v ? -1 : 0))
    return {
      open: chrono(b3), close: chrono(b4),
      high: chrono(b1.map((v, i) => Math.max(v, b2[i]))), low: chrono(b1.map((v, i) => Math.min(v, b2[i]))),
      body: chrono(body), wick: chrono(wick)
    }
  }
  // The seed and the one-bar later start halve away every bar; compare once they have.
  const FROM = 80
  test.each([[2, 6, 3, 2], [1, 10, 0, 3], [0, 5, 2, 4], [3, 8, 1, 3]])(
    'methods %i/%i, periods %i/%i: every bar after the seed has decayed',
    (m1, p1, m2, p2) => {
      const src = source(m1, p1, m2, p2)
      const rows = run('HA_SMOOTHED', [p1, m1, p2, m2])
      for (const key of ['open', 'close', 'high', 'low'] as const) {
        expect({ key, m: mismatches(rows.map((r) => r[key]), src[key], FROM) }).toEqual({ key, m: [] })
      }
      const bodies = rows.flatMap((r, i) => (i >= FROM && src.body[i] !== 0 && r.trend !== src.body[i] ? [i] : []))
      const wicks = rows.flatMap((r, i) => (i >= FROM && src.wick[i] !== 0 && r.wick !== src.wick[i] ? [i] : []))
      expect({ bodies, wicks }).toEqual({ bodies: [], wicks: [] })
    }
  )
  test('wick and body colours do disagree on some bars, as in MT4', () => {
    const src = source(2, 6, 3, 2)
    expect(src.wick.some((w, i) => i >= FROM && w !== 0 && src.body[i] !== 0 && w !== src.body[i])).toBe(true)
  })
})

describe('oscar.pine (GenZai, NNFX)', () => {
  // Pine semantics: na is NaN, `x[1]` the previous bar, a comparison with na is false.
  const close = bars.map((b) => b.close)
  const sma = (x: number[], len: number) =>
    x.map((_, i) => {
      if (i < len - 1) return Number.NaN
      let s = 0
      for (let k = 0; k < len; k++) s += x[i - k]
      return s / len // na anywhere in the window makes the sum na
    })
  const wma = (x: number[], len: number) =>
    x.map((_, i) => {
      if (i < len - 1) return Number.NaN
      let s = 0
      let norm = 0
      for (let k = 0; k < len; k++) {
        s += x[i - k] * (len - k)
        norm += len - k
      }
      return s / norm
    })
  // rma: sum := na(sum[1]) ? sma(src, length) : alpha * src + (1 - alpha) * nz(sum[1])
  const rma = (x: number[], len: number) => {
    const seed = sma(x, len)
    const out: number[] = []
    for (let i = 0; i < x.length; i++) {
      const prev = i > 0 ? out[i - 1] : Number.NaN
      out[i] = Number.isNaN(prev) ? seed[i] : (1 / len) * x[i] + (1 - 1 / len) * prev
    }
    return out
  }
  const ma = (smoothing: string, x: number[], len: number) =>
    smoothing === 'RMA' ? rma(x, len) : smoothing === 'SMA' ? sma(x, len) : smoothing === 'WMA' ? wma(x, len) : x

  function source(len: number, smoothing: string) {
    const highest = sma(close, 1).map((_, i) => (i < len - 1 ? Number.NaN : Math.max(...close.slice(i - len + 1, i + 1))))
    const lowest = close.map((_, i) => (i < len - 1 ? Number.NaN : Math.min(...close.slice(i - len + 1, i + 1))))
    const OscarRough = close.map((c, i) => (highest[i] - lowest[i] === 0 ? Number.NaN : ((c - lowest[i]) / (highest[i] - lowest[i])) * 100))
    const Oscar = OscarRough.map((r, i) => ((i > 0 ? OscarRough[i - 1] : Number.NaN) / 3) * 2 + r / 3)
    const a = ma(smoothing, OscarRough, len)
    const b = ma(smoothing, Oscar, len)
    const sens = a.map((v, i) => Math.max(v, b[i]) - Math.min(v, b[i]))
    const long = a.map((v, i) => i > 0 && v > b[i] && a[i - 1] <= b[i - 1] && sens[i] > 0.5 && v < 35)
    const short = a.map((v, i) => i > 0 && v < b[i] && a[i - 1] >= b[i - 1] && sens[i] > 0.5 && v > 65)
    return { rough: a, oscar: b, long, short }
  }
  test.each([[20, 'RMA'], [8, 'RMA'], [12, 'SMA'], [12, 'WMA'], [12, 'NONE']])('(%i, %s): lines and C1 triggers, every bar', (len, smoothing) => {
    const src = source(len, smoothing)
    const rows = run('OSCAR', [len, ['RMA', 'SMA', 'EMA', 'WMA', 'NONE'].indexOf(smoothing)])
    expect(mismatches(rows.map((r) => r.rough), src.rough)).toEqual([])
    expect(mismatches(rows.map((r) => r.oscar), src.oscar)).toEqual([])
    expect(rows.map((r) => r.signal ?? 0)).toEqual(src.long.map((l, i) => (l ? 1 : src.short[i] ? -1 : 0)))
  })
})

describe('TTF.mq5 (MetaQuotes, 2018)', () => {
  function source(InpPeriod: number) {
    const period = InpPeriod < 1 ? 1 : InpPeriod
    const BufferTTF = new Array<number>(Bars).fill(EMPTY)
    // CopyHigh(start, count) succeeds only when all `count` bars exist.
    const highest = (count: number, start: number) => (start + count <= Bars ? Highest(High, count, start) : -1)
    const lowest = (count: number, start: number) => (start + count <= Bars ? Lowest(Low, count, start) : -1)
    for (let i = Bars - period - 1; i >= 0; i--) {
      const bh = highest(period, i)
      const bl = lowest(period, i)
      const bh2 = highest(period, i + period - 1)
      const bl2 = lowest(period, i + period - 1)
      if (bh < 0 || bl < 0 || bh2 < 0 || bl2 < 0) continue
      const bp = High[bh] - Low[bl2]
      const sp = High[bh2] - Low[bl]
      BufferTTF[i] = bp + sp !== 0 ? (200.0 * (bp - sp)) / (bp + sp) : 0
    }
    return chrono(BufferTTF)
  }
  test.each([45, 15, 8, 2])('(%i): every bar', (period) => {
    expect(mismatches(run('TTF', [period, 0, 0.7]).map((r) => r.ttf), source(period))).toEqual([])
  })
})

describe('ttf.mq4 (Nick Bilak, 2005)', () => {
  function source(TTFbars: number, t3_period: number, b: number) {
    const b2 = b * b
    const b3 = b2 * b
    const c1 = -b3
    const c2 = 3 * (b2 + b3)
    const c3 = -3 * (2 * b2 + b + b3)
    const c4 = 1 + 3 * b + b3 + 3 * b2
    let r = t3_period
    if (r < 1) r = 1
    r = 1 + 0.5 * (r - 1)
    const w1 = 2 / (r + 1)
    const w2 = 1 - w1
    let [e1, e2, e3, e4, e5, e6] = [0, 0, 0, 0, 0, 0]
    const draw_begin1 = TTFbars * 2 + 1
    const MainBuffer = new Array<number>(Bars).fill(EMPTY) // the first draw_begin1 bars are not drawn
    for (let i = Bars - draw_begin1; i >= 0; i--) {
      const HighestHighRecent = High[Highest(High, TTFbars, i)]
      const HighestHighOlder = High[Highest(High, TTFbars, i + TTFbars)]
      const LowestLowRecent = Low[Lowest(Low, TTFbars, i)]
      const LowestLowOlder = Low[Lowest(Low, TTFbars, i + TTFbars)]
      const BuyPower = HighestHighRecent - LowestLowOlder
      const SellPower = HighestHighOlder - LowestLowRecent
      let TTF = ((BuyPower - SellPower) / (0.5 * (BuyPower + SellPower))) * 100
      e1 = w1 * TTF + w2 * e1
      e2 = w1 * e1 + w2 * e2
      e3 = w1 * e2 + w2 * e3
      e4 = w1 * e3 + w2 * e4
      e5 = w1 * e4 + w2 * e5
      e6 = w1 * e5 + w2 * e6
      TTF = c1 * e6 + c2 * e5 + c3 * e4 + c4 * e3
      MainBuffer[i] = TTF
    }
    return chrono(MainBuffer)
  }
  test.each([[8, 3, 0.7], [12, 4, 0.7], [8, 1, 0.5], [15, 6, 0.8]])('(%i, T3 %i, b %f): every bar', (bars_, t3, b) => {
    expect(mismatches(run('TTF', [bars_, t3, b]).map((r) => r.ttf), source(bars_, t3, b))).toEqual([])
  })
})

describe('ChandelierExit.mq4 (MQLService, mod2008fxtsd)', () => {
  function source(Range: number, Shift: number, ATRPeriod: number, ATRMultipl: number) {
    const atr = iATR(ATRPeriod)
    const ExtMapBuffer1 = new Array<number>(Bars + 1).fill(EMPTY)
    const ExtMapBuffer2 = new Array<number>(Bars + 1).fill(EMPTY)
    const ExtMapBuffer3 = new Array<number>(Bars).fill(EMPTY)
    const ExtMapBuffer4 = new Array<number>(Bars).fill(EMPTY)
    const direction = new Array<number>(Bars + 1).fill(0)
    for (let i = Bars - 1; i >= 0; i--) {
      const s = i + Shift
      const ATRvalue = (s < Bars ? atr[s] : EMPTY) * ATRMultipl
      ExtMapBuffer1[i] = s < Bars ? High[Highest(High, Range, s)] - ATRvalue : EMPTY
      ExtMapBuffer2[i] = s < Bars ? Low[Lowest(Low, Range, s)] + ATRvalue : EMPTY
      direction[i] = direction[i + 1]
      if (Close[i] > ExtMapBuffer2[i + 1]) direction[i] = 1
      if (Close[i] < ExtMapBuffer1[i + 1]) direction[i] = -1
      if (direction[i] > 0) {
        if (ExtMapBuffer1[i] < ExtMapBuffer1[i + 1]) ExtMapBuffer1[i] = ExtMapBuffer1[i + 1]
        ExtMapBuffer3[i] = ExtMapBuffer1[i]
      }
      if (direction[i] < 0) {
        if (ExtMapBuffer2[i] > ExtMapBuffer2[i + 1]) ExtMapBuffer2[i] = ExtMapBuffer2[i + 1]
        ExtMapBuffer4[i] = ExtMapBuffer2[i]
      }
    }
    return { long: chrono(ExtMapBuffer3), short: chrono(ExtMapBuffer4) }
  }
  test.each([[6, 0, 7, 2.5], [7, 0, 9, 2.5], [21, 0, 27, 3.0], [7, 2, 9, 2.5], [14, 0, 5, 2.0]])(
    'range %i, shift %i, ATR %i x %f: identical once the partial-window warm-up has turned over',
    (range, shift, atrp, mult) => {
      const src = source(range, shift, atrp, mult)
      const rows = run('CHANDELIER', [range, atrp, mult, shift, 1])
      // The source's Highest() accepts a window the history cannot fill yet; the template waits for
      // a full one. That warm-up carries through the ratchet until the next turn, so the two agree
      // from a turn on -- which must come early, and then hold to the last bar.
      const long = matchingTailFrom(rows.map((r) => r.long), src.long)
      const short = matchingTailFrom(rows.map((r) => r.short), src.short)
      expect(Math.max(long, short)).toBeLessThan(Bars / 3)
      // Not vacuous: the matching stretch draws both sides, and a stop on every bar once drawing
      // has begun (it may include the warm-up both leave empty).
      const tail = rows.slice(Math.max(long, short))
      expect(tail.filter((r) => r.long !== undefined).length).toBeGreaterThan(10)
      expect(tail.filter((r) => r.short !== undefined).length).toBeGreaterThan(10)
      const drawn = tail.findIndex((r) => r.long !== undefined || r.short !== undefined)
      expect(drawn).toBeGreaterThanOrEqual(0)
      expect(tail.slice(drawn).every((r) => r.long !== undefined || r.short !== undefined)).toBe(true)
    }
  )
})

describe('TREND AKKAM.mq4', () => {
  function source(akk_range: number, akk_factor: number) {
    const ATR = iATR(akk_range, true) // ATR.mq4's zeroed warm-up is what the source reads there
    const DeltaStops = iMAOnArray(ATR, 1, 1) // iMAOnArray(ATR,0,ima_range=1,0,MODE_EMA,i): ATR itself
    const TrStop = new Array<number>(Bars + 1).fill(0) // out of range reads 0 in MQL4
    const open = [...Open, 0]
    for (let i = Bars - 1; i >= 0; i--) {
      const DeltaStop = DeltaStops[i] * akk_factor
      if (open[i] === TrStop[i + 1]) TrStop[i] = TrStop[i + 1]
      else if (open[i + 1] < TrStop[i + 1] && open[i] < TrStop[i + 1]) TrStop[i] = Math.min(TrStop[i + 1], open[i] + DeltaStop)
      else if (open[i + 1] > TrStop[i + 1] && open[i] > TrStop[i + 1]) TrStop[i] = Math.max(TrStop[i + 1], open[i] - DeltaStop)
      else TrStop[i] = open[i] > TrStop[i + 1] ? open[i] - DeltaStop : open[i] + DeltaStop
    }
    return chrono(TrStop.slice(0, Bars))
  }
  test.each([[20, 3], [30, 2], [14, 4]])('ATR %i x %f: identical once the zero-ATR warm-up has turned over', (atrp, factor) => {
    const src = source(atrp, factor)
    const rows = run('TREND_AKKAM', [atrp, factor, 1])
    const from = matchingTailFrom(rows.map((r) => r.long ?? r.short), src)
    expect(from).toBeLessThan(Bars / 3)
    // Not vacuous: the matching stretch has a value on every bar and turns at least once.
    const tail = rows.slice(from)
    expect(tail.every((r) => r.long !== undefined || r.short !== undefined)).toBe(true)
    expect(new Set(tail.map((r) => r.trend))).toEqual(new Set([1, -1]))
  })
})
