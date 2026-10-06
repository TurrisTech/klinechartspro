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
import { guide, guideColor, signLineStyle } from './paint'

/**
 * RSX -- Jurik's Relative Strength Xtra, a smoothed RSI, in a sub-pane, 0..100. This is
 * pandas-ta's implementation, the one the NNFX study ran (System A's C2 is RSX 21 above or below 50).
 *
 * Parameters: [length], default [21].
 *
 * Price changes (x100) and their absolute values each go through three cascaded pairs of EMA
 * stages, alpha 3 / (length + 2), each pair combined as 1.5 x first - 0.5 x second; RSX is
 * (smoothed change / smoothed absolute change + 1) x 50, clipped to 0..100. It reads 50 through a
 * warm-up of max(length - 1, 5) bars, as the source does, and from the bar `length - 1` on; like
 * every IIR filter here, its earliest values depend slightly on where the loaded history starts.
 *
 * The line takes the up colour above 50 and the down colour below. Locked to pandas-ta by
 * fixtures/library_parity.json -- the loop below is that source's, variable for variable.
 */

export interface Rsx {
  [key: string]: number | undefined
  rsx?: number
}

export function rsxOptions(calcParams: readonly unknown[]): { length: number } {
  return { length: countParam(calcParams[0], 21, 2) }
}

export function jurikRsx(bars: readonly KLineData[], length: number): number[] {
  const m = bars.length
  const out = new Array<number>(m).fill(Number.NaN)
  if (m < length) return out
  out[length - 1] = 50
  let vC = 0
  let v1C = 0
  let v4 = 0
  let v8 = 0
  let v10 = 0
  let v14 = 0
  let v18 = 0
  let v20 = 0
  let f0 = 0
  let f8 = 0
  let f10 = 0
  let f18 = 0
  let f20 = 0
  let f28 = 0
  let f30 = 0
  let f38 = 0
  let f40 = 0
  let f48 = 0
  let f50 = 0
  let f58 = 0
  let f60 = 0
  let f68 = 0
  let f70 = 0
  let f78 = 0
  let f80 = 0
  let f88 = 0
  let f90 = 0
  for (let i = length; i < m; i++) {
    const close = bars[i].close
    if (f90 === 0) {
      f90 = 1.0
      f0 = 0.0
      f88 = length - 1.0 >= 5 ? length - 1.0 : 5.0
      f8 = 100.0 * close
      f18 = 3.0 / (length + 2.0)
      f20 = 1.0 - f18
    } else {
      f90 = f88 <= f90 ? f88 + 1 : f90 + 1
      f10 = f8
      f8 = 100 * close
      v8 = f8 - f10
      f28 = f20 * f28 + f18 * v8
      f30 = f18 * f28 + f20 * f30
      vC = 1.5 * f28 - 0.5 * f30
      f38 = f20 * f38 + f18 * vC
      f40 = f18 * f38 + f20 * f40
      v10 = 1.5 * f38 - 0.5 * f40
      f48 = f20 * f48 + f18 * v10
      f50 = f18 * f48 + f20 * f50
      v14 = 1.5 * f48 - 0.5 * f50
      f58 = f20 * f58 + f18 * Math.abs(v8)
      f60 = f18 * f58 + f20 * f60
      v18 = 1.5 * f58 - 0.5 * f60
      f68 = f20 * f68 + f18 * v18
      f70 = f18 * f68 + f20 * f70
      v1C = 1.5 * f68 - 0.5 * f70
      f78 = f20 * f78 + f18 * v1C
      f80 = f18 * f78 + f20 * f80
      v20 = 1.5 * f78 - 0.5 * f80
      if (f88 >= f90 && f8 !== f10) f0 = 1.0
      if (f88 === f90 && f0 === 0.0) f90 = 0.0
    }
    if (f88 < f90 && v20 > 0.0000000001) {
      v4 = (v14 / v20 + 1.0) * 50.0
      if (v4 > 100.0) v4 = 100.0
      if (v4 < 0.0) v4 = 0.0
    } else {
      v4 = 50.0
    }
    out[i] = v4
  }
  return out
}

const rsx: IndicatorTemplate<Rsx, number> = {
  name: 'RSX',
  shortName: 'RSX',
  calcParams: [21],
  precision: 2,
  minValue: 0,
  maxValue: 100,
  figures: [
    {
      key: 'rsx',
      title: 'RSX: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => signLineStyle(Math.sign((data.current?.rsx ?? 50) - 50), indicator, defaultStyles)
    }
  ],
  calc: (dataList: KLineData[], indicator) => jurikRsx(dataList, rsxOptions(indicator.calcParams).length).map((v) => ({ rsx: value(v) })),
  draw: ({ ctx, chart, bounding, yAxis }) => {
    const color = guideColor(chart)
    guide(ctx, bounding, yAxis, 50, color, false)
    guide(ctx, bounding, yAxis, 70, color)
    guide(ctx, bounding, yAxis, 30, color)
    return false
  }
}

export default rsx
