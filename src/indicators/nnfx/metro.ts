/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 * http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { IndicatorTemplate, KLineData } from 'klinecharts'

import { countParam, value } from './mt4'
import { drawRange, fillBetween, guide, guideColor, signColors, signLineStyle, warmupMark, withAlpha } from './paint'
import { distanceFromMean } from './trendilo'

/**
 * METRO -- Metro Advanced, mladen's "advanced step RSI", in a sub-pane, as the Stonehill
 * library's `Metro-Advanced.mq4` (Gehtsoft, Mario Jemic) computes it (windicators
 * `metro_advanced`, catalog/momentum/metro_advanced.toml, the code the windicators NNFX scan ran):
 * the C1 the scan ranked 14th on 1D, at RSI period 42, step sizes 2 and 30.
 *
 * Parameters: [period, fast step, slow step, min-max period, ma, inverted, warm-up], default
 * [42, 2, 30, 49, 3, 1, 1] (the source's own: 14, 5, 15, 49). Fixed at the scan's setting: the
 * regular RSI (mladen's `iRsi` type 0), the close, oversold 10 and overbought 90.
 *
 *   rsi       = 50 (change / changa + 1), change and changa EMAs (alpha 1 / period) of the
 *               close's change and its size; before bar `period`, the mean change and size so far
 *   fast line = a step line on the rsi, moving in `fast step` points: in an up-trend its floor
 *               (rsi - 2 step) only rises and the line is floor + step, in a down-trend the
 *               mirror; it turns when the rsi passes the previous ceiling or floor
 *   slow line = the same in `slow step` points; trend = +1 while fast is above slow, -1 below
 *   level up  = lo + 90% of (hi - lo), hi / lo the rsi's range over the last `min-max period`
 *               bars (level mid and level dn likewise at 50% and 10%)
 *   ma        = level up's exact `ma`-bar mean, the scan's trigger
 *
 * As in the source the oldest bar is never computed (every output blank there, its price read as
 * 0 by the RSI's start) and the buffers start at MT4's EMPTY_VALUE, so the first computed bar
 * turns both step lines down. The source's arrows (`trend_up_arrow` .. `cross_slow_dn`: trend turns
 * and the rsi crossing each line, at the rsi's value) are computed but not drawn, and so are level
 * mid and level dn. **Departure:** while the levels' window still
 * reaches the never-computed oldest bar, its EMPTY_VALUE (2,147,483,647) is the window's high and
 * windicators gives levels near 1.9e9; the template leaves the levels blank on those first
 * `min-max period` bars.
 *
 * The C1 reading the scan tested is LEVEL UP against its own 3-bar mean with `inverted` 1
 * (+2.00 %/yr per pair, 20 of 28 pairs positive): LONG while the level is BELOW its mean, i.e.
 * has just fallen (the rsi's 49-bar high leaving the window, or a new low), short while above, and
 * no signal while it has held one value for 3 bars (64% of the 28 pairs' 1D bars); 0 is the
 * conventional reading. The step sizes do not enter it. The level is drawn in the colour of the
 * side it gives and the area between it and its mean shaded by side; the rsi and the two step
 * lines are context.
 *
 * **Warm-up.** The source's RSI starts from a 0 price before the oldest bar, so its first change
 * is the whole price and the two averages start inflated by about price / (period - 1), many
 * times their real size, fading as (1 - 1 / period) a bar. The scan computed from 2005; a chart
 * computes from its oldest loaded bar. Measured on the 28 prod pairs' 1D bars from 4,648 start
 * points (2026-10-15), the reading disagreed with the from-2005 one on 38% of bars at its first
 * bar, 73% at 100 (the inflated rsi falls all the while, so the level keeps moving where the
 * from-2005 one is flat), 40% at 200, 5.7% at 300 and 0.54% at 400, and below 0.5% at every bar
 * from 419 on. So with `warm-up` 1 the template leaves every line blank until the seed is below
 * 1e-4 of its start and the levels' window has passed it: (period - 1) +
 * ceil(ln 1e-4 / ln(1 - 1 / period)) + (min-max period - 1), 472 bars at the defaults, the reading
 * starting ma - 1 bars later (474): on a 1D chart's first 500-bar load only the last 26 bars have
 * a reading, and scrolling back loads more. Past that, 192 of 4.8 million bars disagreed (at most 0.17% at
 * any bar); at periods 14, 28 and 60 and min-max periods 20 and 100 at most 0.19%. The step lines
 * do NOT converge: the slow one turns only when the rsi rises 2 x 30 points above its low since the
 * last turn (or falls as far below its high), so it can keep the side it started with for the whole
 * chart (1,500 bars after a later start it still differed from the from-2005 one on 84% of
 * starts). The pane says how many bars it needs while it
 * has too few (paint.ts `warmupMark`); 0 draws from the first bar.
 *
 * Locked to windicators by fixtures/wscan_r3_trend.json.
 */

export interface Metro {
  [key: string]: number | undefined
  rsi?: number
  step_fast?: number
  step_slow?: number
  trend?: number
  level_up?: number
  level_mid?: number
  level_dn?: number
  ma?: number
  state?: number
  trend_up_arrow?: number
  trend_dn_arrow?: number
  cross_fast_up?: number
  cross_fast_dn?: number
  cross_slow_up?: number
  cross_slow_dn?: number
}

const DEFAULTS = [42, 2, 30, 49, 3, 1, 1]
const OVER_SOLD = 10
const OVER_BOUGHT = 90
/** MQL4's EMPTY_VALUE: every buffer's value before it is written. */
const EMPTY = 2147483647

/** The first bar drawn with `warm-up` 1: the RSI's zero seed below 1e-4 of its start, and the levels' window past it. */
export function metroWarmup(period: number, minMax: number): number {
  return period - 1 + Math.ceil(Math.log(1e-4) / Math.log(1 - 1 / period)) + (minMax - 1)
}

export function metroSettings(calcParams: readonly unknown[]): {
  period: number
  fast: number
  slow: number
  minMax: number
  ma: number
  dir: number
  warm: number
} {
  const period = Math.min(100000, countParam(calcParams[0], DEFAULTS[0], 2))
  const fast = Math.min(100, countParam(calcParams[1], DEFAULTS[1], 0))
  const slow = Math.min(100, countParam(calcParams[2], DEFAULTS[2], 0))
  const minMax = Math.min(100000, countParam(calcParams[3], DEFAULTS[3], 1))
  const ma = Math.min(100000, countParam(calcParams[4], DEFAULTS[4], 1))
  const dir = countParam(calcParams[5], 1, 0) >= 1 ? -1 : 1
  const warm = countParam(calcParams[6], 1, 0) >= 1 ? metroWarmup(period, minMax) : 0
  return { period, fast, slow, minMax, ma, dir, warm }
}

/** mladen's regular iRsi from bar 1 (bar 0 is never computed; its price reads as 0). */
export function mladenRsi(price: readonly number[], period: number): number[] {
  const n = price.length
  const out = new Array<number>(n).fill(Number.NaN)
  const w = price.map((p, r) => (r === 0 ? 0 : p))
  let change = 0
  let changa = 0
  const alpha = 1 / period
  for (let r = 1; r < n; r++) {
    if (r < period) {
      let s = 0
      let k = 0
      while (k < period && r - k - 1 >= 0) {
        s += Math.abs(w[r - k] - w[r - k - 1])
        k++
      }
      change = (w[r] - w[0]) / Math.max(k, 1)
      changa = s / Math.max(k, 1)
    } else {
      const ch = w[r] - w[r - 1]
      change = change + alpha * (ch - change)
      changa = changa + alpha * (Math.abs(ch) - changa)
    }
    out[r] = changa !== 0 ? 50 * (change / changa + 1) : 50
  }
  return out
}

const OUTPUTS = [
  'rsi',
  'step_fast',
  'step_slow',
  'trend',
  'level_up',
  'level_mid',
  'level_dn',
  'trend_up_arrow',
  'trend_dn_arrow',
  'cross_fast_up',
  'cross_fast_dn',
  'cross_slow_up',
  'cross_slow_dn'
] as const

/** windicators' thirteen outputs from the first bar, NaN where the source leaves EMPTY_VALUE. */
export function metroAdvanced(
  close: readonly number[],
  period: number,
  fast: number,
  slow: number,
  minMax: number
): Record<(typeof OUTPUTS)[number], number[]> {
  const n = close.length
  const rsiAll = mladenRsi(close, period)
  const buf = () => new Array<number>(n).fill(EMPTY)
  const [line1, line2, line3, trendf, trends, maxf, minf, maxs, mins, trend, lvlUp, lvlMi, lvlDn] = Array.from({ length: 13 }, buf)
  const arrows = Array.from({ length: 6 }, buf)
  for (let t = 1; t < n; t++) {
    const rsi = rsiAll[t]
    maxf[t] = rsi + 2 * fast
    minf[t] = rsi - 2 * fast
    maxs[t] = rsi + 2 * slow
    mins[t] = rsi - 2 * slow

    trendf[t] = trendf[t - 1]
    if (rsi > maxf[t - 1]) trendf[t] = 1
    if (rsi < minf[t - 1]) trendf[t] = -1
    if (trendf[t] > 0 && minf[t] < minf[t - 1]) minf[t] = minf[t - 1]
    if (trendf[t] < 0 && maxf[t] > maxf[t - 1]) maxf[t] = maxf[t - 1]

    trends[t] = trends[t - 1]
    if (rsi > maxs[t - 1]) trends[t] = 1
    if (rsi < mins[t - 1]) trends[t] = -1
    if (trends[t] > 0 && mins[t] < mins[t - 1]) mins[t] = mins[t - 1]
    if (trends[t] < 0 && maxs[t] > maxs[t - 1]) maxs[t] = maxs[t - 1]

    line1[t] = rsi
    // ArrayMaximum / ArrayMinimum over this bar and the min-max period - 1 older ones, cut at the
    // oldest bar, whose EMPTY_VALUE counts.
    let hi = line1[t]
    let lo = line1[t]
    for (let k = Math.max(0, t - minMax + 1); k <= t; k++) {
      if (line1[k] > hi) hi = line1[k]
      if (line1[k] < lo) lo = line1[k]
    }
    const rn = hi - lo
    lvlUp[t] = lo + (rn * OVER_BOUGHT) / 100
    lvlDn[t] = lo + (rn * OVER_SOLD) / 100
    lvlMi[t] = (lvlUp[t] + lvlDn[t]) / 2

    if (trendf[t] > 0) line2[t] = minf[t] + fast
    else if (trendf[t] < 0) line2[t] = maxf[t] - fast
    if (trends[t] > 0) line3[t] = mins[t] + slow
    else if (trends[t] < 0) line3[t] = maxs[t] - slow

    if (line2[t] > line3[t]) trend[t] = 1
    else if (line2[t] < line3[t]) trend[t] = -1
    else trend[t] = trend[t - 1]

    if (trend[t] === 1 && trend[t - 1] !== 1) arrows[0][t] = line1[t]
    if (trend[t] === -1 && trend[t - 1] !== -1) arrows[1][t] = line1[t]
    if (line1[t] >= line2[t] && line1[t - 1] < line2[t - 1]) arrows[2][t] = line1[t]
    if (line1[t] <= line2[t] && line1[t - 1] > line2[t - 1]) arrows[3][t] = line1[t]
    if (line1[t] >= line3[t] && line1[t - 1] < line3[t - 1]) arrows[4][t] = line1[t]
    if (line1[t] <= line3[t] && line1[t - 1] > line3[t - 1]) arrows[5][t] = line1[t]
  }
  const series = [line1, line2, line3, trend, lvlUp, lvlMi, lvlDn, ...arrows]
  const out = {} as Record<(typeof OUTPUTS)[number], number[]>
  OUTPUTS.forEach((key, k) => {
    out[key] = series[k].map((v) => (v === EMPTY ? Number.NaN : v))
  })
  return out
}

export function metroRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Metro[] {
  const { period, fast, slow, minMax, ma, dir, warm } = metroSettings(calcParams)
  const out = metroAdvanced(
    bars.map((b) => b.close),
    period,
    fast,
    slow,
    minMax
  )
  // The levels' window holds the never-computed oldest bar's EMPTY_VALUE before bar `minMax`.
  const from = Math.max(warm, minMax)
  const level = out.level_up.map((v, t) => (t < from ? Number.NaN : v))
  const dist = distanceFromMean(level, ma)
  return bars.map((_, t) => {
    const row: Metro = {}
    if (t < warm) return row
    for (const key of OUTPUTS) {
      if (t < minMax && key.startsWith('level_')) continue
      const v = value(out[key][t])
      if (v !== undefined) row[key] = v
    }
    const d = dist[t]
    if (Number.isFinite(d)) {
      row.ma = level[t] - d
      row.state = d === 0 ? 0 : dir * Math.sign(d)
    }
    return row
  })
}

const metro: IndicatorTemplate<Metro, number> = {
  name: 'METRO',
  shortName: 'Metro Advanced',
  calcParams: DEFAULTS,
  precision: 2,
  figures: [
    { key: 'rsi', title: 'RSI: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) },
    { key: 'step_fast', title: 'Fast: ', type: 'line' },
    { key: 'step_slow', title: 'Slow: ', type: 'line' },
    {
      key: 'level_up',
      title: 'Level up: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    },
    { key: 'ma', title: 'MA: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => metroRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const { dir, warm } = metroSettings(indicator.calcParams)
    const [above, below] = dir < 0 ? [down, up] : [up, down]
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'level_up', 'ma', drawRange(chart, indicator.result.length),
      withAlpha(above, 0.22), withAlpha(below, 0.22))
    guide(ctx, bounding, yAxis, 50, guideColor(chart))
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, warm)
    return false
  }
}

export default metro
