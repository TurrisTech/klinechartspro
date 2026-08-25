import type { LayerWindow } from './types'

// PURE. What a pane has covered and what it still needs, as rectangles of the price/time
// plane. Lifted out of controller.ts so the arithmetic that decides whether a redraw costs a
// request can be tested without a chart, a DOM or a network — it is the whole reason panning
// and rescaling are free, and it was previously reachable only through a live pane.

// The server computes over the full price history, so an unbounded query returns bands
// nowhere near the current price. Every price-anchored layer needs a window around the
// visible range, not the whole loaded history — kept here rather than per-layer because it
// is about how much of the chart is on screen, not about what any one layer computes.
export const PRICE_WINDOW_FRACTION = 0.06

// How far past the window it actually needs a fetch reaches, as a fraction of the visible
// span on each side. Bought once and kept: the next small pan or rescale then lands inside
// what the pane already holds and repaints without a request. Half a screen in both axes
// keeps the held rectangle at ~2x the view per axis rather than unbounded, and measuring it
// against the VISIBLE span rather than the accumulated one means a long session of panning
// grows the window a screen at a time instead of doubling it per fetch.
//
// This bounds WHICH DATA a pane has, and is deliberately not the same number as how far off
// screen a layer draws what it has (levels/layer.ts's DRAW_MARGIN_SPANS): a level whose life
// crosses the view was fetched by that crossing, and its line then has to run well past the
// pane or the drawing's own edge shows up as a wall when the view moves.
export const PREFETCH_FRACTION = 0.5

export function contains(outer: LayerWindow, inner: LayerWindow): boolean {
  return (
    outer.priceMin <= inner.priceMin &&
    outer.priceMax >= inner.priceMax &&
    outer.from <= inner.from &&
    outer.to >= inner.to
  )
}

/** The window to fetch so that `needed` is covered with a margin, given what is already
 * held. Always contains both, so `missingWindows(held, targetWindow(held, needed))` tiles
 * exactly the new ground.
 *
 * **The margin is bought only on the sides that actually moved.** Padding every side of
 * `union(held, needed)` instead — which is what this did originally — meant a pan straight
 * to the right also pushed the price band out by half a screen on both edges and the time
 * axis out on the left, so a one-rectangle request became four, three of them for ground the
 * view had not approached. Over sixteen quarter-screen pans that is 20 requests against 7.
 */
export function targetWindow(held: LayerWindow | null, needed: LayerWindow): LayerWindow {
  const pricePad = (needed.priceMax - needed.priceMin) * PREFETCH_FRACTION
  const timePad = (needed.to - needed.from) * PREFETCH_FRACTION
  // Nothing held: the first fetch buys the margin all round, since no side is "the one that
  // moved" and the next move is as likely to go one way as the other.
  if (held === null) {
    return {
      priceMin: needed.priceMin - pricePad,
      priceMax: needed.priceMax + pricePad,
      from: needed.from - timePad,
      to: needed.to + timePad
    }
  }
  return {
    priceMin: needed.priceMin < held.priceMin ? needed.priceMin - pricePad : held.priceMin,
    priceMax: needed.priceMax > held.priceMax ? needed.priceMax + pricePad : held.priceMax,
    from: needed.from < held.from ? needed.from - timePad : held.from,
    to: needed.to > held.to ? needed.to + timePad : held.to
  }
}

// `target` minus `loaded` as up to four rectangles: the price bands above and below what is
// held (each spanning target's full time span) plus, within the held band, the time spans
// before and after it. They tile the difference exactly, so fetching them and merging is
// equivalent to refetching `target` whole — and the caller only pays for the new ground.
// Requires `target` to contain `loaded`, which is what `targetWindow(loaded, ...)` gives.
export function missingWindows(loaded: LayerWindow, target: LayerWindow): LayerWindow[] {
  const windows: LayerWindow[] = []
  if (target.priceMin < loaded.priceMin) windows.push({ ...target, priceMax: loaded.priceMin })
  if (target.priceMax > loaded.priceMax) windows.push({ ...target, priceMin: loaded.priceMax })
  const heldBand = { priceMin: loaded.priceMin, priceMax: loaded.priceMax }
  if (target.from < loaded.from) windows.push({ ...heldBand, from: target.from, to: loaded.from })
  if (target.to > loaded.to) windows.push({ ...heldBand, from: loaded.to, to: target.to })
  return windows
}
