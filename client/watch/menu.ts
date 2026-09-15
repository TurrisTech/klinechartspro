// The right-click menu. Small enough to be generic, so the "watch this price" list and
// the "this watch" list are the same component with different rows -- there is one place
// that knows how a menu is placed, dismissed and keyboard-closed.
//
// Positioned `position: fixed` at the pointer and appended into the themed chart root, for
// the reason client/chartlayers/settings.ts documents: `.klinecharts-pro` clips its overflow
// and is where the `kc-*` tokens are defined.

export interface MenuItem {
  label: string
  /** Right-aligned secondary text — the price a row would create the watch at. */
  detail?: string
  danger?: boolean
  disabled?: boolean
  /** Draw a rule above this row — a row that is not part of the list above it. */
  separator?: boolean
  onSelect(): void
}

export interface ContextMenuOptions {
  /** Viewport coordinates — an event's clientX/clientY. */
  x: number
  y: number
  header?: string
  items: MenuItem[]
  /** The element whose themed root the menu is appended into. */
  host: HTMLElement
  onClose?: () => void
}

export interface ContextMenu {
  close(): void
}

const EDGE_MARGIN = 8

export function openContextMenu(options: ContextMenuOptions): ContextMenu {
  const root = options.host.closest('.klinecharts-pro') ?? document.body
  const menu = document.createElement('div')
  menu.className = 'kc-popover wd-watch-menu'
  menu.setAttribute('role', 'menu')

  if (options.header) {
    const header = document.createElement('div')
    header.className = 'kc-popover-header wd-watch-menu-header'
    header.textContent = options.header
    menu.appendChild(header)
  }

  for (const item of options.items) {
    if (item.separator && menu.childElementCount > 0) {
      const rule = document.createElement('div')
      rule.className = 'wd-watch-menu-separator'
      rule.setAttribute('role', 'separator')
      menu.appendChild(rule)
    }
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `wd-watch-menu-item${item.danger ? ' is-danger' : ''}`
    row.setAttribute('role', 'menuitem')
    row.disabled = item.disabled ?? false
    const label = document.createElement('span')
    label.className = 'wd-watch-menu-label'
    label.textContent = item.label
    row.appendChild(label)
    if (item.detail) {
      const detail = document.createElement('span')
      detail.className = 'wd-watch-menu-detail'
      detail.textContent = item.detail
      row.appendChild(detail)
    }
    row.addEventListener('click', () => {
      close()
      item.onSelect()
    })
    menu.appendChild(row)
  }

  menu.style.position = 'fixed'
  menu.style.visibility = 'hidden'
  root.appendChild(menu)
  // Measured, then placed: the row count is not known until it is in the DOM, and a menu
  // opened near the bottom or right edge has to flip rather than be clipped.
  const rect = menu.getBoundingClientRect()
  const left = Math.min(options.x, window.innerWidth - rect.width - EDGE_MARGIN)
  const top = Math.min(options.y, window.innerHeight - rect.height - EDGE_MARGIN)
  menu.style.left = `${Math.max(EDGE_MARGIN, left)}px`
  menu.style.top = `${Math.max(EDGE_MARGIN, top)}px`
  menu.style.visibility = ''

  let closed = false

  function onOutside(event: Event): void {
    if (menu.contains(event.target as Node | null)) return
    close()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
  }

  // Deferred by a frame: the `contextmenu` event that opened this is still propagating, and
  // on some platforms a `mousedown` follows it immediately. `pointerdown`, not `mousedown`: a
  // touch screen delivers compatibility mouse events only to targets it thinks are clickable,
  // so a tap on the bare chart would never dismiss a menu a long-press opened.
  requestAnimationFrame(() => {
    if (closed) return
    document.addEventListener('pointerdown', onOutside, true)
    document.addEventListener('contextmenu', onOutside, true)
  })
  document.addEventListener('keydown', onKey)

  function close(): void {
    if (closed) return
    closed = true
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('contextmenu', onOutside, true)
    document.removeEventListener('keydown', onKey)
    menu.remove()
    options.onClose?.()
  }

  return { close }
}

const FLASH_MS = 1600

/** A one-line confirmation near the bottom of `host` (a copy landed, or did not), gone after
 * FLASH_MS. Appended into the themed chart root like the menu. One at a time: a second
 * replaces the first rather than stacking over it. */
export function flash(host: HTMLElement, text: string): void {
  const root = host.closest('.klinecharts-pro') ?? document.body
  root.querySelector('.wd-watch-flash')?.remove()
  const note = document.createElement('div')
  note.className = 'wd-watch-flash'
  note.setAttribute('role', 'status')
  note.textContent = text
  const rect = host.getBoundingClientRect()
  note.style.left = `${Math.round(rect.left + rect.width / 2)}px`
  note.style.top = `${Math.round(rect.bottom - 16)}px`
  root.appendChild(note)
  setTimeout(() => note.remove(), FLASH_MS)
}
