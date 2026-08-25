import type { OverlayCreate } from 'klinecharts'

// PURE. Whether a redraw would actually change the picture.
//
// A price-anchored layer redraws far more often than it changes. Pan and zoom raise
// `onVisibleRangeChange`, but so does **every live tick**: klinecharts' `_addData` re-runs
// `_adjustVisibleRange` when the last bar is merely updated, and the price axis, left on
// autoscale, drifts a fraction of a pip with it — which the controller's axis watcher then
// notices too. On a busy session that is several redraws a second, each one tearing down and
// rebuilding several hundred overlays for a set of lines that has not moved.
//
// The observation that makes gating safe: of everything `toOverlays` reads, only the price
// band moves on a tick. The age and untouched-days metrics key off `ctx.to`, which is the
// last VISIBLE BAR's timestamp, not wall-clock time — it changes when a candle opens, not
// while one forms — and the draw window is derived from `ctx.from`/`ctx.to` the same way. So
// between two candles the overlay set is identical except when a level crosses the padded
// band, and a signature over what was built catches exactly that: it is derived from the
// overlays themselves, so it cannot drift from what would be drawn the way a hand-listed set
// of inputs would.

/** A stable string identifying what a set of overlays draws: shape, geometry and line
 * styling. `extendData` is deliberately excluded — it is the source datum stashed for future
 * click handlers, not something anyone can see, and any change to a datum that MATTERS is
 * already visible in the points or the style computed from it. */
export function overlaySignature(overlays: readonly OverlayCreate[]): string {
  const parts: string[] = []
  for (const overlay of overlays) {
    parts.push(String(overlay.name ?? ''), String(overlay.paneId ?? ''))
    for (const point of overlay.points ?? []) parts.push(`${point.timestamp},${point.value}`)
    parts.push(JSON.stringify(overlay.styles ?? null))
  }
  return parts.join('|')
}
