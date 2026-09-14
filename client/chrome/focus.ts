// Where on a very wide page the user is working.
//
// A browser window stretched across two or three monitors has its centre on a bezel, and so
// does every dialog and floating window that opens "in the middle". Past WIDE_SHELL_WIDTH
// (src/config/responsive.ts, the same threshold the chart uses for its own dialogs) the app's
// body-level cards open over the ACTIVE pane instead -- the pane last touched is the display
// the user is looking at. Below it, nothing here changes anything.
//
// A module-level source, like `currentDockHost()` in ./window.ts: the cards that want it are
// built deep inside feature modules that were never handed the chart, and there is one wall
// on the page at a time. The mounted wall sets it and its teardown clears it.

// The pure module rather than the '../../src' barrel: window.ts imports this, and its geometry
// tests must not load klinecharts, which reads `window` at import.
import { centreWithin, WIDE_SHELL_WIDTH } from '../../src/config/responsive'

/** Keeps a card clear of the page edge it is clamped against. */
const EDGE = 16

type FocusSource = () => DOMRect | null

let source: FocusSource | null = null

export function setFocusSource(next: FocusSource | null): void {
  source = next
}

/** The active pane's horizontal centre in viewport pixels, or null when the page is not wide
 * enough for it to matter (or no pane is mounted). */
export function focusCenter(): number | null {
  if (window.innerWidth < WIDE_SHELL_WIDTH) return null
  const rect = source?.()
  return rect && rect.width > 0 ? rect.left + rect.width / 2 : null
}

/** The left edge for a floating window `width` wide inside [left, right], over the focus;
 * null when there is no focus and the caller's own default applies. */
export function focusLeft(width: number, left: number, right: number): number | null {
  const center = focusCenter()
  return center === null ? null : centreWithin(center, width, left, right, EDGE)
}

/** Re-centres a card inside a full-page flex backdrop over the focus. Call after the card is
 * in the document, so it has a width. */
export function placeOverFocus(backdrop: HTMLElement, card: HTMLElement): void {
  const left = focusLeft(card.offsetWidth, 0, window.innerWidth)
  if (left === null) return
  backdrop.style.justifyContent = 'flex-start'
  card.style.marginLeft = `${Math.round(left)}px`
}
