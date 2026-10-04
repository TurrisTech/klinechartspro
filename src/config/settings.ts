/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 * http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific locale governing permissions and
 * limitations under the License.
 */

import i18n from '../i18n'

/** One row of the settings dialog: a style the chart draws by, and how it is picked. */
export interface SettingOption {
  /** The dotted path into klinecharts' `Styles`, except the two `yAxis.` ones -- those are
   * taken through `overrideYAxis` instead (see STYLE_SETTING_KEYS). */
  key: string
  text: string
  component: 'select' | 'switch'
  dataSource?: Array<{ key: string; text: string }>
}

export function getOptions (locale: string): SettingOption[] {
  return [
    {
      key: 'candle.type',
      text: i18n('candle_type', locale),
      component: 'select',
      dataSource: [
        { key: 'candle_solid', text: i18n('candle_solid', locale) },
        { key: 'candle_stroke', text: i18n('candle_stroke', locale) },
        { key: 'candle_up_stroke', text: i18n('candle_up_stroke', locale) },
        { key: 'candle_down_stroke', text: i18n('candle_down_stroke', locale) },
        { key: 'ohlc', text: i18n('ohlc', locale) },
        { key: 'area', text: i18n('area', locale) }
      ]
    },
    {
      key: 'candle.priceMark.last.show',
      text: i18n('last_price_show', locale),
      component: 'switch'
    },
    {
      key: 'candle.priceMark.high.show',
      text: i18n('high_price_show', locale),
      component: 'switch'
    },
    {
      key: 'candle.priceMark.low.show',
      text: i18n('low_price_show', locale),
      component: 'switch'
    },
    {
      key: 'indicator.lastValueMark.show',
      text: i18n('indicator_last_value_show', locale),
      component: 'switch'
    },
    {
      key: 'yAxis.type',
      text: i18n('price_axis_type', locale),
      component: 'select',
      dataSource: [
        { key: 'normal', text: i18n('normal', locale) },
        { key: 'percentage', text: i18n('percentage', locale) },
        { key: 'log', text: i18n('log', locale) }
      ],
    },
    {
      key: 'yAxis.reverse',
      text: i18n('reverse_coordinate', locale),
      component: 'switch',
    },
    {
      key: 'grid.show',
      text: i18n('grid_show', locale),
      component: 'switch',
    }
  ]
}

// Locale-independent: only `text` is translated, and nothing below reads it.
const STYLE_OPTIONS = getOptions('en-US').filter((option) => !option.key.startsWith('yAxis.'))

/** The dialog's style paths -- every option except its two `yAxis.` ones, which klinecharts
 * takes through `overrideYAxis` rather than `setStyles` and which ride in
 * `PaneViewState.yAxis`. The one list both a pane's record of these (`PaneOptions.styleOverrides`)
 * and the dialog's "Restore defaults" are keyed by, so a seventh option needs no change
 * anywhere else. */
export const STYLE_SETTING_KEYS: readonly string[] = STYLE_OPTIONS.map((option) => option.key)

/** `value` as the dialog itself would have written it for `key`, or undefined when `key` is
 * not one of its style fields or `value` is not one of its answers -- a switch's boolean, or
 * one of a select's own options.
 *
 * Every stored `styleOverrides` passes through here on its way to a pane, because a pane's
 * settings outlive the code that wrote them: a path this dialog no longer offers, or a value
 * it cannot produce, would otherwise be merged into klinecharts' style tree on every mount
 * for as long as the document lasts -- and nothing in the dialog could then clear it. */
export function settingStyleValue(key: string, value: unknown): string | boolean | undefined {
  const option = STYLE_OPTIONS.find((item) => item.key === key)
  if (!option) return undefined
  if (option.component === 'switch') return typeof value === 'boolean' ? value : undefined
  return option.dataSource?.some((item) => item.key === value) ? (value as string) : undefined
}
