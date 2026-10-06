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

import type { KLineData } from 'klinecharts'

/**
 * TA-Lib's own definitions of the two primitives the library templates here need, which differ
 * from MT4's (mt4.ts) in their seeds. Both are locked to TA-Lib 0.8.1's output by
 * fixtures/library_parity.json.
 */

/**
 * TA-Lib's EMA: alpha 2/(n+1), seeded with the SMA of the first n values of the series -- counted
 * from its first finite value, so it can smooth a series that starts with a warm-up of NaNs.
 */
export function emaTalib(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  const start = x.findIndex((v) => Number.isFinite(v))
  if (start < 0 || x.length - start < n) return out
  let prev = 0
  for (let i = start; i < start + n; i++) prev += x[i]
  prev /= n
  out[start + n - 1] = prev
  const alpha = 2 / (n + 1)
  for (let i = start + n; i < x.length; i++) {
    prev += alpha * (x[i] - prev)
    out[i] = prev
  }
  return out
}

/**
 * TA-Lib's ATR (Wilder): true range from the second bar on (it needs a previous close), the first
 * value the mean of the first n true ranges, then (prev * (n - 1) + TR) / n.
 */
export function atrWilder(bars: readonly KLineData[], n: number): number[] {
  const out = new Array<number>(bars.length).fill(Number.NaN)
  if (bars.length <= n) return out
  const tr = (i: number) => {
    const prevClose = bars[i - 1].close
    return Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - prevClose), Math.abs(bars[i].low - prevClose))
  }
  let prev = 0
  for (let i = 1; i <= n; i++) prev += tr(i)
  prev /= n
  out[n] = prev
  for (let i = n + 1; i < bars.length; i++) {
    prev = (prev * (n - 1) + tr(i)) / n
    out[i] = prev
  }
  return out
}

/** The highest high / lowest low of the `n` bars ending at each bar, NaN until n bars exist. */
export function rollingExtreme(xs: readonly number[], n: number, pick: 'max' | 'min'): number[] {
  return xs.map((_, i) => {
    if (i < n - 1) return Number.NaN
    let best = xs[i]
    for (let k = i - n + 1; k < i; k++) best = pick === 'max' ? Math.max(best, xs[k]) : Math.min(best, xs[k])
    return best
  })
}
