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

// Taps on a touch screen, recognised from touch events.
//
// klinecharts answers a tap itself (it puts the crosshair down) and then cancels the click the
// browser would have sent after it (`EventHandlerImp._touchEndHandler` prevents the touchend's
// default), so nothing listening for `click` on a chart ever hears a finger. Whatever a click
// does on a chart must therefore be recognised from the touches -- here, the double tap that
// stands in for a click-to-scroll, because a single tap is already the crosshair's.
//
// One finger only: a second finger is a pinch, and a pinch is never a tap, before or after.

/** How far a finger may stray and still have tapped -- klinecharts' own CancelTap distance. */
export const TAP_SLOP_PX = 10
/** How long a finger may stay down and still have tapped: longer is a press (klinecharts' long
 * tap fires at 500 ms). */
export const TAP_MAX_MS = 400
/** How soon a second tap must land to make a double tap. */
export const DOUBLE_TAP_MS = 350
/** How close to the first a second tap must land. Looser than the slop: a thumb tapping twice
 * does not land on the same pixel. */
export const DOUBLE_TAP_SLOP_PX = 30

export interface TapPoint {
  x: number
  y: number
  /** Milliseconds, on any clock both calls share (an event's `timeStamp`). */
  t: number
}

export type TapKind = 'tap' | 'double-tap'

export interface TapRecognizer {
  /** A finger went down; `touches` is how many are down now, this one included. */
  start(point: TapPoint, touches: number): void
  /** A finger lifted at `point`; `remaining` is how many are still down. What the touch was,
   * if it was a tap at all. */
  end(point: TapPoint, remaining: number): TapKind | null
  /** Forget everything (the gesture was taken by something else). */
  reset(): void
}

function distance(a: TapPoint, b: TapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function createTapRecognizer(): TapRecognizer {
  let down: TapPoint | null = null
  // Set when a second finger joined: the gesture is a pinch until every finger has lifted.
  let multi = false
  let lastTap: TapPoint | null = null

  return {
    start(point, touches) {
      if (touches !== 1) {
        multi = true
        down = null
        lastTap = null
        return
      }
      multi = false
      down = point
    },
    end(point, remaining) {
      const started = down
      down = null
      if (remaining > 0 || multi || started === null) {
        if (remaining === 0) multi = false
        lastTap = null
        return null
      }
      if (distance(point, started) > TAP_SLOP_PX || point.t - started.t > TAP_MAX_MS) {
        lastTap = null
        return null
      }
      const previous = lastTap
      if (previous && point.t - previous.t <= DOUBLE_TAP_MS && distance(point, previous) <= DOUBLE_TAP_SLOP_PX) {
        // A third tap starts a new pair rather than making a second double tap of the first.
        lastTap = null
        return 'double-tap'
      }
      lastTap = point
      return 'tap'
    },
    reset() {
      down = null
      multi = false
      lastTap = null
    }
  }
}

/**
 * A gesture's tail: the visible-range changes a finger keeps causing after it lifts. klinecharts
 * flings a chart that was let go while moving -- up to four seconds of scrolling with no finger
 * on the glass -- and a wall following the pan must follow that too, or the source pane ends a
 * fling hundreds of bars from the rest. Each change inside the tail extends it by `gapMs`, so
 * it lasts exactly as long as the fling's frames keep coming, never longer than `maxMs`.
 */
export interface GestureTail {
  /** The finger lifted at `now`. */
  begin(now: number): void
  /** A visible-range change at `now`: whether it belongs to the tail (and extends it). */
  touch(now: number): boolean
  /** Whether `now` is still inside the tail, without extending it. */
  active(now: number): boolean
  clear(): void
}

export const FLING_GAP_MS = 120
export const FLING_MAX_MS = 4500

export function createGestureTail(gapMs = FLING_GAP_MS, maxMs = FLING_MAX_MS): GestureTail {
  let until = 0
  let cap = 0
  return {
    begin(now) {
      until = now + gapMs
      cap = now + maxMs
    },
    touch(now) {
      if (now >= until || now >= cap) return false
      until = Math.min(now + gapMs, cap)
      return true
    },
    active(now) {
      return now < until && now < cap
    },
    clear() {
      until = 0
      cap = 0
    }
  }
}
