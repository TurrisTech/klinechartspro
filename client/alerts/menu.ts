// The right-click menu. Small enough to be generic, so the "create an alert at …" list and
// the "this alert" list are the same component with different rows -- there is one place
// that knows how a menu is placed, dismissed and keyboard-closed.
//
// Positioned `position: fixed` at the pointer and appended into the themed chart root, for
// the reason client/chartlayers/settings.ts documents: `.klinecharts-pro` clips its overflow
// and is where the `kc-*` tokens are defined.

export interface MenuItem {
  label: string
  /** Right-aligned secondary text — the price a row would create the alert at. */
  detail?: string
  danger?: boolean
  disabled?: boolean
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
  menu.className = 'kc-popover wd-alert-menu'
  menu.setAttribute('role', 'menu')

  if (options.header) {
    const header = document.createElement('div')
    header.className = 'kc-popover-header wd-alert-menu-header'
    header.textContent = options.header
    menu.appendChild(header)
  }

  for (const item of options.items) {
    const row = document.createElement('button')
    row.type = 'button'
    row.className = `wd-alert-menu-item${item.danger ? ' is-danger' : ''}`
    row.setAttribute('role', 'menuitem')
    row.disabled = item.disabled ?? false
    const label = document.createElement('span')
    label.className = 'wd-alert-menu-label'
    label.textContent = item.label
    row.appendChild(label)
    if (item.detail) {
      const detail = document.createElement('span')
      detail.className = 'wd-alert-menu-detail'
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

  function onOutside(event: MouseEvent): void {
    if (menu.contains(event.target as Node | null)) return
    close()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
  }

  // Deferred by a frame: the `contextmenu` event that opened this is still propagating, and
  // on some platforms a `mousedown` follows it immediately.
  requestAnimationFrame(() => {
    if (closed) return
    document.addEventListener('mousedown', onOutside, true)
    document.addEventListener('contextmenu', onOutside, true)
  })
  document.addEventListener('keydown', onKey)

  function close(): void {
    if (closed) return
    closed = true
    document.removeEventListener('mousedown', onOutside, true)
    document.removeEventListener('contextmenu', onOutside, true)
    document.removeEventListener('keydown', onKey)
    menu.remove()
    options.onClose?.()
  }

  return { close }
}
