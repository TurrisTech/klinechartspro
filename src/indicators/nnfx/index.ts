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

import atr from './atr'
import bandPass from './bandpass'
import chandelier from './chandelier'
import corrTrend from './corrtrend'
import doda from './doda'
import haSmoothed from './hasmoothed'
import keltner from './keltner'
import linReg from './linreg'
import oscar from './oscar'
import rsx from './rsx'
import smi from './smi'
import trendAkkam from './trendakkam'
import ttf from './ttf'

// The No Nonsense Forex shortlist's indicators (README.md in this directory): MQL / Pine
// indicators the NNFX discovery ranked well, and the library indicators its systems use (Keltner,
// RSX, SMI, the regression intercept, ATR), computed in the browser from the bars the pane holds.
export const nnfxPriceIndicators = [haSmoothed, chandelier, trendAkkam, keltner, linReg]
export const nnfxSubIndicators = [doda, bandPass, corrTrend, oscar, ttf, rsx, smi, atr]

export default [...nnfxPriceIndicators, ...nnfxSubIndicators]
