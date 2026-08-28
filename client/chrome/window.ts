// GLUE (DOM). The app's dockable windows.
//
// A window is a card that is either **docked** — in a column below the chart, taking its own
// height off the wall — or **floating** over the chart: dragged by its title bar, resized from
// its corner, rolled up to that bar alone, and remembered per browser. Dragging a docked
// window out floats it; dragging a floating one onto the bottom of the chart docks it.
//
// Two of them today, and they are the same object on purpose: the trading panel (docked by
// default — the account, ticket and tables want the width) and the bar replay's controls
// (floating by default — they are small, and the wall is the thing being replayed). Same
// title bar, same drag, same persistence, so learning one teaches the other.
//
// Floating windows are clamped into the CHART's rect, not the viewport: `#app` shrinks by
// exactly the dock column's height (`body.wd-has-dock` makes the page a flex column), so
// clamping to it is what keeps a floating window off the docked ones.
//
// The geometry is pure and tested (window.test.ts); everything else here is DOM.

export type WindowMode = 'float' | 'dock'

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

/** Gap kept between a floating window and the edge of its bounds. */
export const EDGE_MARGIN = 8

/** Room left below a bottom-anchored window for the chart's time axis. */
export const AXIS_CLEARANCE = 44

/** How deep the drag-to-dock strip along the bottom of the chart is. */
export const DOCK_ZONE = 72

/** The chart keeps at least this fraction of the page, however tall the dock column is. */
export const MAX_DOCK_FRACTION = 0.7

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

/** Where a window opens before the user has dragged it anywhere.
 *
 * `bottom` is for a small window that belongs near the chart's own controls: centred on the
 * bottom, above the time axis — the least valuable strip of a chart, and where the eye is.
 * `center` is for a large one, which would otherwise cover exactly the strip the small ones
 * anchor to. Two windows sharing an anchor would open stacked on each other. */
export type FloatAnchor = 'bottom' | 'center'

export function defaultPosition(size: Size, bounds: Bounds, anchor: FloatAnchor = 'bottom'): Point {
  const x = bounds.left + (bounds.right - bounds.left - size.width) / 2
  const y =
    anchor === 'center'
      ? bounds.top + (bounds.bottom - bounds.top - size.height) / 2
      : bounds.bottom - size.height - AXIS_CLEARANCE
  return clampPosition({ x, y }, size, bounds)
}

/** A drag-resize result: at least `min`, never wider or taller than the bounds allow from
 * `origin` (the window's top-left, which resizing does not move). */
export function clampSize(size: Size, origin: Point, bounds: Bounds, min: Size, margin = EDGE_MARGIN): Size {
  const maxWidth = Math.max(min.width, bounds.right - margin - origin.x)
  const maxHeight = Math.max(min.height, bounds.bottom - margin - origin.y)
  return {
    width: Math.min(Math.max(size.width, min.width), maxWidth),
    height: Math.min(Math.max(size.height, min.height), maxHeight)
  }
}

/** A docked window's height: never below `min`, never so tall that the chart is left with
 * less than `1 - MAX_DOCK_FRACTION` of the page. */
export function clampDockHeight(height: number, viewportHeight: number, min = 120): number {
  return Math.min(Math.max(height, min), Math.max(min, viewportHeight * MAX_DOCK_FRACTION))
}

/** Whether a drag at `pointerY` is over the strip along the bottom of the chart that docks
 * the window on release. */
export function inDropZone(pointerY: number, bounds: Bounds, zone = DOCK_ZONE): boolean {
  return pointerY >= bounds.bottom - zone && pointerY <= bounds.bottom
}

// -- what survives a reload -------------------------------------------------------------------

export interface WindowPlacement {
  mode?: WindowMode
  /** The floating position; absent while the user has never dragged the window. */
  x?: number
  y?: number
  width?: number
  height?: number
  dockHeight?: number
  collapsed?: boolean
}

const STORAGE_PREFIX = 'wd.window.'

export function readPlacement(key: string): WindowPlacement | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const p = parsed as Record<string, unknown>
    const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
    return {
      mode: p.mode === 'float' || p.mode === 'dock' ? p.mode : undefined,
      x: num(p.x),
      y: num(p.y),
      width: num(p.width),
      height: num(p.height),
      dockHeight: num(p.dockHeight),
      collapsed: p.collapsed === true
    }
  } catch {
    // Private-browsing / policy-blocked storage: an unremembered window is not worth a
    // console warning on every mount.
    return null
  }
}

function writePlacement(key: string, placement: WindowPlacement): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(placement))
  } catch {
    // As above — the window still works, it just opens where it opened last time.
  }
}

// -- the dock column ----------------------------------------------------------------------------

/** The column of docked windows below the chart. One per page, shared by every window, and
 * removed from the layout entirely (`display: none`) while nothing visible is in it — that is
 * what gives the chart the whole page when everything is floating or hidden. */
export interface DockHost {
  readonly element: HTMLElement
  add(win: HTMLElement, order: number): void
  remove(win: HTMLElement): void
  /** Re-evaluate whether the column shows anything (a hidden window does not count). */
  refresh(): void
}

let host: DockHost | null = null

/** Every live window's `reflow`. The dock column changing -- a window docking, undocking,
 * hiding, or its height being dragged -- resizes `#app`, and every FLOATING window is clamped
 * into `#app`. A ResizeObserver on `#app` would catch that in a browser that is painting, but
 * only there: an occluded or background tab delivers no observer callbacks at all, and the
 * windows would then sit over the dock column until something else moved them. The layout
 * change is known exactly where it happens, so it is broadcast rather than observed. */
const reflows = new Set<() => void>()

function layoutChanged(): void {
  for (const reflow of reflows) reflow()
}

/** The column, if there is one. Callers hold NO reference: it is removed from the page when
 * the last window leaves it, and a stale one would append into a detached element. */
export function currentDockHost(): DockHost | null {
  return host?.element.isConnected ? host : null
}

export function dockHost(anchor: HTMLElement, theme = ''): DockHost {
  const existing = currentDockHost()
  if (existing) return existing
  const element = document.createElement('div')
  // kc tokens are scoped under the chart's themed root; a body-level column carries the
  // theme class itself or it renders in the light defaults.
  element.className = `wd-dockhost ${theme}`.trim()
  // Inserted as `#app`'s sibling, not inside it: the pane grid must not see it.
  document.body.insertBefore(element, anchor.nextSibling)

  const refresh = (): void => {
    const shown = Array.from(element.children).some((c) => !c.classList.contains('is-hidden'))
    element.classList.toggle('is-empty', !shown)
    document.body.classList.toggle('wd-has-dock', shown)
    layoutChanged()
  }

  host = {
    element,
    add(win: HTMLElement, order: number): void {
      win.dataset.dockOrder = String(order)
      // Keep the column in `order`, whatever order the windows mounted in.
      const after = Array.from(element.children).find((c) => Number((c as HTMLElement).dataset.dockOrder ?? 0) > order)
      element.insertBefore(win, after ?? null)
      refresh()
    },
    remove(win: HTMLElement): void {
      if (win.parentElement === element) win.remove()
      refresh()
      if (element.children.length === 0) {
        element.remove()
        document.body.classList.remove('wd-has-dock')
        host = null
      }
    },
    refresh
  }
  refresh()
  return host
}

// -- the window ---------------------------------------------------------------------------------

export interface DockableWindowOptions {
  /** Identity: the storage key, and `data-window` on the element. */
  key: string
  /** Extra class on the card: the caller's styling hook. */
  className?: string
  /** The name in the title bar. */
  title: string
  /** The element a floating window stays inside, and whose bottom strip docks it: `#app`. */
  bounds: HTMLElement
  /** Theme class for a body-level card ('dark' or ''). */
  theme?: string
  /** Where it starts the first time, before the user has said otherwise. */
  defaultMode?: WindowMode
  /** Its size the first time it floats. Omit for a window that sizes itself to its content. */
  floatSize?: Size
  /** Smallest a drag-resize may make it. */
  minSize?: Size
  /** Told whenever the window's own box changed size (a drag-resize, a mode change), for
   * content that lays itself out differently at different widths. */
  onResize?: () => void
  /** Where it floats before the user has dragged it: against the bottom of the chart (the
   * default, for a small window) or centred (for a large one, which would cover the strip
   * the small ones sit in). */
  floatAnchor?: FloatAnchor
  /** Position in the dock column, low first (the replay controls sit above the account). */
  order?: number
  /** Shown as the title bar's close button when given. */
  onClose?: () => void
  /** Told after the mode changed, for a caller that renders differently docked. */
  onModeChange?: (mode: WindowMode) => void
}

export interface DockableWindow {
  readonly element: HTMLElement
  /** The title bar: the drag handle. Buttons in it still take their own clicks. */
  readonly header: HTMLElement
  /** Beside the title, for a caller's own status (the replay's cursor). */
  readonly titleSlot: HTMLElement
  /** Before the standard controls, for a caller's own buttons (the replay's Step). */
  readonly actions: HTMLElement
  /** The content, hidden when the window is rolled up. */
  readonly body: HTMLElement
  readonly mode: WindowMode
  readonly collapsed: boolean
  readonly visible: boolean
  setMode(mode: WindowMode): void
  setCollapsed(collapsed: boolean): void
  setVisible(visible: boolean): void
  /** Re-clamp: the content, the bounds or the viewport changed size. */
  reflow(): void
  dispose(): void
}

/** Floating windows stack in the order they were last touched. */
let topZ = 40

export function createDockableWindow(options: DockableWindowOptions): DockableWindow {
  const min = options.minSize ?? { width: 260, height: 120 }
  const stored = readPlacement(options.key)
  let mode: WindowMode = stored?.mode ?? options.defaultMode ?? 'float'
  let collapsed = stored?.collapsed === true
  let visible = true
  let position: Point | null = stored?.x !== undefined && stored?.y !== undefined ? { x: stored.x, y: stored.y } : null
  // A window the user has never dragged stays ANCHORED to its default spot rather than to
  // wherever its first (content-less) layout happened to put it: it then grows upward from
  // the bottom of the chart as panels open, instead of drifting down into the time axis.
  let anchored = position === null
  let size: Size | null =
    options.floatSize && stored?.width !== undefined && stored?.height !== undefined
      ? { width: stored.width, height: stored.height }
      : (options.floatSize ?? null)
  let dockHeight = stored?.dockHeight

  const root = document.createElement('div')
  root.className = ['wd-window', options.className ?? '', options.theme ?? ''].filter(Boolean).join(' ')
  root.dataset.window = options.key
  root.dataset.mode = mode

  const header = document.createElement('div')
  header.className = 'wd-window-header'
  const grip = document.createElement('span')
  grip.className = 'wd-window-grip'
  grip.textContent = '⠿'
  grip.setAttribute('aria-hidden', 'true')
  const title = document.createElement('span')
  title.className = 'wd-window-title'
  title.textContent = options.title
  const titleSlot = document.createElement('span')
  titleSlot.className = 'wd-window-title-slot'
  const spacer = document.createElement('span')
  spacer.className = 'wd-window-spacer'
  const actions = document.createElement('span')
  actions.className = 'wd-window-actions'
  // The caller's actions stay WITH the title, and only the window's own controls are pushed
  // to the far edge: docked, the card is as wide as the page, and a Step button 2,000px away
  // from the advance controls it belongs to is a different button.
  header.append(grip, title, titleSlot, actions, spacer)

  const controls = document.createElement('span')
  controls.className = 'wd-window-controls'
  const collapseButton = iconButton('', () => setCollapsed(!collapsed))
  const modeButton = iconButton('', () => setMode(mode === 'dock' ? 'float' : 'dock'))
  controls.append(collapseButton, modeButton)
  if (options.onClose) {
    const close = iconButton('×', () => options.onClose?.())
    close.title = 'Hide'
    close.classList.add('wd-window-close')
    controls.appendChild(close)
  }
  header.appendChild(controls)

  const body = document.createElement('div')
  body.className = 'wd-window-body'

  // Float: a corner to drag. Dock: the top edge, which sets the column's height. Only for a
  // window that has a size of its own -- one sized by its content resizes with it.
  const corner = document.createElement('div')
  corner.className = 'wd-window-corner'
  const edge = document.createElement('div')
  edge.className = 'wd-window-edge'
  root.append(header, body)
  if (options.floatSize) root.append(corner, edge)

  root.classList.toggle('is-collapsed', collapsed)
  const host = (): DockHost => dockHost(options.bounds, options.theme)

  // -- geometry ---------------------------------------------------------------------------

  function bounds(): Bounds {
    const rect = options.bounds.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) return rect
    return { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight }
  }

  function applyPosition(next: Point): void {
    position = next
    root.style.left = `${Math.round(next.x)}px`
    root.style.top = `${Math.round(next.y)}px`
  }

  function applySize(next: Size): void {
    size = next
    root.style.width = `${Math.round(next.width)}px`
    // Rolled up, the card is as tall as its title bar: the stored height is remembered for
    // when it opens again, but writing it now would leave an empty 380px of nothing.
    root.style.height = collapsed ? '' : `${Math.round(next.height)}px`
    options.onResize?.()
  }

  function reflow(): void {
    if (mode === 'dock') {
      root.style.left = ''
      root.style.top = ''
      root.style.width = ''
      root.style.height = options.floatSize && !collapsed ? `${Math.round(dockedHeight())}px` : ''
      return
    }
    const box = bounds()
    if (size) applySize(clampSize(size, position ?? { x: box.left, y: box.top }, box, min))
    const current = { width: root.offsetWidth, height: root.offsetHeight }
    if (current.width === 0 || current.height === 0) return
    applyPosition(
      anchored || !position ? defaultPosition(current, box, options.floatAnchor) : clampPosition(position, current, box)
    )
    // Until it has been placed the card would render at (0, 0); the class is what reveals it.
    root.classList.add('is-placed')
  }

  function dockedHeight(): number {
    return clampDockHeight(dockHeight ?? options.floatSize?.height ?? 240, window.innerHeight, min.height)
  }

  function save(): void {
    writePlacement(options.key, {
      mode,
      // An anchored window stores no position: one written now would be read back as a drag
      // next time and freeze it where this session's content size happened to put it.
      ...(anchored || !position ? {} : { x: position.x, y: position.y }),
      ...(options.floatSize && size ? { width: size.width, height: size.height } : {}),
      ...(dockHeight === undefined ? {} : { dockHeight }),
      collapsed
    })
  }

  function renderControls(): void {
    collapseButton.textContent = collapsed ? '▾' : '▴'
    collapseButton.title = collapsed ? 'Show the contents' : 'Roll up to the title bar'
    modeButton.textContent = mode === 'dock' ? '⇱' : '⇲'
    modeButton.title = mode === 'dock' ? 'Float this window over the chart' : 'Dock it below the chart'
  }

  function place(): void {
    root.dataset.mode = mode
    if (mode === 'dock') {
      host().add(root, options.order ?? 50)
      root.style.zIndex = ''
    } else {
      currentDockHost()?.remove(root)
      document.body.appendChild(root)
      root.style.zIndex = String(++topZ)
    }
    renderControls()
    reflow()
    layoutChanged()
    options.onResize?.()
  }

  function setMode(next: WindowMode): void {
    if (next === mode) return
    mode = next
    // A window floated for the first time has no remembered spot, so it opens at the default
    // one rather than wherever it last was as a docked strip.
    if (mode === 'float' && !position) anchored = true
    place()
    save()
    options.onModeChange?.(mode)
  }

  function setCollapsed(next: boolean): void {
    collapsed = next
    root.classList.toggle('is-collapsed', collapsed)
    renderControls()
    reflow()
    layoutChanged()
    save()
  }

  function setVisible(next: boolean): void {
    visible = next
    root.classList.toggle('is-hidden', !visible)
    currentDockHost()?.refresh()
    if (visible) reflow()
  }

  // -- dragging (and drag to dock / out of the dock) ---------------------------------------

  // The pointer is followed on the WINDOW, not through `setPointerCapture` on the title bar:
  // dragging a docked window out re-parents the card into `document.body`, and re-parenting
  // silently drops the capture -- after which `releasePointerCapture` throws, the drag never
  // ends, and the window is left stuck to the cursor. Window-level listeners gated on the
  // grab do not care where the element lives.
  let grab: { dx: number; dy: number; pointerId: number; moved: boolean } | null = null
  let dropping = false

  const dropIndicator = document.createElement('div')
  dropIndicator.className = 'wd-window-drop'

  function showDrop(on: boolean): void {
    if (on === dropping) return
    dropping = on
    if (on) {
      const box = bounds()
      dropIndicator.style.left = `${box.left}px`
      dropIndicator.style.top = `${box.bottom - DOCK_ZONE}px`
      dropIndicator.style.width = `${box.right - box.left}px`
      dropIndicator.style.height = `${DOCK_ZONE}px`
      document.body.appendChild(dropIndicator)
    } else {
      dropIndicator.remove()
    }
  }

  header.addEventListener('pointerdown', (event: PointerEvent) => {
    // The title bar carries controls of its own. A press that starts on one of them is that
    // control's, not a drag.
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, select, input, label, a')) return
    const rect = root.getBoundingClientRect()
    grab = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, pointerId: event.pointerId, moved: false }
    root.classList.add('is-dragging')
    event.preventDefault()
  })

  function onPointerMove(event: PointerEvent): void {
    if (resize) {
      onResizeMove(event)
      return
    }
    if (edgeGrab) {
      onEdgeMove(event)
      return
    }
    if (!grab || event.pointerId !== grab.pointerId) return
    if (!grab.moved) {
      grab.moved = true
      if (mode === 'dock') {
        // Dragging a docked window out floats it, under the pointer: the grab offset is kept
        // horizontally, but a docked window is page-wide, so the pointer would otherwise end
        // up somewhere unrelated on a much narrower card.
        const width = size?.width ?? root.offsetWidth
        grab.dx = Math.min(grab.dx, width - 40)
        setMode('float')
      }
      // After setMode: floating for the first time anchors the window to its default spot,
      // and this drag is the user overriding exactly that.
      anchored = false
    }
    const box = bounds()
    const current = { width: root.offsetWidth, height: root.offsetHeight }
    applyPosition(clampPosition({ x: event.clientX - grab.dx, y: event.clientY - grab.dy }, current, box))
    showDrop(inDropZone(event.clientY, box))
  }

  function onPointerUp(event: PointerEvent): void {
    if (resize) {
      onResizeEnd(event)
      return
    }
    if (edgeGrab) {
      onEdgeEnd(event)
      return
    }
    if (!grab || event.pointerId !== grab.pointerId) return
    const { moved } = grab
    grab = null
    root.classList.remove('is-dragging')
    const docking = dropping
    showDrop(false)
    if (!moved) return
    if (docking) setMode('dock')
    else save()
  }

  // -- resizing -----------------------------------------------------------------------------

  let resize: { pointerId: number; startX: number; startY: number; from: Size } | null = null
  // The docked column's height: dragged from the window's top edge, upward = taller.
  let edgeGrab: { pointerId: number; startY: number; from: number } | null = null

  corner.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || mode !== 'float') return
    resize = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: { width: root.offsetWidth, height: root.offsetHeight }
    }
    root.classList.add('is-resizing')
    event.preventDefault()
  })

  function onResizeMove(event: PointerEvent): void {
    if (!resize || event.pointerId !== resize.pointerId) return
    const origin = position ?? { x: root.offsetLeft, y: root.offsetTop }
    applySize(
      clampSize(
        {
          width: resize.from.width + (event.clientX - resize.startX),
          height: resize.from.height + (event.clientY - resize.startY)
        },
        origin,
        bounds(),
        min
      )
    )
  }

  function onResizeEnd(event: PointerEvent): void {
    if (!resize || event.pointerId !== resize.pointerId) return
    resize = null
    root.classList.remove('is-resizing')
    save()
  }

  edge.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || mode !== 'dock') return
    edgeGrab = { pointerId: event.pointerId, startY: event.clientY, from: dockedHeight() }
    root.classList.add('is-resizing')
    event.preventDefault()
  })

  function onEdgeMove(event: PointerEvent): void {
    if (!edgeGrab || event.pointerId !== edgeGrab.pointerId) return
    dockHeight = clampDockHeight(edgeGrab.from - (event.clientY - edgeGrab.startY), window.innerHeight, min.height)
    root.style.height = `${Math.round(dockHeight)}px`
    // The column just took height off the chart: anything floating re-clamps into what is left.
    layoutChanged()
    options.onResize?.()
  }

  function onEdgeEnd(event: PointerEvent): void {
    if (!edgeGrab || event.pointerId !== edgeGrab.pointerId) return
    edgeGrab = null
    root.classList.remove('is-resizing')
    save()
  }

  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerUp)

  // A floating window comes to the front when it is touched, so two of them never fight.
  root.addEventListener('pointerdown', () => {
    if (mode === 'float') root.style.zIndex = String(++topZ)
  })

  // -- staying inside --------------------------------------------------------------------------

  // The window's own size changes when a section opens; the bounds change when the dock
  // column grows below the chart or the browser is resized. Both can leave a floating window
  // hanging off an edge, so both re-clamp.
  const observer = new ResizeObserver(() => reflow())
  observer.observe(root)
  observer.observe(options.bounds)
  const onWindowResize = (): void => layoutChanged()
  window.addEventListener('resize', onWindowResize)
  reflows.add(reflow)

  place()

  return {
    element: root,
    header,
    titleSlot,
    actions,
    body,
    get mode(): WindowMode {
      return mode
    },
    get collapsed(): boolean {
      return collapsed
    },
    get visible(): boolean {
      return visible
    },
    setMode,
    setCollapsed,
    setVisible,
    reflow,
    dispose(): void {
      reflows.delete(reflow)
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
      showDrop(false)
      currentDockHost()?.remove(root)
      root.remove()
    }
  }
}

function iconButton(text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'kc-button kc-icon-button wd-window-control'
  b.textContent = text
  b.addEventListener('click', onClick)
  return b
}
