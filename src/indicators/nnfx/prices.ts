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
 * mladen's price list -- the `enPrices` input of his MT4 indicators (the band-pass filter, and the
 * MT4 build of the Correlation Trend), numbered as there:
 *
 *    0 close, 1 open, 2 high, 3 low, 4 median, 5 typical, 6 weighted (h + l + 2c) / 4,
 *    7 average (h + l + o + c) / 4, 8 median body (o + c) / 2, 9 trend biased, 10 trend biased
 *    (extreme);
 *   11..21 the same eleven of Heiken Ashi candles (11 HA close, 12 HA open, 13 HA high, 14 HA low,
 *    15 HA median, ... 21 HA trend biased (extreme));
 *   22..32 the same again of his "better formula" Heiken Ashi, whose close is
 *    (o + c)/2 + (c - o)/(h - l) * |c - o|/2.
 *
 * 0..6 are also MT4's own PRICE_* codes. Transcribed from his getPrice(): a Heiken Ashi open is the
 * previous HA candle's (open + close) / 2, the first one (open + close) / 2 of its own bar.
 */
export const MLADEN_PRICE_MAX = 32

export function mladenPrice(bars: readonly KLineData[], code: number): number[] {
  let haOpenPrev = 0
  let haClosePrev = 0
  return bars.map(({ open: o, high: h, low: l, close: c }, i) => {
    if (code >= 11) {
      const better = code >= 22
      const hao = i > 0 ? (haOpenPrev + haClosePrev) / 2 : (o + c) / 2
      let hac = (o + h + l + c) / 4
      if (better) hac = h !== l ? (o + c) / 2 + ((c - o) / (h - l)) * Math.abs((c - o) / 2) : (o + c) / 2
      const hah = Math.max(h, Math.max(hao, hac))
      const hal = Math.min(l, Math.min(hao, hac))
      haOpenPrev = hao
      haClosePrev = hac
      switch (better ? code - 11 : code) {
        case 11:
          return hac
        case 12:
          return hao
        case 13:
          return hah
        case 14:
          return hal
        case 15:
          return (hah + hal) / 2
        case 16:
          return (hah + hal + hac) / 3
        case 17:
          return (hah + hal + hac + hac) / 4
        case 18:
          return (hah + hal + hac + hao) / 4
        case 19:
          return (hao + hac) / 2
        case 20:
          return hac > hao ? (hah + hac) / 2 : (hal + hac) / 2
        default:
          return hac > hao ? hah : hac < hao ? hal : hac
      }
    }
    switch (code) {
      case 1:
        return o
      case 2:
        return h
      case 3:
        return l
      case 4:
        return (h + l) / 2
      case 5:
        return (h + l + c) / 3
      case 6:
        return (h + l + c + c) / 4
      case 7:
        return (h + l + c + o) / 4
      case 8:
        return (o + c) / 2
      case 9:
        return c > o ? (h + c) / 2 : (l + c) / 2
      case 10:
        return c > o ? h : c < o ? l : c
      default:
        return c
    }
  })
}
