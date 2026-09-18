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
