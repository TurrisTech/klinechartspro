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

// Where a dragged dialog may go. A dialog is moved by an offset from where the stylesheet puts
// it; the offset is clamped so the whole dialog stays inside `bounds` (the shell), which also
// means a drag can never lose the header -- the only place to grab it back from.

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Offset {
  x: number
  y: number
}

/** The offset to apply after the pointer moved by `delta`, from a drag that began with the
 * dialog at `start` (its on-screen box then) under `offset`. On an axis where the dialog is
 * bigger than the bounds it cannot move away from where it is. */
export function dragOffset(offset: Offset, delta: Offset, start: Box, bounds: Box): Offset {
  const axis = (d: number, lo: number, hi: number, at: number): number =>
    at + Math.min(Math.max(d, Math.min(lo, 0)), Math.max(hi, 0))
  return {
    x: axis(delta.x, bounds.left - start.left, bounds.right - start.right, offset.x),
    y: axis(delta.y, bounds.top - start.top, bounds.bottom - start.bottom, offset.y)
  }
}
