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

import type { Period, SymbolInfo } from '../types'

// "Is this pane already showing what the active one is?" -- the test the wall-wide symbol and
// timeframe switches gate their fan-out on (ChartPro.svelte). Object identity is not enough on
// its own: two panes hydrated from the same persisted document hold equal-but-distinct
// SymbolInfo/Period objects, and writing one over the other would tear every pane's data down
// and refetch it for no change the user asked for.

/** A symbol is its ticker AND its vendor: `exchange` is where a consuming app puts the latter
 * (the client folds wdashboard-server's vendor into it), so BTCUSD on two vendors must read as
 * two instruments rather than as one already-synced pane. */
export function sameSymbol(a: SymbolInfo | undefined, b: SymbolInfo | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.ticker === b.ticker && (a.exchange ?? '') === (b.exchange ?? '')
}

/** `text` is a period's identity everywhere else in this component (the rail's chips, the
 * dropdown's keys, the persisted document), so it is what a follow compares too. */
export function samePeriod(a: Period | undefined, b: Period | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.text === b.text
}
