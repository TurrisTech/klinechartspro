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

// Wall pane layout presets. Each preset is encoded as ROWS OF PANE TOKENS rather than a
// hand-written `grid-template-areas` string or a rows/cols+span table -- tokens are
// self-validating (parseLayout throws on a typo at import time) and every CSS Grid
// declaration the picker/grid needs is *derived* from the same source that renders the
// mini-preview, so the preview can never drift from the real layout.
//
// Pane tokens are 'p1'..'p12', reserved for a WALL pane (see src/state/wall.svelte.ts). Not
// to be confused with klinecharts' own "pane" (candle_pane / indicator sub-panes) -- those
// are called `chartPaneId` throughout this codebase.

export interface LayoutPreset {
  /** Stable slug. Persisted (client preferences, onPaneLayoutChange) -- never reorder or
   *  reuse an id for a different arrangement once shipped. */
  id: string
  /** Number of distinct panes this preset renders. */
  paneCount: number
  /** The raw token rows this preset was declared with, e.g. ['p1 p2', 'p3 p4']. Exposed so
   *  the layout picker's mini-preview can render the exact same grid at thumbnail size. */
  rows: readonly string[]
  /** CSS `grid-template-areas` value (rows already individually quoted). */
  gridTemplateAreas: string
  /** CSS `grid-template-columns` value. */
  gridTemplateColumns: string
  /** CSS `grid-template-rows` value. */
  gridTemplateRows: string
  /** Pane index (0-based, in first-appearance/reading order) -> its `grid-area` token. */
  paneAreas: readonly string[]
}

// [id, rows] pairs. 13 presets covering counts 1/2/3/4/6/8/9/12. Counts 5/7/10/11 have no
// pleasing rectangular arrangement and are left out rather than shipping a ragged grid.
const RAW: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['1', ['p1']],
  ['2h', ['p1 p2']],
  ['2v', ['p1', 'p2']],
  ['3h', ['p1 p2 p3']],
  ['3v', ['p1', 'p2', 'p3']],
  ['3-left', ['p1 p2', 'p1 p3']],
  ['3-top', ['p1 p1', 'p2 p3']],
  ['4', ['p1 p2', 'p3 p4']],
  ['4h', ['p1 p2 p3 p4']],
  ['4v', ['p1', 'p2', 'p3', 'p4']],
  ['6', ['p1 p2 p3', 'p4 p5 p6']],
  ['6v', ['p1 p2', 'p3 p4', 'p5 p6']],
  ['8', ['p1 p2 p3 p4', 'p5 p6 p7 p8']],
  ['9', ['p1 p2 p3', 'p4 p5 p6', 'p7 p8 p9']],
  ['12', ['p1 p2 p3 p4', 'p5 p6 p7 p8', 'p9 p10 p11 p12']]
]

function parseLayout(id: string, rows: readonly string[]): LayoutPreset {
  if (rows.length === 0) throw new Error(`layout '${id}': no rows`)

  const tokenRows = rows.map((row) => row.trim().split(/\s+/))
  const columnCount = tokenRows[0].length
  for (const [index, tokens] of tokenRows.entries()) {
    if (tokens.length !== columnCount) {
      throw new Error(
        `layout '${id}': row ${index} has ${tokens.length} columns, expected ${columnCount} (ragged grid)`
      )
    }
  }

  // Distinct tokens in first-appearance (reading) order -- this order is what maps pane
  // index 0..N-1 to a grid-area, and must match the order panes are seeded/rendered in.
  const paneAreas: string[] = []
  const seen = new Set<string>()
  for (const tokens of tokenRows) {
    for (const token of tokens) {
      if (!seen.has(token)) {
        seen.add(token)
        paneAreas.push(token)
      }
    }
  }

  // Verify each token's occurrences form a single rectangle (contiguous rows, contiguous
  // columns within each of those rows) -- CSS Grid requires this of every named area.
  for (const token of paneAreas) {
    let minRow = -1
    let maxRow = -1
    let minCol = -1
    let maxCol = -1
    for (const [rowIndex, tokens] of tokenRows.entries()) {
      for (const [colIndex, cell] of tokens.entries()) {
        if (cell !== token) continue
        if (minRow === -1) minRow = rowIndex
        maxRow = rowIndex
        minCol = minCol === -1 ? colIndex : Math.min(minCol, colIndex)
        maxCol = Math.max(maxCol, colIndex)
      }
    }
    for (let rowIndex = minRow; rowIndex <= maxRow; rowIndex++) {
      for (let colIndex = minCol; colIndex <= maxCol; colIndex++) {
        if (tokenRows[rowIndex][colIndex] !== token) {
          throw new Error(`layout '${id}': area '${token}' is not a rectangle`)
        }
      }
    }
  }

  // Tokens must be exactly p1..pN, contiguous, no gaps and no stray names -- this is what
  // lets PaneState index i be trusted to correspond to token `p${i + 1}`.
  const expected = paneAreas.map((_, index) => `p${index + 1}`)
  const sortedByNumber = [...paneAreas].sort(
    (a, b) => Number(a.slice(1)) - Number(b.slice(1))
  )
  if (sortedByNumber.join(',') !== expected.join(',')) {
    throw new Error(
      `layout '${id}': tokens must be exactly p1..p${paneAreas.length} contiguous, got [${paneAreas.join(', ')}]`
    )
  }

  return {
    id,
    paneCount: paneAreas.length,
    rows,
    gridTemplateAreas: tokenRows.map((tokens) => `"${tokens.join(' ')}"`).join(' '),
    gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
    gridTemplateRows: `repeat(${tokenRows.length}, minmax(0, 1fr))`,
    // paneAreas is already in p1..pN order because of the check above, but sort explicitly
    // by pane number so `paneAreas[i]` is always `'p${i+1}'`'s area token -- i.e. itself --
    // regardless of the token's first-appearance order in `rows`.
    paneAreas: sortedByNumber
  }
}

const LAYOUTS: readonly LayoutPreset[] = RAW.map(([id, rows]) => parseLayout(id, rows))

const BY_ID = new Map(LAYOUTS.map((layout) => [layout.id, layout]))

export function getLayouts(): readonly LayoutPreset[] {
  return LAYOUTS
}

export function layoutById(id: string): LayoutPreset {
  return BY_ID.get(id) ?? LAYOUTS[0]
}

// The smallest preset whose paneCount can hold `count` panes -- used when a caller supplies
// `panes` but no explicit `paneLayout`.
export function smallestLayoutFor(count: number): LayoutPreset {
  let best: LayoutPreset = LAYOUTS[LAYOUTS.length - 1]
  for (const layout of LAYOUTS) {
    if (layout.paneCount >= count && layout.paneCount < best.paneCount) best = layout
  }
  if (best.paneCount < count) {
    // count exceeds every preset's paneCount (i.e. > 12) -- fall back to the largest.
    return LAYOUTS.reduce((max, l) => (l.paneCount > max.paneCount ? l : max))
  }
  return best
}

export const MAX_PANES = 12
