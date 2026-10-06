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
 * MetaTrader 4's built-in averages and ATR, with MT4's own definitions -- the
 * NNFX templates in this directory are MQL indicators, and these are the primitives their source
 * calls. Each mirrors `nnfx/ports/_mt4.py` in the workspace repo, which the parity fixture
 * (fixtures/parity.json) is generated from, including how each one treats a NaN (an inner
 * series' warm-up):
 *
 *   sma   -- iMA MODE_SMA. A NaN restarts the window: no value until n finite ones follow it.
 *   ema   -- iMA MODE_EMA, alpha 2/(n+1), seeded with the FIRST value (not an SMA), so it has a
 *            value from the first bar; a NaN is skipped with the state carried over it.
 *   smma  -- iMA MODE_SMMA (Wilder), seeded with the SMA of the first n values; NaNs skipped.
 *   lwma  -- iMA MODE_LWMA, newest bar weighted n; no value while its window holds a NaN.
 *   atr   -- iATR: the SMA of true range, the first bar's true range being its high - low.
 *
 * All four are IIR or windowed over the bars the chart holds, so -- as with every indicator on
 * this chart -- an IIR value (ema, smma) depends slightly on where the loaded history starts.
 */

export function sma(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  let sum = 0
  let count = 0
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) {
      sum = 0
      count = 0
      continue
    }
    sum += x[i]
    count++
    if (count > n) {
      sum -= x[i - n]
      count = n
    }
    if (count === n) out[i] = sum / n
  }
  return out
}

export function ema(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  const alpha = 2 / (n + 1)
  let prev = Number.NaN
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) continue
    prev = Number.isNaN(prev) ? x[i] : prev + alpha * (x[i] - prev)
    out[i] = prev
  }
  return out
}

export function smma(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  let sum = 0
  let count = 0
  let prev = Number.NaN
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) continue
    if (Number.isNaN(prev)) {
      sum += x[i]
      count++
      if (count === n) {
        prev = sum / n
        out[i] = prev
      }
    } else {
      prev = (prev * (n - 1) + x[i]) / n
      out[i] = prev
    }
  }
  return out
}

export function lwma(x: readonly number[], n: number): number[] {
  const out = new Array<number>(x.length).fill(Number.NaN)
  const norm = (n * (n + 1)) / 2
  for (let i = n - 1; i < x.length; i++) {
    let sum = 0
    let ok = true
    for (let j = 0; j < n; j++) {
      const v = x[i - j]
      if (!Number.isFinite(v)) {
        ok = false
        break
      }
      sum += v * (n - j)
    }
    if (ok) out[i] = sum / norm
  }
  return out
}

/** MT4's MA method numbering: 0 SMA, 1 EMA, 2 SMMA, 3 LWMA. */
export const MT4_MA_METHODS = ['SMA', 'EMA', 'SMMA', 'LWMA'] as const

export function maByMethod(x: readonly number[], n: number, method: number): number[] {
  switch (method) {
    case 1:
      return ema(x, n)
    case 2:
      return smma(x, n)
    case 3:
      return lwma(x, n)
    default:
      return sma(x, n)
  }
}

export function atr(bars: readonly KLineData[], n: number): number[] {
  const tr = bars.map((bar, i) => {
    if (i === 0) return bar.high - bar.low
    const prevClose = bars[i - 1].close
    return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose))
  })
  return sma(tr, n)
}

/** A count from the settings dialog: a blank field arrives as undefined, a typed one may be fractional. */
export function countParam(value: unknown, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.floor(value)) : fallback
}

/** A real-valued setting, clamped below at `min`. */
export function realParam(value: unknown, fallback: number, min: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(min, value) : fallback
}

/** NaN (no value yet) as the absent field klinecharts expects. */
export function value(x: number): number | undefined {
  return Number.isFinite(x) ? x : undefined
}
