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

// pandas' and numpy's window arithmetic as windicators reproduces it (windicators
// `_kernels/pandas_ewm.py`, `pandas_rolling.py`, `pandas_ta_ma.py`'s `np_sum`), and the windicators
// NNFX scan's "line against its own k-bar mean" reading (`nnfx/forms.py` `sma`, `vs_sma`). Shared by
// the MICD, RCCD, MACD_BB and TMO templates; each is ported operation for operation, because a
// TDX SMA or a pandas EMA rounds differently from the textbook formula.

/** numpy's `pairwise_sum_DOUBLE` for one block of at most 128 values. */
function pairwiseBlock(a: ArrayLike<number>, lo: number, n: number): number {
  if (n < 8) {
    let res = 0
    for (let i = 0; i < n; i++) res += a[lo + i]
    return res
  }
  const r = [a[lo], a[lo + 1], a[lo + 2], a[lo + 3], a[lo + 4], a[lo + 5], a[lo + 6], a[lo + 7]]
  let i = 8
  const stop = n - (n % 8)
  for (; i < stop; i += 8) for (let j = 0; j < 8; j++) r[j] += a[lo + i + j]
  let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]))
  for (; i < n; i++) res += a[lo + i]
  return res
}

/**
 * `np.sum(a[lo:lo + n])` in numpy's pairwise order: blocks of at most 128 values, a longer run
 * split at n / 2 rounded down to a multiple of 8 (windicators `np_sum`; it is also the order of
 * `sliding_window_view(x, k).sum(axis=1)`, checked on 3,000 values for k = 3 .. 1,000).
 */
export function npSum(a: ArrayLike<number>, lo: number, n: number): number {
  if (n <= 128) return pairwiseBlock(a, lo, n)
  let n2 = Math.floor(n / 2)
  n2 -= n2 % 8
  return npSum(a, lo, n2) + npSum(a, lo + n2, n - n2)
}

/**
 * pandas' `ewm(com=com, adjust=False).mean()` with `ignore_na=False` and `min_periods=0`
 * (windicators `ewm_mean`): NaN until the first value, which seeds it; a value equal to the mean
 * leaves it untouched; a NaN is skipped but still ages the older weight.
 */
export function ewmMean(vals: readonly number[], com: number): number[] {
  const n = vals.length
  const out = new Array<number>(n)
  if (n === 0) return out
  const alpha = 1 / (1 + com)
  const oldWtFactor = 1 - alpha
  const newWt = alpha
  let weighted = vals[0]
  out[0] = weighted
  let oldWt = 1
  for (let i = 1; i < n; i++) {
    const cur = vals[i]
    const isObservation = !Number.isNaN(cur)
    if (!Number.isNaN(weighted)) {
      oldWt *= oldWtFactor
      if (isObservation) {
        if (weighted !== cur) {
          weighted = oldWt * weighted + newWt * cur
          weighted /= oldWt + newWt
        }
        oldWt = 1
      }
    } else if (isObservation) {
      weighted = cur
    }
    out[i] = weighted
  }
  return out
}

/**
 * pandas' `rolling(window).mean()` (`min_periods = window`; windicators `rolling_mean`): a running
 * sum, Kahan-compensated separately for the values added and removed; NaN while the window holds
 * fewer than `window` values; the last value exactly when the window's values are all equal; 0
 * for an all-non-negative (all-negative) window that rounds below (above) 0.
 */
export function rollingMean(values: readonly number[], window: number): number[] {
  const n = values.length
  const out = new Array<number>(n)
  let sumX = 0
  let compAdd = 0
  let compRemove = 0
  let nobs = 0
  let negCt = 0
  let same = 0
  let prevValue = 0
  const signbit = (v: number) => v < 0 || Object.is(v, -0)
  for (let i = 0; i < n; i++) {
    const s = Math.max(0, i - window + 1)
    let firstAdd: number
    if (i === 0 || s >= i) {
      sumX = 0
      compAdd = 0
      compRemove = 0
      nobs = 0
      negCt = 0
      prevValue = values[s]
      same = 0
      firstAdd = s
    } else {
      for (let j = Math.max(0, i - window); j < s; j++) {
        const val = values[j]
        if (Number.isNaN(val)) continue
        nobs--
        const y = -val - compRemove
        const t = sumX + y
        compRemove = t - sumX - y
        sumX = t
        if (signbit(val)) negCt--
      }
      firstAdd = i
    }
    for (let j = firstAdd; j <= i; j++) {
      const val = values[j]
      if (Number.isNaN(val)) continue
      nobs++
      const y = val - compAdd
      const t = sumX + y
      compAdd = t - sumX - y
      sumX = t
      if (signbit(val)) negCt++
      if (val === prevValue) same++
      else same = 1
      prevValue = val
    }
    if (nobs >= window && nobs > 0) {
      let result = sumX / nobs
      if (same >= nobs) result = prevValue
      else if (negCt === 0 && result < 0) result = 0
      else if (negCt === nobs && result > 0) result = 0
      out[i] = result
    } else {
      out[i] = Number.NaN
    }
  }
  return out
}

/** `x.shift(k)`: NaN for the first `k` bars. */
export function shift(x: readonly number[], k: number): number[] {
  return x.map((_, i) => (i >= k ? x[i - k] : Number.NaN))
}

/** pandas' `_prep_values`: an infinity is a missing value to a window function. */
export function infToNan(x: readonly number[]): number[] {
  return x.map((v) => (v === Number.POSITIVE_INFINITY || v === Number.NEGATIVE_INFINITY ? Number.NaN : v))
}

/** The scan's exact k-bar mean (`forms.sma`): each window summed afresh, NaN while it holds a NaN. */
export function windowMean(x: readonly number[], k: number): number[] {
  return x.map((_, i) => (i >= k - 1 ? npSum(x, i - k + 1, k) / k : Number.NaN))
}

/**
 * The scan's `ma3` / `ma8` reading (`forms.vs_sma`): x minus its own k-bar mean, taken as the mean
 * of x's distance from each value in the window, so a line that has held one value for k bars reads
 * exactly 0. NaN while the window holds a NaN.
 */
export function vsMean(x: readonly number[], k: number): number[] {
  const d = new Array<number>(k)
  return x.map((v, i) => {
    if (i < k - 1) return Number.NaN
    for (let j = 0; j < k; j++) d[j] = v - x[i - k + 1 + j]
    return npSum(d, 0, k) / k
  })
}

/** A reading's state from a difference: +1, -1, or 0 on a tie, times `dir` (-1 inverted); undefined while it is NaN. */
export function stateOf(d: number, dir: number): number | undefined {
  if (Number.isNaN(d)) return undefined
  return d > 0 ? dir : d < 0 ? -dir : 0
}

/** Bars until an alpha-`a` EMA's seed weighs less than 1e-4: (1 - a)^k < 1e-4. */
export function seedBars(a: number): number {
  return a >= 1 ? 0 : Math.ceil(Math.log(1e-4) / Math.log(1 - a))
}
