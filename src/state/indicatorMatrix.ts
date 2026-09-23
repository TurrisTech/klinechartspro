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

import type { IndicatorSettingField, IndicatorSettingFieldCondition } from '../types'

// The indicator manager's model: which indicators are in use anywhere on the wall, one row
// each, against every visible pane as a column. Kept out of the component so the row rules
// are testable without mounting a chart.

/** One matrix row. A template name alone is not a row: MA, EMA, BOLL and friends can sit on
 * the price pane OR in a sub-pane of their own, and a pane may carry both at once. */
export interface IndicatorRow {
  name: string
  main: boolean
}

/** What a column needs from a pane -- PaneState satisfies it. */
export interface IndicatorHolder {
  mainIndicators: readonly string[]
  subIndicatorNames: readonly string[]
}

export function rowKey(row: IndicatorRow): string {
  return `${row.main ? 'main' : 'sub'}:${row.name}`
}

export function holds(pane: IndicatorHolder, row: IndicatorRow): boolean {
  return (row.main ? pane.mainIndicators : pane.subIndicatorNames).includes(row.name)
}

/** Every indicator on any of `panes`, price-pane rows first, then sub-pane rows, each in order
 * of first appearance walking the panes left to right.
 *
 * `retained` are rows the manager is already showing. They stay even once no pane holds them:
 * unticking the last cell of a row must not make the row vanish from under the pointer, or
 * the change could not be undone from the same dialog. The caller resets it on every open. */
export function usedIndicators(
  panes: readonly IndicatorHolder[],
  retained: readonly IndicatorRow[] = []
): IndicatorRow[] {
  const seen = new Map<string, IndicatorRow>()
  for (const row of retained) seen.set(rowKey(row), row)
  for (const pane of panes) {
    for (const name of pane.mainIndicators) {
      const row = { name, main: true }
      if (!seen.has(rowKey(row))) seen.set(rowKey(row), row)
    }
    for (const name of pane.subIndicatorNames) {
      const row = { name, main: false }
      if (!seen.has(rowKey(row))) seen.set(rowKey(row), row)
    }
  }
  const rows = [...seen.values()]
  return [...rows.filter((row) => row.main), ...rows.filter((row) => !row.main)]
}

/** A row's summary across the columns: on every pane, on none, or on some. */
export function coverage(
  panes: readonly IndicatorHolder[],
  row: IndicatorRow
): 'all' | 'none' | 'some' {
  const count = panes.filter((pane) => holds(pane, row)).length
  if (count === 0) return 'none'
  return count === panes.length ? 'all' : 'some'
}

// -- Parameters -------------------------------------------------------------------------------
// An expanded row edits the indicator's calcParams on each pane, one line per parameter the
// settings table describes (config/indicators.ts). What follows turns the cells as typed into
// the params a pane is given, with the same reading of an empty cell as the settings dialog.

/** One parameter as typed: a number, or '' for a cleared (or unparseable) input. */
export type ParamInput = number | ''

/** Why a set of typed parameters is refused -- see resolveParams. */
export type ParamProblem =
  | { kind: 'below'; index: number; bound: number }
  | { kind: 'above'; index: number; bound: number }
  | { kind: 'fraction'; index: number }
  | { kind: 'empty' }

/** What resolveParams needs of a parameter's setting -- IndicatorParamSetting satisfies it. */
export interface ParamBounds {
  precision: number
  min: number
  max?: number
  default?: number
}

/** A pane's params with one of them replaced by what was typed. `current` is the indicator's
 * live calcParams; a slot past its end (MA5 on a four-line MA) is padded as empty. */
export function withParam(current: readonly unknown[], index: number, value: ParamInput): ParamInput[] {
  const inputs: ParamInput[] = []
  for (let i = 0; i < Math.max(current.length, index + 1); i++) {
    const held = current[i]
    inputs.push(i === index ? value : typeof held === 'number' && Number.isFinite(held) ? held : '')
  }
  return inputs
}

/** The calcParams a row of typed parameters means, or why it means none.
 *
 * An empty cell takes the setting's default, as the settings dialog does. A setting WITHOUT a
 * default is an optional line (MA1..MA5 and friends): leaving it empty leaves that line out, so
 * the later ones close up rather than a hole reaching the template -- which would draw a line
 * titled "MAundefined". A slot the settings do not describe is passed through unchecked. */
export function resolveParams(
  inputs: readonly ParamInput[],
  settings: readonly ParamBounds[]
): { params: number[] } | { problem: ParamProblem } {
  const params: number[] = []
  for (let index = 0; index < Math.max(inputs.length, settings.length); index++) {
    const setting = settings[index]
    const typed = inputs[index]
    const value = typed === '' || typed === undefined ? setting?.default : typed
    if (value === undefined) continue
    if (setting) {
      if (value < setting.min) return { problem: { kind: 'below', index, bound: setting.min } }
      if (setting.max !== undefined && value > setting.max) {
        return { problem: { kind: 'above', index, bound: setting.max } }
      }
      if (setting.precision === 0 && !Number.isInteger(value)) return { problem: { kind: 'fraction', index } }
    }
    params.push(value)
  }
  // Every optional line cleared would leave a template with nothing to draw under its legend.
  if (params.length === 0 && settings.length > 0) return { problem: { kind: 'empty' } }
  return { params }
}

/** The All column's cell for one parameter: the value every holding pane agrees on, '' where
 * none of them sets it (or none holds the row), 'mixed' where they differ. `held` is each
 * pane's live calcParams, null for a pane that does not hold the row. */
export function sharedParam(held: ReadonlyArray<readonly unknown[] | null>, index: number): ParamInput | 'mixed' {
  let shared: ParamInput | undefined
  for (const params of held) {
    if (!params) continue
    const value = params[index]
    const input: ParamInput = typeof value === 'number' && Number.isFinite(value) ? value : ''
    if (shared === undefined) shared = input
    else if (shared !== input) return 'mixed'
  }
  return shared ?? ''
}

// -- An app's own settings ---------------------------------------------------------------------
// An indicator whose settings live in the app's per-pane config rather than in calcParams
// (IndicatorSettingsModel) expands to that config's fields instead: one line per field, a
// heading per group, the pane's value under each pane's column.

/** A config's value at a field's dotted key; a numeric segment indexes an array. */
export function valueAt(config: object | null, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[part]
  }, config)
}

/** What a typed number becomes: clamped to the field's bounds, and whole where it must be. The
 * app's own panel settles a number the same way, so both write what the indicator draws. */
export function settleSetting(field: { min: number; max: number; integer?: boolean }, value: number): number {
  const clamped = Math.min(field.max, Math.max(field.min, value))
  return field.integer ? Math.round(clamped) : clamped
}

type ValueField = Exclude<IndicatorSettingField, { kind: 'group' }>

/** One line of an expanded row. `groups` are the ids of the groups it sits in, outermost first,
 * so a line shows only while each of them is open; `when` gathers its own condition and every
 * enclosing group's, since a field applies to a pane only where all of them hold. */
export type SettingLine =
  | { kind: 'group'; id: string; label: string; depth: number; groups: string[]; when: IndicatorSettingFieldCondition[] }
  | { kind: 'field'; field: ValueField; depth: number; groups: string[]; when: IndicatorSettingFieldCondition[] }

/** The field tree flattened into table lines, in order. A group's id is its index path ("2",
 * "2.0"), stable for as long as the app's field list is. */
export function settingLines(
  fields: readonly IndicatorSettingField[],
  groups: readonly string[] = [],
  when: readonly IndicatorSettingFieldCondition[] = []
): SettingLine[] {
  return fields.flatMap((field, index): SettingLine[] => {
    const conditions = field.when ? [...when, field.when] : [...when]
    if (field.kind !== 'group') return [{ kind: 'field', field, depth: groups.length, groups: [...groups], when: conditions }]
    const id = [...groups.slice(-1), String(index)].join('.')
    const heading: SettingLine = { kind: 'group', id, label: field.label, depth: groups.length, groups: [...groups], when: conditions }
    return [heading, ...settingLines(field.fields, [...groups, id], conditions)]
  })
}

/** Whether a line applies to a pane's config: it has one, and every condition on the line holds. */
export function lineApplies(line: { when: readonly IndicatorSettingFieldCondition[] }, config: object | null): boolean {
  return config !== null && line.when.every((condition) => condition.is.includes(valueAt(config, condition.key)))
}

/** The All column's value for one field: what every pane holding the row agrees on, 'mixed'
 * where they differ, null where no pane holds it. `configs` is each pane's, null for a pane
 * without the row. */
export function sharedSetting(configs: ReadonlyArray<object | null>, key: string): { value: unknown } | 'mixed' | null {
  let shared: { value: unknown } | null = null
  for (const config of configs) {
    if (!config) continue
    const value = valueAt(config, key)
    if (!shared) shared = { value }
    else if (shared.value !== value) return 'mixed'
  }
  return shared
}
