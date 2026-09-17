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

import type { IndicatorCreateTooltipDataSourceCallback } from 'klinecharts'

import sessions from './sessions'
import swing from './swing'
import wma from './wma'

// Indicator templates this library adds to klinecharts' built-ins, computed in the
// browser from the bars the chart already holds -- unlike the app-registered `S:` ones
// (client/indicators), whose values come from the server. Registered in src/index.ts;
// their settings live in src/config/indicators.ts and their picker entries in
// ChartPro.svelte's `mainIndicatorNames` / `subIndicatorNames`.
const indicators = [wma, swing, sessions]

// The tooltip data source a template of this library declares, by name -- for ChartPane,
// which installs its own on every indicator it creates (to pick the legend's icons) and
// would otherwise discard the template's. Null for a template that has none.
export function templateTooltipDataSource(name: string): IndicatorCreateTooltipDataSourceCallback<unknown> | null {
  const template = indicators.find((t) => t.name === name)
  return (template?.createTooltipDataSource as IndicatorCreateTooltipDataSourceCallback<unknown> | null | undefined) ?? null
}

export default indicators
