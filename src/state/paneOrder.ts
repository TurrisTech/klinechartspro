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

// The two orders a wall can be rearranged in, kept out of the components so the rules are
// testable without mounting a chart.
//
// 1. Inside one wall pane, the vertical order of its CHART panes: the price pane and one
//    sub-pane per sub-indicator. It is stored as two facts rather than one list -- the
//    sub-indicator names in top-to-bottom order (`subIndicatorNames`, which already existed
//    and already meant "in the order they were added") and how many of them sit ABOVE the
//    price pane (`subIndicatorsAbove`). A reader that predates the second fact still gets the
//    sub-panes in the right order, merely all below the price, which is where they always were.
//
// 2. Across the wall, which pane sits in which cell. A pane moved to another position takes
//    it and the panes in between close up -- `moveOrder`. Panes keep their ids and their
//    charts; only their positions change, and everything an app keeps by pane POSITION (the plugins'
//    per-pane settings) has to move with them -- `permuteByIndex`.

/** One chart pane in a wall pane's vertical stack: a sub-indicator's template name, or null
 * for the price pane. Null rather than a sentinel string, which a template could be named. */
export type ChartPaneSlot = string | null

/** Where the price pane may sit: anywhere from above every sub-pane (0) to below all of them.
 * A stored value outside that, or not a whole number, reads as the default -- the top. */
export function clampAbove(above: number, subPaneCount: number): number {
  if (!Number.isInteger(above) || above < 0) return 0
  return Math.min(above, subPaneCount)
}

/** The wall pane's chart panes, top to bottom. */
export function chartPaneStack(subIndicators: readonly string[], above: number): ChartPaneSlot[] {
  const at = clampAbove(above, subIndicators.length)
  return [...subIndicators.slice(0, at), null, ...subIndicators.slice(at)]
}

export interface SubPaneOrder {
  subIndicators: string[]
  above: number
}

function fromStack(stack: readonly ChartPaneSlot[]): SubPaneOrder {
  return {
    subIndicators: stack.filter((slot): slot is string => slot !== null),
    above: Math.max(stack.indexOf(null), 0)
  }
}

/** Which ways the sub-pane holding `name` can move: never past the top or the bottom of the
 * stack. Both false for a name the pane does not hold. */
export function subPaneMoves(
  subIndicators: readonly string[],
  above: number,
  name: string
): { up: boolean; down: boolean } {
  const stack = chartPaneStack(subIndicators, above)
  const at = stack.indexOf(name)
  if (at < 0) return { up: false, down: false }
  return { up: at > 0, down: at < stack.length - 1 }
}

/** The order after moving the sub-pane holding `name` one place up (-1) or down (+1). Moving
 * past the price pane is what puts a sub-pane above the price, or brings it back below. Null
 * when the pane does not hold `name` or it is already at that end. */
export function moveSubPane(
  subIndicators: readonly string[],
  above: number,
  name: string,
  step: -1 | 1
): SubPaneOrder | null {
  const stack = chartPaneStack(subIndicators, above)
  const from = stack.indexOf(name)
  const to = from + step
  if (from < 0 || to < 0 || to >= stack.length) return null
  ;[stack[from], stack[to]] = [stack[to], stack[from]]
  return fromStack(stack)
}

/** The order once the sub-pane holding `name` is gone: the panes around it close up, and the
 * price pane keeps its neighbours. */
export function withoutSubPane(
  subIndicators: readonly string[],
  above: number,
  name: string
): SubPaneOrder {
  return fromStack(chartPaneStack(subIndicators, above).filter((slot) => slot !== name))
}

/** The wall order after moving the pane at position `from` to position `to`, as `order[newIndex]
 * = oldIndex` over the first `count` positions -- the shape `permuteByIndex` takes. The panes
 * in between close up behind it rather than trading places with it: moving the second of six
 * last gives 1, 3, 4, 5, 6, 2, not 1, 6, 3, 4, 5, 2. */
export function moveOrder(count: number, from: number, to: number): number[] {
  const order = Array.from({ length: count }, (_, index) => index)
  order.splice(to, 0, ...order.splice(from, 1))
  return order
}

/** Re-keys a by-position record after the wall's panes moved: what was kept under `order[i]`
 * is now kept under `i`. A position the order does not cover (a pane the layout hides) keeps
 * its entry, and a position whose new pane had nothing keeps nothing -- an entry is never
 * left behind under a position whose pane has moved away. */
export function permuteByIndex<T>(byIndex: Readonly<Record<number, T>>, order: readonly number[]): Record<number, T> {
  const out: Record<number, T> = {}
  for (const [key, value] of Object.entries(byIndex)) {
    if (Number(key) >= order.length) out[Number(key)] = value
  }
  order.forEach((from, to) => {
    if (from in byIndex) out[to] = byIndex[from]
  })
  return out
}
