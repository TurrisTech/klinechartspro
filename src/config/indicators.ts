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

export interface IndicatorParamSetting {
  /** i18n key of the parameter's label -- or, for an app-registered indicator, the label
   * itself (i18n() passes an unknown key through unchanged). */
  paramNameKey: string
  precision: number
  min: number
  default?: number
  max?: number
}

// Settings for indicators an app registers at runtime (klinecharts' registerIndicator plus
// ChartProOptions.indicatorGroups), keyed by template name. The built-in table below stays
// static; `indicatorSettingsFor` consults both.
const registered: Record<string, IndicatorParamSetting[]> = {}

export function registerIndicatorSettings(name: string, settings: IndicatorParamSetting[]): void {
  registered[name] = settings
}

export function indicatorSettingsFor(name: string): IndicatorParamSetting[] {
  return registered[name] ?? (builtin as Record<string, IndicatorParamSetting[]>)[name] ?? []
}

const builtin = {
  AO: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 5 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 34 }
  ],
  BIAS: [
    { paramNameKey: 'BIAS1', precision: 0, min: 1, styleKey: 'lines[0].color' },
    { paramNameKey: 'BIAS2', precision: 0, min: 1, styleKey: 'lines[1].color' },
    { paramNameKey: 'BIAS3', precision: 0, min: 1, styleKey: 'lines[2].color' },
    { paramNameKey: 'BIAS4', precision: 0, min: 1, styleKey: 'lines[3].color' },
    { paramNameKey: 'BIAS5', precision: 0, min: 1, styleKey: 'lines[4].color' }
  ],
  BOLL: [
    { paramNameKey: 'period', precision: 0, min: 1, default: 20 },
    { paramNameKey: 'standard_deviation', precision: 2, min: 1, default: 2 }
  ],
  BRAR: [
    { paramNameKey: 'period', precision: 0, min: 1, default: 26 }
  ],
  BBI: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 3 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 6 },
    { paramNameKey: 'params_3', precision: 0, min: 1, default: 12 },
    { paramNameKey: 'params_4', precision: 0, min: 1, default: 24 }
  ],
  CCI: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 20 }
  ],
  CR: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 26 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 10 },
    { paramNameKey: 'params_3', precision: 0, min: 1, default: 20 },
    { paramNameKey: 'params_4', precision: 0, min: 1, default: 40 },
    { paramNameKey: 'params_5', precision: 0, min: 1, default: 60 }
  ],
  DMA: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 10 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 50 },
    { paramNameKey: 'params_3', precision: 0, min: 1, default: 10 }
  ],
  DMI: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 14 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 6 }
  ],
  EMV: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 14 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 9 }
  ],
  EMA: [
    { paramNameKey: 'EMA1', precision: 0, min: 1, styleKey: 'lines[0].color' },
    { paramNameKey: 'EMA2', precision: 0, min: 1, styleKey: 'lines[1].color' },
    { paramNameKey: 'EMA3', precision: 0, min: 1, styleKey: 'lines[2].color' },
    { paramNameKey: 'EMA4', precision: 0, min: 1, styleKey: 'lines[3].color' },
    { paramNameKey: 'EMA5', precision: 0, min: 1, styleKey: 'lines[4].color' }
  ],
  MTM: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 12 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 6 }
  ],
  MA: [
    { paramNameKey: 'MA1', precision: 0, min: 1, styleKey: 'lines[0].color' },
    { paramNameKey: 'MA2', precision: 0, min: 1, styleKey: 'lines[1].color' },
    { paramNameKey: 'MA3', precision: 0, min: 1, styleKey: 'lines[2].color' },
    { paramNameKey: 'MA4', precision: 0, min: 1, styleKey: 'lines[3].color' },
    { paramNameKey: 'MA5', precision: 0, min: 1, styleKey: 'lines[4].color' },
  ],
  MACD: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 12 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 26 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 9 }
  ],
  OBV: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 30 }
  ],
  PVT: [],
  PSY: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 12 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 6 }
  ],
  ROC: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 12 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 6 }
  ],
  RSI: [
    { paramNameKey: 'RSI1', precision: 0, min: 1, styleKey: 'lines[0].color' },
    { paramNameKey: 'RSI2', precision: 0, min: 1, styleKey: 'lines[1].color' },
    { paramNameKey: 'RSI3', precision: 0, min: 1, styleKey: 'lines[2].color' },
    { paramNameKey: 'RSI4', precision: 0, min: 1, styleKey: 'lines[3].color' },
    { paramNameKey: 'RSI5', precision: 0, min: 1, styleKey: 'lines[4].color' }
  ],
  SMA: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 12 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 2 }
  ],
  KDJ: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 9 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 3 },
    { paramNameKey: 'params_3', precision: 0, min: 1, default: 3 }
  ],
  SAR: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 2 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 2 },
    { paramNameKey: 'params_3', precision: 0, min: 1, default: 20 }
  ],
  // SESSIONS is this library's own template (src/indicators/sessions.ts).
  SESSIONS: [
    { paramNameKey: 'sessions_fill', precision: 0, min: 0, max: 100, default: 8 },
    { paramNameKey: 'sessions_ribbon', precision: 0, min: 0, max: 1, default: 1 },
    { paramNameKey: 'sessions_week', precision: 0, min: 0, max: 1, default: 1 }
  ],
  // SSL is this library's own template (src/indicators/ssl.ts).
  SSL: [
    { paramNameKey: 'ssl_length', precision: 0, min: 1, default: 15 },
    { paramNameKey: 'ssl_ma', precision: 0, min: 0, max: 5, default: 0 },
    { paramNameKey: 'ssl_shift', precision: 0, min: 0, default: 0 },
    { paramNameKey: 'ssl_signals', precision: 0, min: 0, max: 1, default: 1 },
    { paramNameKey: 'ssl_fill', precision: 0, min: 0, max: 100, default: 12 }
  ],
  // SWING is this library's own template (src/indicators/swing.ts).
  SWING: [
    { paramNameKey: 'swing_left_bars', precision: 0, min: 1, default: 10 },
    { paramNameKey: 'swing_right_bars', precision: 0, min: 1, default: 10 },
    { paramNameKey: 'swing_marker', precision: 0, min: 0, max: 2, default: 0 }
  ],
  // The NNFX shortlist's templates (src/indicators/nnfx/, whose README.md gives each default's
  // provenance). The order is each template's calcParams order.
  DODA_STOCH: [
    { paramNameKey: 'doda_slw', precision: 0, min: 1, default: 12 },
    { paramNameKey: 'doda_pds', precision: 0, min: 1, default: 20 },
    { paramNameKey: 'doda_signal', precision: 0, min: 1, default: 14 }
  ],
  BANDPASS: [
    { paramNameKey: 'bandpass_period', precision: 0, min: 2, default: 50 },
    { paramNameKey: 'bandpass_delta', precision: 2, min: 0.01, max: 1, default: 0.1 },
    { paramNameKey: 'mladen_price', precision: 0, min: 0, max: 32, default: 4 }
  ],
  CORR_TREND: [
    { paramNameKey: 'corr_short', precision: 0, min: 2, default: 40 },
    { paramNameKey: 'corr_long', precision: 0, min: 2, default: 80 },
    { paramNameKey: 'mladen_price', precision: 0, min: 0, max: 32, default: 15 }
  ],
  HA_SMOOTHED: [
    { paramNameKey: 'has_period', precision: 0, min: 1, default: 6 },
    { paramNameKey: 'has_method', precision: 0, min: 0, max: 3, default: 2 },
    { paramNameKey: 'has_period2', precision: 0, min: 1, default: 2 },
    { paramNameKey: 'has_method2', precision: 0, min: 0, max: 3, default: 3 },
    { paramNameKey: 'nnfx_opacity', precision: 0, min: 0, max: 100, default: 40 }
  ],
  OSCAR: [
    { paramNameKey: 'oscar_length', precision: 0, min: 2, default: 20 },
    { paramNameKey: 'oscar_smoothing', precision: 0, min: 0, max: 4, default: 0 }
  ],
  TTF: [
    { paramNameKey: 'ttf_period', precision: 0, min: 1, default: 45 },
    { paramNameKey: 'ttf_t3', precision: 0, min: 0, default: 0 },
    { paramNameKey: 'ttf_b', precision: 2, min: 0, max: 1, default: 0.7 }
  ],
  CHANDELIER: [
    { paramNameKey: 'chandelier_range', precision: 0, min: 1, default: 6 },
    { paramNameKey: 'chandelier_atr', precision: 0, min: 1, default: 7 },
    { paramNameKey: 'nnfx_atr_mult', precision: 2, min: 0, default: 2.5 },
    { paramNameKey: 'chandelier_shift', precision: 0, min: 0, default: 0 },
    { paramNameKey: 'nnfx_arrows', precision: 0, min: 0, max: 1, default: 1 }
  ],
  TREND_AKKAM: [
    { paramNameKey: 'akkam_atr', precision: 0, min: 1, default: 150 },
    { paramNameKey: 'akkam_factor', precision: 2, min: 0, default: 6 },
    { paramNameKey: 'nnfx_arrows', precision: 0, min: 0, max: 1, default: 1 }
  ],
  // The library indicators the NNFX systems use (src/indicators/nnfx/; README.md there).
  KELTNER: [
    { paramNameKey: 'keltner_window', precision: 0, min: 1, default: 20 },
    { paramNameKey: 'keltner_version', precision: 0, min: 0, max: 1, default: 0 },
    { paramNameKey: 'keltner_atr', precision: 0, min: 1, default: 10 },
    { paramNameKey: 'keltner_mult', precision: 2, min: 0, default: 2 },
    { paramNameKey: 'nnfx_arrows', precision: 0, min: 0, max: 1, default: 1 }
  ],
  RSX: [
    { paramNameKey: 'rsx_length', precision: 0, min: 2, default: 21 }
  ],
  SMI: [
    { paramNameKey: 'smi_period', precision: 0, min: 1, default: 39 },
    { paramNameKey: 'smi_fast', precision: 0, min: 1, default: 6 },
    { paramNameKey: 'smi_slow', precision: 0, min: 1, default: 75 },
    { paramNameKey: 'smi_signal', precision: 0, min: 1, default: 27 },
    { paramNameKey: 'smi_ma', precision: 0, min: 1, default: 3 }
  ],
  LINREG: [
    { paramNameKey: 'linreg_period', precision: 0, min: 2, default: 28 }
  ],
  ATR: [
    { paramNameKey: 'atr_period', precision: 0, min: 1, default: 14 },
    { paramNameKey: 'atr_method', precision: 0, min: 0, max: 1, default: 0 }
  ],
  TRIX: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 12 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 9 }
  ],
  VOL: [
    { paramNameKey: 'MA1', precision: 0, min: 1, styleKey: 'lines[0].color' },
    { paramNameKey: 'MA2', precision: 0, min: 1, styleKey: 'lines[1].color' },
    { paramNameKey: 'MA3', precision: 0, min: 1, styleKey: 'lines[2].color' },
    { paramNameKey: 'MA4', precision: 0, min: 1, styleKey: 'lines[3].color' },
    { paramNameKey: 'MA5', precision: 0, min: 1, styleKey: 'lines[4].color' },
  ],
  VR: [
    { paramNameKey: 'params_1', precision: 0, min: 1, default: 26 },
    { paramNameKey: 'params_2', precision: 0, min: 1, default: 6 }
  ],
  // WMA is this library's own template (src/indicators/wma.ts), not a klinecharts
  // built-in, but it is registered at import time like one and takes the same settings.
  WMA: [
    { paramNameKey: 'WMA1', precision: 0, min: 1, styleKey: 'lines[0].color' },
    { paramNameKey: 'WMA2', precision: 0, min: 1, styleKey: 'lines[1].color' },
    { paramNameKey: 'WMA3', precision: 0, min: 1, styleKey: 'lines[2].color' },
    { paramNameKey: 'WMA4', precision: 0, min: 1, styleKey: 'lines[3].color' },
    { paramNameKey: 'WMA5', precision: 0, min: 1, styleKey: 'lines[4].color' }
  ],
  WR: [
    { paramNameKey: 'WR1', precision: 0, min: 1, styleKey: 'lines[0].color' },
    { paramNameKey: 'WR2', precision: 0, min: 1, styleKey: 'lines[1].color' },
    { paramNameKey: 'WR3', precision: 0, min: 1, styleKey: 'lines[2].color' },
    { paramNameKey: 'WR4', precision: 0, min: 1, styleKey: 'lines[3].color' },
    { paramNameKey: 'WR5', precision: 0, min: 1, styleKey: 'lines[4].color' },
  ]
}

export default builtin
