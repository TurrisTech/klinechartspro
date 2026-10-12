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
import { signLineStyle } from './paint'

/**
 * KALMAN -- a constant-velocity Kalman filter's price forecast on the price pane, as ta4j's
 * KinematicKalmanFilterIndicator and KinematicKalmanPriceForecastIndicator compute it (windicators
 * `kalman_filter_constant_velocity`, the code the windicators NNFX scan ran): the baseline of the
 * scan's system 5, at process noise 0.0001, measurement noise 0.000804, horizon 6.
 *
 * Parameters: [q, r, horizon], default [0.0001, 0.000804, 6] (ta4j's own: 0.0001, 0.001, 1).
 *
 * The state is the price's position and velocity. Each bar predicts position + velocity, with
 * process noise q added to the covariance, and corrects toward the close by the Kalman gain, the
 * close's own noise being r. The first close starts it (velocity 0, covariance I + Q corrected by
 * that close). The line is the forecast `horizon` bars ahead, position + velocity x horizon:
 * a baseline that leads the filtered price by the trend.
 *
 * q and r are in price units squared and the scan used the same numbers on every pair, so the
 * filter follows a JPY cross (price ~150) far more tightly than EURUSD (~1.1). That is what was
 * tested.
 *
 * The line takes the up colour while the close is above it and the down colour while below: the
 * baseline side. Locked to windicators by fixtures/wscan_parity.json.
 */

export interface Kalman {
  [key: string]: number | undefined
  mean?: number
  std?: number
  position?: number
  velocity?: number
  side?: number
}

function usable(pos: number, vel: number, pp: number, pv: number, vv: number): boolean {
  if (!(Number.isFinite(pos) && Number.isFinite(vel) && Number.isFinite(pp) && !(pp < 0) && Number.isFinite(pv) &&
      Number.isFinite(vv) && !(vv < 0))) return false
  return pp * vv >= pv * pv
}

export function kalmanRows(bars: readonly KLineData[], calcParams: readonly unknown[]): Kalman[] {
  const q = realParam(calcParams[0], 0.0001, 1e-15)
  const r = realParam(calcParams[1], 0.000804, 1e-15)
  const h = Math.min(100000, countParam(calcParams[2], 6, 1))
  let pos = 0
  let vel = 0
  let pp = 1
  let pv = 0
  let vv = 1
  let valid = false
  return bars.map((bar) => {
    const y = bar.close
    if (!Number.isFinite(y)) return {}
    if (!valid) {
      const prior = 1 + q
      const gain = prior / (prior + r)
      pos = y
      vel = 0
      pp = (1 - gain) * prior
      pv = 0
      vv = prior
    } else {
      const predPos = pos + vel
      const predPp = pp + pv * 2 + vv + q
      const predPv = pv + vv
      const predVv = vv + q
      const innov = predPp + r
      const kPos = predPp / innov
      const kVel = predPv / innov
      const e = y - predPos
      const newPos = predPos + kPos * e
      const newVel = vel + kVel * e
      const omk = 1 - kPos
      const newPp = omk * omk * predPp + kPos * kPos * r
      const newPv = omk * (predPv - kVel * predPp) + kPos * kVel * r
      const newVv = kVel * kVel * predPp - kVel * predPv * 2 + predVv + kVel * kVel * r
      pos = newPos
      vel = newVel
      pp = newPp
      pv = newPv
      vv = newVv
    }
    valid = usable(pos, vel, pp, pv, vv)
    if (!valid) return {}
    const row: Kalman = { position: pos, velocity: vel }
    const mean = pos + vel * h
    const twoH = h * 2
    const propagated = pp + pv * twoH + vv * (h * h)
    const squareSum = ((h - 1) * h * (twoH - 1)) / 6
    const variance = propagated + q * (h + squareSum) + r
    if (Number.isFinite(mean) && Number.isFinite(variance) && !(variance < 0)) {
      row.mean = value(mean)
      row.std = variance === 0 ? 0 : Math.sqrt(variance)
      row.side = Math.sign(y - mean)
    }
    return row
  })
}

const kalman: IndicatorTemplate<Kalman, number> = {
  name: 'KALMAN',
  shortName: 'Kalman',
  series: 'price',
  calcParams: [0.0001, 0.000804, 6],
  precision: 5,
  figures: [
    {
      key: 'mean',
      title: 'Forecast: ',
      type: 'line',
      styles: ({ data, indicator, defaultStyles }) => ({ ...signLineStyle(data.current?.side, indicator, defaultStyles), size: 2 })
    }
  ],
  calc: (dataList: KLineData[], indicator) => kalmanRows(dataList, indicator.calcParams)
}

export default kalman
