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

import { adaptiveBp, adaptiveBpCube } from './adaptivebandpass'
import adaptiveRsi from './adaptiversi'
import atr from './atr'
import bandPass from './bandpass'
import bandPassJ, { bandPassJRaw } from './bandpassj'
import bandStop from './bandstop'
import chandelier from './chandelier'
import corrTrend from './corrtrend'
import doda from './doda'
import haSmoothed from './hasmoothed'
import { hwc, hwcPct, hwma } from './holtwinters'
import ichimoku from './ichimoku'
import isCalc from './iscalc'
import kalman from './kalman'
import keltner from './keltner'
import kst from './kst'
import linReg from './linreg'
import macdBb from './macdbb'
import macdext from './macdext'
import metro from './metro'
import oscar from './oscar'
import prc from './prc'
import ptl from './ptl'
import rsx from './rsx'
import smi from './smi'
import stcNlma from './stcnlma'
import swamiSwing from './swami'
import tcf from './tcf'
import { micd, rccd } from './tdx'
import tmo from './tmo'
import trendAkkam from './trendakkam'
import trendilo from './trendilo'
import truncBp from './truncbp'
import ttf from './ttf'
import turtle from './turtle'
import voss from './voss'
import vpPoc from './vppoc'
import vwmacd from './vwmacd'

// The No Nonsense Forex shortlist's indicators (README.md in this directory): MQL / Pine
// indicators the NNFX discovery ranked well, the library indicators its systems use (Keltner,
// RSX, SMI, the regression intercept, ATR), and the indicators of the windicators scan's top
// systems (Holt-Winters, Kalman, MACDEXT, KST, TCF, VW-MACD, jesse's band-pass, IS Calculation,
// the Turtle channel, the Perfect Trend Line, the Voss filter, the volume profile), and since
// 2026-10-15 the indicators the scan ranked best once windicators round 3 was added (its 1D C1 top
// 20, and its best systems' band-stop baseline and polynomial-regression C2), computed in the
// browser from the bars the pane holds.
export const nnfxPriceIndicators = [
  haSmoothed, chandelier, trendAkkam, keltner, linReg, hwma, hwc, kalman, turtle, ptl, vpPoc, bandStop, prc, ichimoku
]
export const nnfxSubIndicators = [
  doda, bandPass, corrTrend, oscar, ttf, rsx, smi, atr, hwcPct, macdext, kst, tcf, vwmacd, bandPassJ, bandPassJRaw, isCalc, voss,
  swamiSwing, truncBp, adaptiveBp, adaptiveBpCube, adaptiveRsi, micd, rccd, macdBb, tmo, trendilo, stcNlma, metro
]

export default [...nnfxPriceIndicators, ...nnfxSubIndicators]
