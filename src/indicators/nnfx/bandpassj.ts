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

import { countParam, realParam, value } from './mt4'
import { drawRange, fillBetween, guide, guideColor, signColors, signLineStyle, warmupMark, withAlpha } from './paint'

/**
 * BANDPASS_J -- Ehlers' band-pass filter as jesse 3.2.4 computes it (windicators
 * `band_pass_filter_jesse`, the code the windicators NNFX scan ran), in a sub-pane: the C2 of the
 * scan's systems 3 and 5 and of its best system overall, at period 30, bandwidth 0.1206. Not the
 * BANDPASS template (mladen's MT4 filter, a different formula).
 *
 * Parameters: [period, bandwidth, warm-up], default [30, 0.1206, 1] (jesse's own: 20, 0.3).
 *
 *   hp      = a one-pole high-pass of the close, period 4 x period / bandwidth
 *   bp      = 0.5 (1 - alpha)(hp - hp[2]) + beta (1 + alpha) bp[1] - alpha bp[2],
 *             beta = cos(2 pi / period), gamma = cos(2 pi bandwidth / period),
 *             alpha = 1/gamma - sqrt(1/gamma^2 - 1), started from bp = hp on the first two bars
 *   norm    = bp over its peak, the peak decaying by 0.991 a bar (an automatic gain control)
 *   trigger = a one-pole high-pass of norm, period period / bandwidth / 1.5
 *   signal  = +1 while norm is BELOW the trigger, -1 while above (jesse's own convention)
 *
 * The C2 reading the scan tested is that signal as it is: it confirms long while +1. The area
 * between the two lines is shaded in the colour of the signal.
 *
 * The warm-up. jesse seeds the high-pass with the close itself: the line starts at the price level
 * and the seed decays by (1 - a) a bar, where a is the high-pass's coefficient at period
 * 4 x period / bandwidth (about 1,000 bars at the scan's setting). The scan computed it from the
 * start of the history (2005 on 1D); a chart computes it from the oldest bar it has loaded. With
 * `warm-up` 1 (the default) the template leaves the first `seedWarmup` bars blank: until the seed
 * is below 1e-4 of where it started, 1,459 bars at 30 / 0.1206 and 876 at 36 / 0.2412. Measured on
 * the 28 prod pairs at 1D, 8h, 4h and 1h (2026-10-14), from 252-868 start points each: from there
 * on the line is within 0.6% of its median size of the line computed from 2005, and the signal
 * agrees on 99.98% of bars; at bar 500 it disagreed on 18% (BANDPASS_J, 1D). A dashed line marks
 * the first bar drawn, and a note says how much history is missing. 0 draws from the first bar.
 *
 * Locked to windicators by fixtures/wscan_parity.json.
 */

export interface BandPassJ {
  [key: string]: number | undefined
  bp?: number
  norm?: number
  trigger?: number
  signal?: number
}

/** jesse's ih_high_pass_1pole: hp = (1 - a/2)(x - x[1]) + (1 - a) hp[1], hp[0] = x[0]. */
function highPass1Pole(x: readonly number[], period: number): number[] {
  const r = x.slice()
  const sv = Math.sin((2 * Math.PI) / period)
  const cv = Math.cos((2 * Math.PI) / period)
  const alpha = 1 + (sv - 1) / cv
  const c = 1 - alpha / 2
  for (let i = 1; i < x.length; i++) r[i] = c * x[i] - c * x[i - 1] + (1 - alpha) * r[i - 1]
  return r
}

export function bandPassJesse(close: readonly number[], period: number, bandwidth: number): {
  bp: number[]
  norm: number[]
  trigger: number[]
  signal: number[]
} {
  const n = close.length
  const hp = highPass1Pole(close, (4 * period) / bandwidth)
  const beta = Math.cos((2 * Math.PI) / period)
  const gamma = Math.cos((2 * Math.PI * bandwidth) / period)
  const alpha = 1 / gamma - Math.sqrt(1 / (gamma * gamma) - 1)
  const bp = hp.slice()
  for (let i = 2; i < n; i++) {
    bp[i] = 0.5 * (1 - alpha) * (hp[i] - hp[i - 2]) + beta * (1 + alpha) * bp[i - 1] - alpha * bp[i - 2]
  }
  const peak = bp.slice()
  for (let i = 1; i < n; i++) {
    peak[i] = peak[i - 1] * 0.991
    if (Math.abs(bp[i]) > peak[i]) peak[i] = Math.abs(bp[i])
  }
  const norm = bp.map((b, i) => (peak[i] !== 0 ? b / peak[i] : 0))
  const trigger = highPass1Pole(norm, period / bandwidth / 1.5)
  const signal = norm.map((v, i) => (v < trigger[i] ? 1 : trigger[i] < v ? -1 : 0))
  return { bp, norm, trigger, signal }
}

/**
 * The bars the seed in jesse's high-pass takes to fall below 1e-4 of where it started: the seed
 * decays by (1 - a) a bar, a being highPass1Pole's coefficient at period 4 x period / bandwidth.
 */
export function seedWarmup(period: number, bandwidth: number): number {
  const p = (4 * period) / bandwidth
  const alpha = 1 + (Math.sin((2 * Math.PI) / p) - 1) / Math.cos((2 * Math.PI) / p)
  if (!(alpha > 0 && alpha < 1)) return 0
  return Math.ceil(Math.log(1e-4) / Math.log(1 - alpha))
}

function bandPassJSettings(
  calcParams: readonly unknown[],
  defaults: readonly number[],
  warmAt: number
): { period: number; bandwidth: number; warm: number } {
  const period = Math.min(100000, countParam(calcParams[0], defaults[0], 2))
  // jesse requires 0 < bandwidth < period / 4.
  const bandwidth = Math.min(period / 4 - 1e-9, realParam(calcParams[1], defaults[1], 1e-6))
  const warm = countParam(calcParams[warmAt], 1, 0) >= 1 ? seedWarmup(period, bandwidth) : 0
  return { period, bandwidth, warm }
}

const DEFAULTS = [30, 0.1206, 1]

export function bandPassJRows(bars: readonly KLineData[], calcParams: readonly unknown[]): BandPassJ[] {
  const { period, bandwidth, warm } = bandPassJSettings(calcParams, DEFAULTS, 2)
  const r = bandPassJesse(bars.map((b) => b.close), period, bandwidth)
  return r.bp.map((b, i) =>
    i < warm ? {} : { bp: value(b), norm: value(r.norm[i]), trigger: value(r.trigger[i]), signal: r.signal[i] }
  )
}

const bandPassJ: IndicatorTemplate<BandPassJ, number> = {
  name: 'BANDPASS_J',
  shortName: 'Band-Pass (jesse)',
  calcParams: DEFAULTS,
  precision: 3,
  figures: [
    { key: 'norm', title: 'BP: ', type: 'line' },
    { key: 'trigger', title: 'Trigger: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => bandPassJRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    // norm above the trigger is signal -1 (short), below it +1 (long).
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'norm', 'trigger', drawRange(chart, indicator.result.length),
      withAlpha(down, 0.2), withAlpha(up, 0.2))
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, bandPassJSettings(indicator.calcParams, DEFAULTS, 2).warm)
    return false
  }
}

export interface BandPassJRaw {
  [key: string]: number | undefined
  bp?: number
  state?: number
}

const RAW_DEFAULTS = [36, 0.2412, 1, 1]

export function bandPassJRawRows(bars: readonly KLineData[], calcParams: readonly unknown[]): BandPassJRaw[] {
  const { period, bandwidth, warm } = bandPassJSettings(calcParams, RAW_DEFAULTS, 3)
  const dir = countParam(calcParams[2], 1, 0) >= 1 ? -1 : 1
  const r = bandPassJesse(bars.map((b) => b.close), period, bandwidth)
  return r.bp.map((b, i) => {
    if (i < warm) return {}
    const row: BandPassJRaw = { bp: value(b) }
    if (row.bp !== undefined) row.state = dir * Math.sign(row.bp)
    return row
  })
}

/**
 * BANDPASS_J_RAW -- the same jesse band-pass, read the other way the scan found: its raw line `bp`
 * against zero. This is the C2 of the scan's system 3 (re-ranked, README.md), at period 36,
 * bandwidth 0.2412, inverted.
 *
 * Parameters: [period, bandwidth, inverted, warm-up], default [36, 0.2412, 1, 1].
 *
 * `inverted` 1 is the reading the scan tested: it confirms LONG while the raw line is BELOW zero
 * and short while above; 0 is the conventional reading. The line is drawn in the colour of the side
 * it gives. The raw line is in price units (the close high-passed and band-passed), so its scale
 * follows the pair. The warm-up above applies: blank for the first 876 bars at the default.
 */
const bandPassJRaw: IndicatorTemplate<BandPassJRaw, number> = {
  name: 'BANDPASS_J_RAW',
  shortName: 'Band-Pass (jesse) raw',
  calcParams: RAW_DEFAULTS,
  precision: 5,
  figures: [
    {
      key: 'bp',
      title: 'BP: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    }
  ],
  calc: (dataList: KLineData[], indicator) => bandPassJRawRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, bandPassJSettings(indicator.calcParams, RAW_DEFAULTS, 3).warm)
    return false
  }
}

export { bandPassJRaw }
export default bandPassJ
