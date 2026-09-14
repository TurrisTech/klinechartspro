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

// The shell's size classes, measured on the component's own box rather than the viewport:
// the chart is a library, and the element it is mounted in is the only size it can trust.
//
// Deliberately NOT CSS container queries. `container-type` makes the container the
// containing block of every `position: fixed` descendant, and the app mounts fixed-position
// panels (the workspace menu, the notification panel, layer settings) inside this element --
// each would be offset by the shell instead of the viewport. A measured `data-size` attribute
// styles the same things with none of that.
//
// The toolbar is not keyed off these at all: what fits in it depends on what the app puts in
// its slots, so ChartPro.svelte measures the toolbar itself.

/** Below this width the drawing rail overlays the chart instead of taking a column from it,
 * and starts hidden. */
export const NARROW_SHELL_WIDTH = 640

/** Below this height a dialog cannot sit centred with room around it. */
export const SHORT_SHELL_HEIGHT = 480

/** At or above this width the shell is taken to span displays (or one very large one):
 * dialogs and floating windows open over the ACTIVE pane rather than the middle of the
 * window, which on two side-by-side monitors is the bezel between them. */
export const WIDE_SHELL_WIDTH = 2400

export type ShellSize = 'phone' | 'regular' | 'wide'

export function shellSize(width: number, height: number): ShellSize {
  // Unmeasured is regular: nothing is restyled on the first frame.
  if (width <= 0 || height <= 0) return 'regular'
  if (width < NARROW_SHELL_WIDTH || height < SHORT_SHELL_HEIGHT) return 'phone'
  if (width >= WIDE_SHELL_WIDTH) return 'wide'
  return 'regular'
}

/** Where a box `size` wide is centred on `focusCenter`, kept `margin` inside [start, end]. */
export function centreWithin(
  focusCenter: number,
  size: number,
  start: number,
  end: number,
  margin: number
): number {
  const min = start + margin
  const max = Math.max(min, end - margin - size)
  return Math.min(Math.max(focusCenter - size / 2, min), max)
}
