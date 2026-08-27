// GLUE (DOM). A small floating window: a fixed-position card the user drags by its title
// bar, collapses to that bar alone, and finds again where they left it.
//
// The replay controls live in one of these (controls.ts) rather than in a strip inside the
// trading dock. The strip cost the wall ~90px of height that it never gave back, and the
// wall is the thing being replayed -- controls that overlap it can be moved off whatever the
// user is looking at, controls that push it down cannot.
//
// The window is clamped into the CHART's rect, not the viewport: the trading dock takes its
// own row below `#app` (client/trading/dock.ts), so clamping to `#app` is exactly what keeps
// the window clear of the dock when it opens, and lets it use the space back when it closes.
//
// The geometry is pure and tested (window.test.ts); everything else here is DOM.

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

/** A viewport-space rectangle. A `DOMRect` satisfies it. */
export interface Bounds {
  left: number
  top: number
  right: number
  bottom: number
}

/** Gap kept between the window and the edge of its bounds. */
export const EDGE_MARGIN = 8

/** Room left below a bottom-anchored window for the chart's time axis. */
export const AXIS_CLEARANCE = 44

/** The nearest position to `pos` that keeps a `size` window inside `bounds`. A window larger
 * than its bounds is pinned to the top-left corner rather than pushed off the other side. */
export function clampPosition(pos: Point, size: Size, bounds: Bounds, margin = EDGE_MARGIN): Point {
  const minX = bounds.left + margin
  const minY = bounds.top + margin
  const maxX = Math.max(minX, bounds.right - margin - size.width)
  const maxY = Math.max(minY, bounds.bottom - margin - size.height)
  return {
    x: Math.min(Math.max(pos.x, minX), maxX),
    y: Math.min(Math.max(pos.y, minY), maxY)
  }
}

/** Where a window opens the first time: centred on the bottom of the chart, above the time
 * axis -- the least valuable strip of a chart being replayed, and where the eye already is. */
export function defaultPosition(size: Size, bounds: Bounds): Point {
  return clampPosition(
    {
      x: bounds.left + (bounds.right - bounds.left - size.width) / 2,
      y: bounds.bottom - size.height - AXIS_CLEARANCE
    },
    size,
    bounds
  )
}

/** What survives a reload: where the user dragged the window (absent while they never have)
 * and whether it was rolled up. */
export interface WindowPlacement {
  x?: number
  y?: number
  collapsed: boolean
}

export function readPlacement(key: string): WindowPlacement | null {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const { x, y, collapsed } = parsed as Record<string, unknown>
    return {
      x: typeof x === 'number' ? x : undefined,
      y: typeof y === 'number' ? y : undefined,
      collapsed: collapsed === true
    }
  } catch {
    // Private-browsing / policy-blocked storage: an unremembered position is not worth a
    // console warning on every mount.
    return null
  }
}

function writePlacement(key: string, placement: WindowPlacement): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(placement))
  } catch {
    // As above -- the window still works, it just opens where it opened last time.
  }
}

export interface FloatingWindowOptions {
  /** Extra class on the root card: the caller's styling hook. */
  className?: string
  /** localStorage key for the placement. */
  storageKey: string
  /** The element the window stays inside. Its rect is the bounds; the viewport when it has
   * none (detached, or zero-sized before the first layout). */
  bounds: HTMLElement
  /** Theme class for a body-level card: kc tokens are scoped under the chart's own root. */
  theme?: string
  /** Told when a drag or a collapse changed the window, after it has been applied. */
  onChange?: () => void
}

export interface FloatingWindow {
  readonly element: HTMLElement
  /** The title bar, and the drag handle. Buttons placed in it keep their own clicks. */
  readonly header: HTMLElement
  /** The content that hides when the window is collapsed. */
  readonly body: HTMLElement
  readonly collapsed: boolean
  setCollapsed(next: boolean): void
  /** Re-clamp: the content, the bounds or the viewport changed size. */
  reflow(): void
  dispose(): void
}

export function createFloatingWindow(options: FloatingWindowOptions): FloatingWindow {
  const root = document.createElement('div')
  root.className = ['wd-float', options.className ?? '', options.theme ?? ''].filter(Boolean).join(' ')
  const header = document.createElement('div')
  header.className = 'wd-float-header'
  const body = document.createElement('div')
  body.className = 'wd-float-body'
  root.append(header, body)

  const stored = readPlacement(options.storageKey)
  let collapsed = stored?.collapsed === true
  let position: Point | null = stored?.x !== undefined && stored?.y !== undefined ? { x: stored.x, y: stored.y } : null
  // A window the user has never dragged stays ANCHORED to its default spot rather than to
  // wherever its first (content-less) layout happened to put it: it then grows upward from
  // the bottom of the chart as panels open, instead of drifting down into the time axis.
  // Dragging it once, ever, hands the position over to the user for good.
  let anchored = position === null
  root.classList.toggle('is-collapsed', collapsed)

  function bounds(): Bounds {
    const rect = options.bounds.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return rect
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
  }

  function apply(next: Point): void {
    position = next
    root.style.left = `${Math.round(next.x)}px`
    root.style.top = `${Math.round(next.y)}px`
  }

  function reflow(): void {
    const size = { width: root.offsetWidth, height: root.offsetHeight }
    if (size.width === 0 || size.height === 0) return
    const box = bounds()
    apply(anchored || !position ? defaultPosition(size, box) : clampPosition(position, size, box))
    // Until it has been placed the card would render at (0, 0); the class is what reveals it.
    root.classList.add('is-placed')
  }

  function save(): void {
    // An anchored window stores no position: one written now would be read back as a drag
    // next time and freeze the window where this session's content size happened to put it.
    writePlacement(options.storageKey, anchored || !position ? { collapsed } : { x: position.x, y: position.y, collapsed })
    options.onChange?.()
  }

  // -- dragging ---------------------------------------------------------------------------

  let grab: { dx: number; dy: number; pointerId: number; moved: boolean } | null = null

  header.addEventListener('pointerdown', (event: PointerEvent) => {
    // The title bar carries controls of its own (Step, collapse, Exit). A press that starts
    // on one of them is that control's, not a drag.
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, select, input, label, a')) return
    const rect = root.getBoundingClientRect()
    grab = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, pointerId: event.pointerId, moved: false }
    header.setPointerCapture(event.pointerId)
    root.classList.add('is-dragging')
    event.preventDefault()
  })

  header.addEventListener('pointermove', (event: PointerEvent) => {
    if (!grab || event.pointerId !== grab.pointerId) return
    // Un-anchored on the first MOVEMENT, not on the press: a stray click on the title bar
    // would otherwise freeze the window wherever it happened to be.
    grab.moved = true
    anchored = false
    const size = { width: root.offsetWidth, height: root.offsetHeight }
    apply(clampPosition({ x: event.clientX - grab.dx, y: event.clientY - grab.dy }, size, bounds()))
  })

  const endDrag = (event: PointerEvent): void => {
    if (!grab || event.pointerId !== grab.pointerId) return
    header.releasePointerCapture(grab.pointerId)
    const moved = grab.moved
    grab = null
    root.classList.remove('is-dragging')
    if (moved) save()
  }
  header.addEventListener('pointerup', endDrag)
  header.addEventListener('pointercancel', endDrag)

  // -- staying inside ----------------------------------------------------------------------

  // The window's own size changes when a section opens; the bounds change when the trading
  // dock opens below the chart or the browser is resized. Both can leave the window hanging
  // off an edge, so both re-clamp.
  const observer = new ResizeObserver(() => reflow())
  observer.observe(root)
  observer.observe(options.bounds)
  const onResize = (): void => reflow()
  window.addEventListener('resize', onResize)

  document.body.appendChild(root)
  reflow()

  return {
    element: root,
    header,
    body,
    get collapsed(): boolean {
      return collapsed
    },
    setCollapsed(next: boolean): void {
      collapsed = next
      root.classList.toggle('is-collapsed', collapsed)
      // Collapsing shrinks the card; a window sitting against the bottom edge would leave a
      // gap, and expanding it again could hang off. Re-clamp before remembering the state.
      reflow()
      save()
    },
    reflow,
    dispose(): void {
      observer.disconnect()
      window.removeEventListener('resize', onResize)
      root.remove()
    }
  }
}
