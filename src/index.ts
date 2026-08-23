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

import { registerIndicator, registerOverlay } from 'klinecharts'

import overlays from './extension'
import indicators from './indicators'

import './app.css'

overlays.forEach(o => { registerOverlay(o) })
indicators.forEach(i => { registerIndicator(i) })

export { default as DefaultDatafeed } from './DefaultDatafeed'
export { default as KLineChartPro } from './KLineChartPro'
export { load as loadLocales } from './i18n'

export type {
  ChartPro,
  ChartProOptions,
  ChartProPane,
  Datafeed,
  DatafeedFactory,
  DatafeedSubscribeCallback,
  IndicatorGroup,
  IndicatorSettingsHandler,
  PaneOptions,
  PaneSnapshot,
  Period,
  SymbolInfo
} from './types'
export type { LayoutPreset } from './config/layouts'
export { getLayouts as getPaneLayouts, MAX_PANES } from './config/layouts'
export { registerIndicatorSettings, type IndicatorParamSetting } from './config/indicators'
