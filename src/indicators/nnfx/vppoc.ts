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

import { countParam, realParam } from './mt4'
import { arrowSize, drawRange, guideColor, priceLegends, signColors } from './paint'

/**
 * VP_POC -- a rolling volume profile's point of control and value area on the price pane, as
 * QuantConnect LEAN's VolumeProfile computes it (windicators `volume_profile_poc`, the code the
 * windicators NNFX scan ran): the EXIT of the scan's best system overall, at period 3, value area
 * 63%, tick 0.055.
 *
 * Parameters: [period, value area, tick, inverted], default [3, 0.63, 0.055, 1] (LEAN's own: 2,
 * 0.70, 0.05).
 *
 * Each bar adds its volume to the bin of its close, the close rounded UP to a multiple of `tick`,
 * and the bar that leaves the `period`-bar window takes its volume back out. The POC is the bin
 * holding the most volume (a tie goes to the bin nearest the middle of the list), and the value
 * area grows from it one bin at a time, towards the larger neighbour, while it holds no more than
 * `value area` of the window's volume. windicators' kernel (`_kernels/lean_market_profile.py`) is
 * ported line for line, including its exact-rational reading of `tick` and `value area` and its
 * ulp-tolerant bin edge.
 *
 * The exit the scan tested is the profile's LOW against the value area's low, with `inverted` 1.
 * The value area never reaches below the profile, so that reading is 0 while the value area spans
 * the lowest bin and +1 while it does not; an exit closes a trade when its reading is against the
 * trade, so this one closes SHORTS only. In plain terms: it closes a short when the last `period`
 * closes straddle a multiple of `tick` and more than `value area` of their volume traded above the
 * lowest one's bin, whichever way the last close went. The grid is in price, not pips: 0.055 is
 * 5.5 pips on a JPY cross and 550 pips on EURUSD, so the exit fires on ~40% of JPY bars and 2-9%
 * elsewhere (prod 1D, 2026-10-14).
 *
 * Drawn: the value area shaded between its high and low, the POC as a line, and a dot on each
 * bar whose reading closes a trade (below the bar in the up colour: closes shorts; above it in
 * the down colour: closes longs). Nothing enters the y-axis -- on EURUSD the bins sit up to 0.055
 * from price -- so the legend is built here, as SESSIONS builds its own.
 *
 * Locked to windicators by fixtures/wscan_parity.json.
 */

export interface VpPoc {
  [key: string]: number | undefined
  poc?: number
  poc_volume?: number
  profile_high?: number
  profile_low?: number
  value_area_volume?: number
  value_area_high?: number
  value_area_low?: number
  state?: number
}

const DEFAULTS = [3, 0.63, 0.055, 1]
const EPS = 2.220446049250313e-16

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b]
  return a
}

/** `x` as the decimal its shortest form prints, as a reduced ratio [numerator, denominator]: 0.05 -> [1, 20]. */
export function asRatio(x: number): [number, number] {
  const m = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(String(x))
  if (m === null) return [x, 1]
  const fraction = m[2] ?? ''
  const exp = (m[3] === undefined ? 0 : Number(m[3])) - fraction.length
  let num = Number(m[1] + fraction)
  let den = 1
  if (exp >= 0) num *= 10 ** exp
  else den = 10 ** -exp
  const g = gcd(num, den)
  return g > 0 ? [num / g, den / g] : [num, den]
}

/** The integer m with m x tick = the close rounded up to the tick grid, snapped within a few ulps. */
export function priceBin(price: number, tickNum: number, tickDen: number): number {
  const y = (price * tickDen) / tickNum
  const r = Math.floor(y + 0.5)
  if (Math.abs(y - r) <= 16 * EPS * Math.abs(y)) return r
  return Math.ceil(y)
}

/** The weights of the window's valid bars in bin `k`, in time order. */
function windowSum(bins: readonly number[], weight: readonly number[], valid: readonly boolean[], lo: number, hi: number, k: number): number {
  let s = 0
  for (let j = lo; j <= hi; j++) if (valid[j] && bins[j] === k) s += weight[j]
  return s
}

type Profile = Record<'poc' | 'poc_volume' | 'profile_high' | 'profile_low' | 'value_area_volume' | 'value_area_high' | 'value_area_low', number[]>

/** windicators' `market_profile` over bars that start finite. */
export function marketProfile(close: readonly number[], weight: readonly number[], period: number, pct: [number, number], tick: [number, number]): Profile {
  const [pctNum, pctDen] = pct
  const [tickNum, tickDen] = tick
  const n = close.length
  const blank = () => new Array<number>(n).fill(Number.NaN)
  const out: Profile = {
    poc: blank(), poc_volume: blank(), profile_high: blank(), profile_low: blank(),
    value_area_volume: blank(), value_area_high: blank(), value_area_low: blank()
  }
  const valid = close.map((c, t) => Number.isFinite(c) && Number.isFinite(weight[t]) && weight[t] >= 0)
  const bins = close.map((c, t) => (valid[t] ? priceBin(c, tickNum, tickDen) : 0))
  const keys: number[] = [] // the bins present, ascending
  const vals: number[] = []
  let lastInvalid = -1
  for (let t = 0; t < n; t++) {
    const lo = Math.max(0, t - period + 1) // the window after this bar is added
    if (!valid[t]) {
      lastInvalid = t
    } else {
      // A bin is created by any add, even of weight 0.
      const k = bins[t]
      let idx = keys.indexOf(k)
      if (idx < 0) {
        idx = keys.length
        while (idx > 0 && keys[idx - 1] > k) idx--
        keys.splice(idx, 0, k)
        vals.splice(idx, 0, 0)
      }
      vals[idx] = windowSum(bins, weight, valid, lo, t, k)
    }
    const d = t - period // the bar the window drops
    if (d >= 0 && valid[d]) {
      const idx = keys.indexOf(bins[d])
      if (idx >= 0) {
        const s = windowSum(bins, weight, valid, lo, t, bins[d])
        if (s === 0) {
          // emptied to exactly 0: the bin goes
          keys.splice(idx, 1)
          vals.splice(idx, 1)
        } else {
          vals[idx] = s
        }
      }
    }
    if (t < period - 1 || lastInvalid >= lo) continue
    let total = 0
    for (let j = lo; j <= t; j++) total += weight[j]
    const cnt = keys.length
    if (cnt === 0) {
      // every bin emptied: LEAN's 0s
      out.poc[t] = 0
      out.poc_volume[t] = 0
      out.profile_high[t] = 0
      out.profile_low[t] = 0
      out.value_area_volume[t] = (total * pctNum) / pctDen
      out.value_area_high[t] = 0
      out.value_area_low[t] = 0
      continue
    }
    // GetMax: ties to the bin nearest the middle index, the first found on an equal distance.
    let mx = 0
    const mid = Math.floor((cnt - 1) / 2)
    for (let i = 0; i < cnt; i++) {
      if (vals[i] > vals[mx]) mx = i
      else if (vals[i] === vals[mx] && Math.abs(mid - i) < Math.abs(mid - mx)) mx = i
    }
    out.poc[t] = (keys[mx] * tickNum) / tickDen
    out.poc_volume[t] = vals[mx]
    out.profile_high[t] = (keys[cnt - 1] * tickNum) / tickDen
    out.profile_low[t] = (keys[0] * tickNum) / tickDen
    // CalculateValueArea: while current <= total x pct, compared exactly as current x den <= total x num.
    const target = total * pctNum
    let current = vals[mx]
    let mnI = mx
    let mxI = mx
    while (current * pctDen <= target && target !== 0) {
      const nextMin = Math.max(mnI - 1, 0)
      const nextMax = Math.min(mxI + 1, cnt - 1)
      const canLow = nextMin !== mnI
      const canHigh = nextMax !== mxI
      const lowV = canLow ? vals[nextMin] : 0
      const highV = canHigh ? vals[nextMax] : 0
      if (!canLow && !canHigh) break // the whole profile is in
      if ((highV === 0 || (lowV !== 0 && lowV > highV)) && canLow) {
        current += lowV
        mnI = nextMin
      } else if (lowV === 0 || (highV !== 0 && highV >= lowV)) {
        current += highV
        mxI = nextMax
      } else {
        break
      }
    }
    out.value_area_volume[t] = target / pctDen
    out.value_area_high[t] = (keys[mxI] * tickNum) / tickDen
    out.value_area_low[t] = (keys[mnI] * tickNum) / tickDen
  }
  return out
}

export function vpPocSettings(calcParams: readonly unknown[]): { period: number; pct: number; tick: number; dir: number } {
  return {
    period: Math.min(100000, countParam(calcParams[0], DEFAULTS[0], 1)),
    pct: Math.min(1, realParam(calcParams[1], DEFAULTS[1], 0)),
    tick: Math.min(1e6, realParam(calcParams[2], DEFAULTS[2], 1e-8)),
    dir: countParam(calcParams[3], 1, 0) >= 1 ? -1 : 1
  }
}

export function vpPocRows(bars: readonly KLineData[], calcParams: readonly unknown[]): VpPoc[] {
  const { period, pct, tick, dir } = vpPocSettings(calcParams)
  const close = bars.map((b) => b.close)
  const volume = bars.map((b) => b.volume ?? Number.NaN)
  // windicators starts at the first bar whose close and volume are both finite.
  let start = 0
  while (start < bars.length && !(Number.isFinite(close[start]) && Number.isFinite(volume[start]))) start++
  const p = marketProfile(close.slice(start), volume.slice(start), period, asRatio(pct), asRatio(tick))
  const keys = Object.keys(p) as Array<keyof Profile>
  return bars.map((_, t) => {
    const i = t - start
    if (i < 0 || !Number.isFinite(p.poc[i])) return {}
    const row: VpPoc = {}
    for (const k of keys) row[k] = p[k][i]
    row.state = dir * Math.sign((row.profile_low as number) - (row.value_area_low as number))
    return row
  })
}

function exitText(state: number | undefined): string {
  return state === undefined ? 'n/a' : state > 0 ? 'closes shorts' : state < 0 ? 'closes longs' : '—'
}

const vpPoc: IndicatorTemplate<VpPoc, number> = {
  name: 'VP_POC',
  shortName: 'Volume Profile POC',
  series: 'price',
  calcParams: DEFAULTS,
  precision: 5,
  shouldOhlc: false,
  // No figures: nothing enters the y-axis, and the legend is built below.
  figures: [],
  calc: (dataList: KLineData[], indicator) => vpPocRows(dataList, indicator.calcParams),
  createTooltipDataSource: ({ chart, indicator, crosshair }) => {
    const { period, pct, tick } = vpPocSettings(indicator.calcParams)
    const neutral = chart.getStyles().indicator.tooltip.legend.color
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const result = indicator.result
    const row = result[crosshair.dataIndex ?? result.length - 1] ?? {}
    const color = row.state === undefined || row.state === 0 ? neutral : row.state > 0 ? up : down
    return {
      name: indicator.shortName,
      calcParamsText: `(${period}, ${Math.round(pct * 100)}%, tick ${tick})`,
      legends: [
        ...priceLegends(chart, indicator, row, [
          { key: 'poc', title: 'POC: ', color: neutral },
          { key: 'value_area_high', title: 'VA high: ', color: neutral },
          { key: 'value_area_low', title: 'VA low: ', color: neutral }
        ]),
        { title: { text: 'Exit: ', color: neutral }, value: { text: exitText(row.state), color, reserve: exitText(1) } }
      ],
      features: chart.getStyles().indicator.tooltip.features
    }
  },
  draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
    const result = indicator.result
    const data = chart.getDataList()
    const { from, to } = drawRange(chart, result.length)
    const half = chart.getBarSpace().bar / 2
    const line = guideColor(chart, 0.85)
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const r = Math.max(2, arrowSize(chart) / 3)
    ctx.save()
    ctx.fillStyle = guideColor(chart, 0.12)
    for (let i = from; i <= to; i++) {
      const row = result[i]
      if (row?.value_area_high === undefined || row.value_area_low === undefined) continue
      const x = xAxis.convertToPixel(i)
      const yh = yAxis.convertToPixel(row.value_area_high)
      const yl = yAxis.convertToPixel(row.value_area_low)
      ctx.fillRect(x - half, Math.min(yh, yl), half * 2, Math.abs(yl - yh))
    }
    ctx.strokeStyle = line
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let i = from; i <= to; i++) {
      const poc = result[i]?.poc
      if (poc === undefined) continue
      const x = xAxis.convertToPixel(i)
      const y = Math.round(yAxis.convertToPixel(poc)) + 0.5
      ctx.moveTo(x - half, y)
      ctx.lineTo(x + half, y)
    }
    ctx.stroke()
    for (let i = from; i <= to; i++) {
      const state = result[i]?.state
      const bar = data[i]
      if (state === undefined || state === 0 || bar === undefined) continue
      const x = xAxis.convertToPixel(i)
      const y = state > 0 ? yAxis.convertToPixel(bar.low) + 3 + r : yAxis.convertToPixel(bar.high) - 3 - r
      ctx.fillStyle = state > 0 ? up : down
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
    return false
  }
}

export default vpPoc
