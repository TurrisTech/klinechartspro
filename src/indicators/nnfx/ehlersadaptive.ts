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

import { npSum as numpySum, vsMean, windowMean } from './pdwindow'

// numpy's pairwise sum (pdwindow.ts), under the name the tests import it by.
export { numpySum }

/**
 * The front end of Ehlers' adaptive indicators (Cycle Analytics for Traders, 2013, chapters 8 and
 * 11) as thetestspecimen's MQL5 ports compute it, ported line for line from windicators
 * `_kernels/ehlers_mql5_acp.py` (the code the windicators NNFX scan ran, snapshot 0b4dcc0), and
 * the two back ends the ADAPT_BP, ADAPT_BP_CUBE and ADAPT_RSI templates draw (`computeBandPass`,
 * `computeRSI`). Every array is chronological, oldest bar first, and every loop and every
 * operation keeps the source's order (numpy's pairwise sum included, for the scan's exact mean),
 * so the result is windicators' to the last bit where the platform's cos, sin and exp are the C
 * library's, as numba's are: under bun on Linux (JavaScriptCore calls glibc) the three templates
 * match windicators on all 28 prod pairs' full 1D histories to 1.1e-16 (2026-10-15). Chrome's V8
 * has its own (fdlibm) cos, sin and exp, one ulp from glibc's on about 3% of the arguments used
 * here, and the periodogram's 0.5 test and the truncated cycle can turn on an ulp; see
 * adaptivebandpass.ts for what that changes (no state; a few band-pass values, slightly).
 *
 *   roofing        a two-pole high-pass at hpPeriod, then the SuperSmoother at lpPeriod; on bars
 *                  0-2 the high-pass is (1 - alpha1/2)^2 x price and the SuperSmoother c1 x that
 *   dominantCycle  from bar hpPeriod + avLength + 2, the Pearson correlation of the filtered price
 *                  with itself at lags 0..hpPeriod over avgLength bars (the lag itself when
 *                  avgLength is 0; a lag whose variance product is not positive keeps its value);
 *                  on every bar, the DFT power at periods lpPeriod..hpPeriod of the correlations at
 *                  lags 3..hpPeriod, an EMA of its square (0.2 new), a peak decaying by 0.991, the
 *                  powers over it, and the centre of gravity of the periods at >= 0.5 of the peak,
 *                  raised to lpPeriod (and, for the RSI, cut to hpPeriod)
 *   bandPass       from bar hpPeriod + 2, a band-pass at 0.9 x the truncated cycle, over a peak
 *                  decaying by 0.991 (cubed for the cube transform); signal = 0.9 x the last value
 *   rsi            from bar hpPeriod + 2, the RSI of the filtered price over half the cycle, its
 *                  ratio SuperSmoothed at lpPeriod
 */

/** `MathSqrt(2.0)`. */
const SQRT2 = Math.sqrt(2)

/** `c1, c2, c3` as `processLowPass` and every `compute*` function compute them. */
export function superSmootherCoefficients(lpPeriod: number): [number, number, number] {
  const a1 = Math.exp((-1 * SQRT2 * Math.PI) / lpPeriod)
  const b1 = 2 * a1 * Math.cos((SQRT2 * Math.PI) / lpPeriod)
  const c2 = b1
  const c3 = -a1 * a1
  return [1 - c2 - c3, c2, c3]
}

/** `processHighPass` then `processLowPass` over every bar: the roofing-filtered price. */
export function roofing(price: readonly number[], hpPeriod: number, lpPeriod: number): number[] {
  const n = price.length
  const hp = new Array<number>(n).fill(0)
  const filt = new Array<number>(n).fill(0)
  const w = (SQRT2 * Math.PI) / hpPeriod
  const alpha1 = (Math.cos(w) + Math.sin(w) - 1) / Math.cos(w)
  const k0 = (1 - alpha1 / 2) * (1 - alpha1 / 2)
  const k1 = 2 * (1 - alpha1)
  const k2 = (1 - alpha1) * (1 - alpha1)
  const [c1, c2, c3] = superSmootherCoefficients(lpPeriod)
  for (let i = 0; i < n; i++) {
    if (i < 3) {
      hp[i] = k0 * price[i]
      filt[i] = c1 * hp[i]
    } else {
      hp[i] = k0 * (price[i] - 2 * price[i - 1] + price[i - 2]) + k1 * hp[i - 1] - k2 * hp[i - 2]
      filt[i] = (c1 * (hp[i] + hp[i - 1])) / 2 + c2 * filt[i - 1] + c3 * filt[i - 2]
    }
  }
  return filt
}

/**
 * The dominant cycle on every bar (a double, before the callers' `(int)`): `processPearsonCorr`,
 * `processDFT`, `processEMA`, `processAGC` and `computeDominantCycle`. `clampHigh` cuts it to
 * hpPeriod (the RSI file); the band-pass files raise it to lpPeriod only.
 */
export function dominantCycle(filt: readonly number[], avgLength: number, hpPeriod: number, lpPeriod: number, clampHigh: boolean): number[] {
  const n = filt.length
  const hp = hpPeriod
  const lp = lpPeriod
  const corr = new Array<number>(hp + 1).fill(0)
  const r0 = new Array<number>(hp + 1).fill(0)
  const pwr = new Array<number>(hp + 1).fill(0)
  const sqsum = new Array<number>(hp + 1).fill(0)
  let maxPwr = 0
  // MathCos(2 * pi * (double) n / (double) period): a pure function of (period, n), tabulated.
  const cosT: number[][] = []
  const sinT: number[][] = []
  for (let period = lp; period <= hp; period++) {
    const c = new Array<number>(hp + 1).fill(0)
    const s = new Array<number>(hp + 1).fill(0)
    for (let k = 3; k <= hp; k++) {
      const ang = (2 * Math.PI * k) / period
      c[k] = Math.cos(ang)
      s[k] = Math.sin(ang)
    }
    cosT[period] = c
    sinT[period] = s
  }
  const avLength = avgLength !== 0 ? avgLength : hp
  const out = new Array<number>(n)
  for (let i = 0; i < n; i++) {
    if (i > hp + 1 + avLength) {
      for (let lag = 0; lag <= hp; lag++) {
        const m = avgLength !== 0 ? avgLength : lag
        let sx = 0
        let sy = 0
        let sxx = 0
        let syy = 0
        let sxy = 0
        for (let count = 0; count < m; count++) {
          const x = filt[i - count]
          const y = filt[i - lag - count]
          sx = sx + x
          sy = sy + y
          sxx = sxx + x * x
          sxy = sxy + x * y
          syy = syy + y * y
        }
        const v = (m * sxx - sx * sx) * (m * syy - sy * sy)
        if (v > 0) corr[lag] = (m * sxy - sx * sy) / Math.sqrt(v)
      }
    }
    for (let period = lp; period <= hp; period++) {
      const c = cosT[period]
      const s = sinT[period]
      let cosPart = 0
      let sinPart = 0
      for (let k = 3; k <= hp; k++) {
        cosPart = cosPart + corr[k] * c[k]
        sinPart = sinPart + corr[k] * s[k]
      }
      sqsum[period] = cosPart * cosPart + sinPart * sinPart
    }
    for (let period = lp; period <= hp; period++) r0[period] = 0.2 * (sqsum[period] * sqsum[period]) + 0.8 * r0[period]
    maxPwr = 0.991 * maxPwr
    for (let period = lp; period <= hp; period++) if (r0[period] > maxPwr) maxPwr = r0[period]
    // Periods below lpPeriod keep r = 0, so only lpPeriod..hpPeriod can reach 0.5.
    for (let period = lp; period <= hp; period++) pwr[period] = maxPwr !== 0 ? r0[period] / maxPwr : 0
    let spx = 0
    let sp = 0
    for (let period = lp; period <= hp; period++) {
      if (pwr[period] >= 0.5) {
        spx = spx + period * pwr[period]
        sp = sp + pwr[period]
      }
    }
    let dom = sp !== 0 ? spx / sp : 0
    if (dom < lp) dom = lp
    if (clampHigh && dom > hp) dom = hp
    out[i] = dom
  }
  return out
}

/**
 * `computeBandPass` of ehlers_adaptive_bandpass.mq5 (`cube` false) and of
 * ehlers_adaptive_bandpass_cube.mq5 (`cube` true: the normalised value cubed). `out` is 0 before
 * bar hpPeriod + 2 and `signal` NaN, as windicators writes them.
 */
export function adaptiveBandPass(filt: readonly number[], dc: readonly number[], hpPeriod: number, bandwidth: number, cube: boolean): { out: number[]; signal: number[] } {
  const n = filt.length
  const bp = new Array<number>(n).fill(0)
  const out = new Array<number>(n).fill(0)
  const signal = new Array<number>(n).fill(Number.NaN)
  let peak = 0
  for (let i = hpPeriod + 2; i < n; i++) {
    const dom = Math.trunc(dc[i])
    const beta1 = Math.cos((2 * Math.PI) / (0.9 * dom))
    const gamma1 = 1 / Math.cos((2 * Math.PI * bandwidth) / (0.9 * dom))
    const alpha2 = gamma1 - Math.sqrt(gamma1 * gamma1 - 1)
    bp[i] = 0.5 * (1 - alpha2) * (filt[i] - filt[i - 2]) + beta1 * (1 + alpha2) * bp[i - 1] - alpha2 * bp[i - 2]
    peak = 0.991 * peak
    if (Math.abs(bp[i]) > peak) peak = Math.abs(bp[i])
    out[i] = peak !== 0 ? (cube ? (bp[i] / peak) ** 3 : bp[i] / peak) : 0
    signal[i] = 0.9 * out[i - 1]
  }
  return { out, signal }
}

/** `computeRSI` of ehlers_adaptive_rsi.mq5: 0 before bar hpPeriod + 2, and wherever Denom or Denom[1] is 0. */
export function adaptiveRsi(filt: readonly number[], dc: readonly number[], hpPeriod: number, lpPeriod: number): number[] {
  const n = filt.length
  const rsi = new Array<number>(n).fill(0)
  const denom = new Array<number>(n).fill(0)
  const [c1, c2, c3] = superSmootherCoefficients(lpPeriod)
  let closeUp1 = 0
  for (let i = hpPeriod + 2; i < n; i++) {
    const dom = Math.trunc(dc[i])
    let closeUp = 0
    let closeDown = 0
    const rsiDom = Math.floor(dom / 2) - 1
    for (let count = 0; count <= rsiDom; count++) {
      const a = filt[i - count]
      const b = filt[i - count - 1]
      if (a > b) closeUp = closeUp + (a - b)
      if (a < b) closeDown = closeDown + (b - a)
    }
    denom[i] = closeUp + closeDown
    rsi[i] = denom[i] !== 0 && denom[i - 1] !== 0 ? (c1 * (closeUp / denom[i] + closeUp1 / denom[i - 1])) / 2 + c2 * rsi[i - 1] + c3 * rsi[i - 2] : 0
    closeUp1 = closeUp
  }
  return rsi
}

/**
 * A line against its own exact k-bar mean, as the scan's `ma3` / `ma8` forms read it
 * (`nnfx.forms.vs_sma`): `vs` is the mean of x's distance from each value in the window, so a line
 * that has held one value for k bars reads exactly 0; `ma` is the mean itself, which is drawn.
 * Both are NaN while the window holds a NaN.
 */
export function versusMean(x: readonly number[], k: number): { ma: number[]; vs: number[] } {
  return { ma: windowMean(x, k), vs: vsMean(x, k) }
}

/**
 * The first bar ADAPT_BP and ADAPT_BP_CUBE draw with `warm-up` 1: 3 hp_period + 0.75 hp_period /
 * bandwidth + 100, rounded up. Measured, not derived (adaptivebandpass.ts): on the 28 prod pairs'
 * 1D bars, from there the reading of a chart's history agrees with the from-2005 one on at least
 * 99.5% of bars at every later bar, at every setting measured but lp_period = hp_period.
 */
export function bandPassWarmup(hpPeriod: number, bandwidth: number): number {
  return Math.ceil(3 * hpPeriod + (0.75 * hpPeriod) / bandwidth + 100)
}

/** The first bar ADAPT_RSI draws with `warm-up` 1: 3 hp_period + 120, measured as bandPassWarmup is (adaptiversi.ts). */
export function rsiWarmup(hpPeriod: number): number {
  return 3 * hpPeriod + 120
}

/** The sign a reading gives, +1 / -1 / 0, flipped by `dir` (-1 inverted), never -0. */
export function side(x: number, dir: number): number {
  return x > 0 ? dir : x < 0 ? -dir : 0
}
