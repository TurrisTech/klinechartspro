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
import { drawRange, fillBetween, guide, guideColor, signColors, withAlpha } from './paint'

/**
 * BANDPASS_J -- Ehlers' band-pass filter as jesse 3.2.4 computes it (windicators
 * `band_pass_filter_jesse`, the code the windicators NNFX scan ran), in a sub-pane: the C2 of the
 * scan's systems 3 and 5 and of its best system overall, at period 30, bandwidth 0.1206. Not the
 * BANDPASS template (mladen's MT4 filter, a different formula).
 *
 * Parameters: [period, bandwidth], default [30, 0.1206] (jesse's own: 20, 0.3).
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
 * Mind the warm-up. jesse seeds the high-pass with the close itself, and at the scan's setting its
 * period is 4 x 30 / 0.1206, about 1,000 bars, so the seed rings for several hundred bars after the
 * oldest bar the chart has loaded. The scan computed it from the start of the history (2005 on
 * 1D); trust it only well past the start of the loaded data.
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

export function bandPassJRows(bars: readonly KLineData[], calcParams: readonly unknown[]): BandPassJ[] {
  const period = Math.min(100000, countParam(calcParams[0], 30, 2))
  // jesse requires 0 < bandwidth < period / 4.
  const bandwidth = Math.min(period / 4 - 1e-9, realParam(calcParams[1], 0.1206, 1e-6))
  const r = bandPassJesse(bars.map((b) => b.close), period, bandwidth)
  return r.bp.map((b, i) => ({ bp: value(b), norm: value(r.norm[i]), trigger: value(r.trigger[i]), signal: r.signal[i] }))
}

const bandPassJ: IndicatorTemplate<BandPassJ, number> = {
  name: 'BANDPASS_J',
  shortName: 'Band-Pass (jesse)',
  calcParams: [30, 0.1206],
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
    return false
  }
}

export default bandPassJ
