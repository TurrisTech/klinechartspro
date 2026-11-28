// ANCHORED POPOVERS: a small panel hanging under the toolbar button that opens it -- the
// workspace switcher (client/workspaces/menu.ts) and the Revert confirmation beside it
// (client/workspaces/save.ts). The button toggles it; a press anywhere else, or Escape, closes it.
//
// `position: fixed` off the button's viewport rect, so the panel escapes `.klinecharts-pro`'s
// `overflow: hidden`, and appended INSIDE `.klinecharts-pro` (the element src/KLineChartPro.ts puts
// the `dark` class on), so it still resolves the chart's theme tokens. See the header of
// client/plugins/settings/settings.ts for why client/ builds its popovers by hand rather than through
// the library's bits-ui chain.
//
// The other hand-built popovers close the same way in outline but differ in when and to what they
// listen, so they keep their own code: the layer settings panel waits a whole task before
// listening (a control drawn on a canvas opens it), the bell's dropdown listens in the capture
// phase from the next frame and follows a window resize, and the watch menu and the price-alert
// card listen for `pointerdown` in the capture phase (a tap on the bare chart sends no mouse
// events).

/** The gap between the button and the panel, and the margin the panel keeps from the window's
 * edges, in CSS px. */
const GAP = 6
const MARGIN = 8

export interface AnchoredPopoverOptions {
  /** Builds the panel afresh on every open; it is mounted, placed and listening afterwards. */
  build: () => HTMLElement
  /** After it has opened: where the caller moves the focus into it. */
  onOpen?: (panel: HTMLElement) => void
  /** After it has left the document, however it was closed. */
  onClose?: () => void
}

export interface AnchoredPopover {
  /** Closes it if it is open. */
  close(): void
}

/** Makes `anchor` the toggle of a popover. The anchor's `aria-expanded` follows it; its
 * `aria-haspopup` is the caller's. */
export function anchoredPopover(anchor: HTMLElement, options: AnchoredPopoverOptions): AnchoredPopover {
  let panel: HTMLElement | null = null

  // A press on the anchor is not outside: its own click is what toggles the panel.
  function onOutside(event: MouseEvent): void {
    if (!panel) return
    const target = event.target as Node
    if (!panel.contains(target) && !anchor.contains(target)) close()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
  }

  function close(): void {
    if (!panel) return
    document.removeEventListener('mousedown', onOutside)
    document.removeEventListener('keydown', onKeydown)
    panel.remove()
    panel = null
    options.onClose?.()
    anchor.setAttribute('aria-expanded', 'false')
  }

  function open(): void {
    const node = options.build()
    panel = node
    const mountPoint = anchor.closest('.klinecharts-pro') ?? document.body
    mountPoint.appendChild(node)
    const rect = anchor.getBoundingClientRect()
    node.style.position = 'fixed'
    node.style.top = `${rect.bottom + GAP}px`
    const maxLeft = window.innerWidth - node.offsetWidth - MARGIN
    node.style.left = `${Math.max(MARGIN, Math.min(rect.left, maxLeft))}px`
    // Deferred one microtask so the click that opened the panel doesn't immediately close it.
    queueMicrotask(() => document.addEventListener('mousedown', onOutside))
    document.addEventListener('keydown', onKeydown)
    anchor.setAttribute('aria-expanded', 'true')
    options.onOpen?.(node)
  }

  anchor.addEventListener('click', () => {
    if (panel) close()
    else open()
  })

  return { close }
}
