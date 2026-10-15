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

import { adaptiveBandPass, bandPassWarmup, dominantCycle, roofing, side, versusMean } from './ehlersadaptive'
import { countParam, realParam, value } from './mt4'
import { drawRange, fillBetween, guide, guideColor, signColors, signLineStyle, warmupMark, withAlpha } from './paint'

/**
 * Ehlers' adaptive band-pass (Cycle Analytics for Traders, 2013, Code Listing 11-4) and its cube
 * transform (ch. 15), as thetestspecimen's MQL5 ports compute them (windicators
 * `ehlers_adaptive_bandpass` / `ehlers_adaptive_bandpass_cube`, the code the windicators NNFX scan
 * ran, snapshot 0b4dcc0). Two templates share the computation, in sub-panes:
 *
 *   ADAPT_BP       the normalised band-pass and its signal line, the signal against its own `ma`-bar
 *                  average: the scan's 1D C1 #18, +1.89 %/yr per pair, 22/28 pairs positive.
 *   ADAPT_BP_CUBE  the band-pass cubed, against zero: the scan's 1D C1 #17, +1.97 %/yr per pair,
 *                  20/28 pairs positive.
 *
 * Both are in-sample, best-of-grid C1 rankings (results/windicators-6y/README.md, round 3).
 *
 * ADAPT_BP parameters: [bandwidth, avg_length, hp_period, lp_period, ma, inverted, warm-up],
 * default [0.3, 6, 24, 15, 8, 1, 1]. ADAPT_BP_CUBE: [bandwidth, avg_length, hp_period, lp_period,
 * inverted, warm-up], default [0.1608, 6, 24, 15, 1, 1] (the scan's 0.16080000000000003, which gives
 * windicators' output bit for bit at 0.1608 on all 28 pairs' 1D histories). The source's own
 * defaults: bandwidth 0.3, avg_length 3, hp_period 48, lp_period 10. Fixed at the scan's value:
 * price 0, the close. The ranges are windicators' (bandwidth 0.01-1, lp_period >= 5, hp_period >=
 * 3), but hp_period and avg_length stop at 200: the periodogram costs about hp_period^2 a bar.
 *
 *   filt   = the SuperSmoother (lp_period) of a two-pole high-pass (hp_period) of the close
 *   cycle  = the dominant cycle the autocorrelation periodogram of filt measures each bar
 *            (ehlersadaptive.ts): the centre of gravity of the periods lp_period..hp_period whose
 *            power is at least half the decaying peak's, at least lp_period, truncated to an integer
 *   bp     = 0.5 (1 - a2)(filt - filt[2]) + b1 (1 + a2) bp[1] - a2 bp[2], tuned to 0.9 x cycle:
 *            b1 = cos(2 pi / (0.9 cycle)), g1 = 1 / cos(2 pi bandwidth / (0.9 cycle)),
 *            a2 = g1 - sqrt(g1^2 - 1)
 *   bandpass = bp / peak, the peak decaying by 0.991 a bar and raised to |bp|: -1 to 1
 *   cube   = bandpass^3
 *   signal = 0.9 x the line's previous value
 *
 * windicators (as MetaTrader) writes the line as 0 before bar hp_period + 2 and the signal from
 * there, its first value 0.9 x that 0; the templates leave all of those bars blank.
 *
 * The readings the scan tested, both with `inverted` 1 (0 gives the conventional reading):
 *   ADAPT_BP       the SIGNAL against its exact 8-bar mean (the mean of its distance from each
 *                  value in the window, so a signal held for 8 bars reads 0, no side): LONG while
 *                  the signal is BELOW its mean. Drawn: the band-pass (context), the signal and its
 *                  mean, the area between them shaded in the colour of the side it gives; guides at
 *                  0 and at the source's +/-0.707.
 *   ADAPT_BP_CUBE  the CUBE against zero, LONG while it is BELOW zero; the cube's sign is the
 *                  band-pass's. Drawn in the colour of the side it gives; the signal line neutral.
 *
 * **Warm-up.** Everything here is recursive and adaptive: the roofing filter starts with the price
 * level as a step, the periodogram's peak decays by 0.991 a bar from whatever the start-up made
 * it, the cycle it measures retunes the band-pass, and the band-pass's own state decays at its
 * pole radius. The scan computed from 2005; a chart computes from its oldest loaded bar.
 * Measured with windicators on the 28 prod pairs' 1D bars (2026-10-15), each computed from 4,396
 * later start points, against the from-2005 reading:
 *   ADAPT_BP at the defaults: the reading disagreed on 37% of bars at its first bar (33 bars in),
 *     20% at bar 50, 7.1% at 100, 0.9% at 150, 0.2% at 200, none from 250; on at most 0.5% at
 *     every bar from bar 184.
 *   ADAPT_BP_CUBE at the defaults: 50% at its first bar (26), 23.5% at 50, 12.7% at 100, 3.2% at
 *     150, 0.5% at 200, 0.1% at 250; at most 0.5% from bar 224.
 * Over a grid of settings (hp_period 12-100 x bandwidth 0.1-1, both templates) the bar from which
 * the reading disagrees on at most 0.5% grows with hp_period and with hp_period / bandwidth (the
 * band-pass's time constant at the longest cycle), and is below 3 hp_period + 0.75 hp_period /
 * bandwidth + 100 at every setting measured but lp_period = hp_period (a one-period periodogram:
 * 302 at 24 / 24, which the formula puts at 232). So with `warm-up` 1 the templates leave that
 * many bars blank (`bandPassWarmup`): 232 at ADAPT_BP's defaults, 284 at ADAPT_BP_CUBE's, from
 * where the reading disagreed on 0.001% of 5.3-5.6 million bars, at most 0.09% at any bar. The pane
 * says how many bars it needs while it has too few (paint.ts `warmupMark`); 0 draws from the first
 * bar.
 *
 * **In Chrome** the drawn lines can differ slightly from windicators': V8's cos, sin and exp are
 * one ulp from glibc's (which windicators' numba calls) on about 3% of the arguments used, and the
 * periodogram's 0.5 test and the truncated cycle can turn on that ulp (ehlersadaptive.ts). Over
 * 1,120 chart starts on the 28 prod pairs' 1D bars, 1,500 bars each with the warm-up on (V8 13.6
 * against bun's glibc maths, which matches windicators to 1e-16; 2026-10-15): not one state
 * differed; in 13 starts the band-pass differed from windicators' by up to 1.6e-6 relative and the
 * cube by up to 1e-4, on 0.08% and 0.18% of drawn bars.
 *
 * Locked to windicators by fixtures/wscan_r3_adaptive.json.
 */

export interface AdaptiveBandPassRow {
  [key: string]: number | undefined
  bandpass?: number
  cube?: number
  signal?: number
  ma?: number
  state?: number
}

const BP_DEFAULTS = [0.3, 6, 24, 15, 8, 1, 1]
const CUBE_DEFAULTS = [0.1608, 6, 24, 15, 1, 1]

export interface AdaptiveBandPassSettings {
  bandwidth: number
  avgLength: number
  hpPeriod: number
  lpPeriod: number
  ma: number
  dir: number
  warm: number
}

// windicators' ranges (bandwidth 0.01-1, lp_period >= 5, hp_period >= 3), with hp_period and
// avg_length capped where the periodogram's per-bar cost (hp_period^2) stays small.
function common(calcParams: readonly unknown[], d: readonly number[]): Omit<AdaptiveBandPassSettings, 'ma' | 'dir' | 'warm'> {
  return {
    bandwidth: Math.min(1, realParam(calcParams[0], d[0], 0.01)),
    avgLength: Math.min(200, countParam(calcParams[1], d[1], 0)),
    hpPeriod: Math.min(200, countParam(calcParams[2], d[2], 3)),
    lpPeriod: Math.min(10000, countParam(calcParams[3], d[3], 5))
  }
}

export function adaptiveBpSettings(calcParams: readonly unknown[]): AdaptiveBandPassSettings {
  const c = common(calcParams, BP_DEFAULTS)
  const ma = Math.min(1000, countParam(calcParams[4], BP_DEFAULTS[4], 1))
  const dir = countParam(calcParams[5], 1, 0) >= 1 ? -1 : 1
  const warm = countParam(calcParams[6], 1, 0) >= 1 ? bandPassWarmup(c.hpPeriod, c.bandwidth) : 0
  return { ...c, ma, dir, warm }
}

export function adaptiveBpCubeSettings(calcParams: readonly unknown[]): AdaptiveBandPassSettings {
  const c = common(calcParams, CUBE_DEFAULTS)
  const dir = countParam(calcParams[4], 1, 0) >= 1 ? -1 : 1
  const warm = countParam(calcParams[5], 1, 0) >= 1 ? bandPassWarmup(c.hpPeriod, c.bandwidth) : 0
  return { ...c, ma: 0, dir, warm }
}

/** The line (normalised or cubed) and its signal, blank where windicators writes the warm-up's zeros. */
function lines(bars: readonly KLineData[], s: AdaptiveBandPassSettings, cube: boolean): { line: number[]; signal: number[] } {
  const filt = roofing(
    bars.map((b) => b.close),
    s.hpPeriod,
    s.lpPeriod
  )
  const dc = dominantCycle(filt, s.avgLength, s.hpPeriod, s.lpPeriod, false)
  const { out, signal } = adaptiveBandPass(filt, dc, s.hpPeriod, s.bandwidth, cube)
  return {
    line: out.map((x, i) => (i >= s.hpPeriod + 2 ? x : Number.NaN)),
    signal: signal.map((x, i) => (i >= s.hpPeriod + 3 ? x : Number.NaN))
  }
}

export function adaptiveBpRows(bars: readonly KLineData[], calcParams: readonly unknown[]): AdaptiveBandPassRow[] {
  const s = adaptiveBpSettings(calcParams)
  const { line, signal } = lines(bars, s, false)
  const { ma, vs } = versusMean(signal, s.ma)
  const from = Math.max(s.hpPeriod + 2, s.warm)
  return bars.map((_, i) => {
    if (i < from) return {}
    const row: AdaptiveBandPassRow = { bandpass: value(line[i]), signal: value(signal[i]), ma: value(ma[i]) }
    if (Number.isFinite(vs[i])) row.state = side(vs[i], s.dir)
    return row
  })
}

export function adaptiveBpCubeRows(bars: readonly KLineData[], calcParams: readonly unknown[]): AdaptiveBandPassRow[] {
  const s = adaptiveBpCubeSettings(calcParams)
  const { line, signal } = lines(bars, s, true)
  const from = Math.max(s.hpPeriod + 2, s.warm)
  return bars.map((_, i) => {
    if (i < from) return {}
    const row: AdaptiveBandPassRow = { cube: value(line[i]), signal: value(signal[i]) }
    if (Number.isFinite(line[i])) row.state = side(line[i], s.dir)
    return row
  })
}

const adaptiveBp: IndicatorTemplate<AdaptiveBandPassRow, number> = {
  name: 'ADAPT_BP',
  shortName: 'Adaptive BandPass',
  calcParams: BP_DEFAULTS,
  precision: 4,
  figures: [
    { key: 'bandpass', title: 'BP: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) },
    { key: 'signal', title: 'Signal: ', type: 'line' },
    { key: 'ma', title: 'MA: ', type: 'line' }
  ],
  calc: (dataList: KLineData[], indicator) => adaptiveBpRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
    const { up, down } = signColors(indicator, chart.getStyles().indicator)
    const s = adaptiveBpSettings(indicator.calcParams)
    const [above, below] = s.dir < 0 ? [down, up] : [up, down]
    fillBetween(ctx, xAxis, yAxis, indicator.result, 'signal', 'ma', drawRange(chart, indicator.result.length),
      withAlpha(above, 0.22), withAlpha(below, 0.22))
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    // The source's levels, +/-0.707.
    guide(ctx, bounding, yAxis, Math.SQRT1_2, guideColor(chart))
    guide(ctx, bounding, yAxis, -Math.SQRT1_2, guideColor(chart))
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, s.warm)
    return false
  }
}

const adaptiveBpCube: IndicatorTemplate<AdaptiveBandPassRow, number> = {
  name: 'ADAPT_BP_CUBE',
  shortName: 'Adaptive BandPass Cube',
  calcParams: CUBE_DEFAULTS,
  precision: 4,
  figures: [
    {
      key: 'cube',
      title: 'Cube: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.state, indicator, defaultStyles), size: 2 })
    },
    { key: 'signal', title: 'Signal: ', type: 'line', styles: ({ indicator, defaultStyles }) => ({ color: signColors(indicator, defaultStyles).flat }) }
  ],
  calc: (dataList: KLineData[], indicator) => adaptiveBpCubeRows(dataList, indicator.calcParams),
  draw: ({ ctx, chart, bounding, indicator, xAxis, yAxis }) => {
    guide(ctx, bounding, yAxis, 0, guideColor(chart), false)
    warmupMark(ctx, chart, bounding, xAxis, indicator.result.length, adaptiveBpCubeSettings(indicator.calcParams).warm)
    return false
  }
}

export { adaptiveBp, adaptiveBpCube }
export default adaptiveBp
