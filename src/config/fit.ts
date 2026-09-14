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

// How a wall's layout preset is actually drawn in the space the wall has right now.
//
// A preset is the user's choice of arrangement and is persisted as such; the screen it is
// shown on is not. A 12-pane wall picked on a desktop and opened on a phone would otherwise
// draw twelve 30px-wide charts. So the preset is drawn as declared while every cell of it
// is still a usable chart, re-flowed into a uniform grid that fits when it is not, and --
// when no grid of the wall's panes fits at all -- shown one pane at a time with a strip of
// tabs to choose which. None of that is a layout CHANGE: the preset id, the pane count and
// every pane's state are untouched, so the same wall comes back as declared on a screen
// that has the room for it.

import type { LayoutPreset } from './layouts'

/** The smallest cell still worth drawing a chart in: room for a price axis beside a readable
 * run of candles, and a candle area above the time axis. */
export const MIN_PANE_WIDTH = 200
export const MIN_PANE_HEIGHT = 180

export interface PaneMinimum {
  width: number
  height: number
}

export type WallFit =
  /** The preset as declared. */
  | { mode: 'preset' }
  /** Every pane, auto-placed in reading order into `columns` x `rows`. */
  | { mode: 'reflow'; columns: number; rows: number }
  /** The active pane alone; the others stay mounted, concealed behind it. */
  | { mode: 'single' }

export function fitWall(
  layout: Pick<LayoutPreset, 'rows' | 'paneCount'>,
  width: number,
  height: number,
  min: PaneMinimum = { width: MIN_PANE_WIDTH, height: MIN_PANE_HEIGHT }
): WallFit {
  const count = layout.paneCount
  // Unmeasured (not laid out yet, or a hidden tab) says nothing about the screen: draw the
  // preset rather than flash a fallback on the first frame.
  if (count <= 1 || width <= 0 || height <= 0) return { mode: 'preset' }

  const presetColumns = layout.rows[0].trim().split(/\s+/).length
  const presetRows = layout.rows.length
  if (width / presetColumns >= min.width && height / presetRows >= min.height) {
    return { mode: 'preset' }
  }

  // Every uniform grid that holds all the panes with usable cells. Among those, the one with
  // the fewest empty cells (the last pane spans them, which reads as a deliberate wide pane
  // but is still a pane drawn at a different size from its neighbours), then the one whose
  // tightest dimension has the most room.
  let best: { columns: number; rows: number; empty: number; room: number } | null = null
  for (let columns = 1; columns <= count; columns++) {
    const rows = Math.ceil(count / columns)
    const cellWidth = width / columns
    const cellHeight = height / rows
    if (cellWidth < min.width || cellHeight < min.height) continue
    const empty = columns * rows - count
    const room = Math.min(cellWidth / min.width, cellHeight / min.height)
    if (!best || empty < best.empty || (empty === best.empty && room > best.room)) {
      best = { columns, rows, empty, room }
    }
  }
  return best ? { mode: 'reflow', columns: best.columns, rows: best.rows } : { mode: 'single' }
}

/** The inline placement of pane `index` (0-based, reading order) under `fit`. */
export function panePlacement(fit: WallFit, index: number, count: number, area: string): string {
  if (fit.mode === 'single') return 'grid-area: 1 / 1;'
  if (fit.mode === 'preset') return `grid-area: ${area};`
  // The last pane takes whatever its row leaves over, so a re-flowed wall never shows a
  // hole where a pane would be.
  const spare = fit.columns * fit.rows - count
  if (index === count - 1 && spare > 0) return `grid-column: span ${spare + 1};`
  return ''
}
