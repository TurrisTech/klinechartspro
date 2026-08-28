import type { NotificationCenter } from './center'
import type { Notification } from './types'

// The Notification Center's view: a bell and a caret in the top rail's right-hand slot
// (src/types.ts ChartProSlot 'toolbar-right'), and the dropdown the caret opens.
//
//   bell    blinks orange while anything is unseen; clicking it acknowledges everything,
//           which is the ONLY thing that stops the blink. It does not open the list --
//           "I've seen that something arrived" and "show me what" are different intents,
//           and the prompt this was built from separates them.
//   caret   opens/closes the list: the most recent notifications, newest first, with
//           Clear all beneath them and a dismiss on each row.
//
// Plain DOM in the house style (`kc-*` tokens, `wd-*` classes), like every other control in
// client/ -- see the note at the top of client/chartlayers/settings.ts for why this is not
// Svelte. It reads a NotificationCenter and writes nothing else: no producer is imported
// here, and the panel re-renders from `subscribe`, never from a local copy of the list.

const PANEL_WIDTH = 320
const PANEL_MARGIN = 8

export interface NotificationBell {
  readonly element: HTMLElement
  /** Close the panel without unmounting — a workspace switch, a teardown. */
  close(): void
  dispose(): void
}

export function createNotificationBell(center: NotificationCenter): NotificationBell {
  const group = el('div', 'wd-notify')

  const bell = document.createElement('button')
  bell.type = 'button'
  bell.className = 'kc-button wd-notify-bell'
  bell.setAttribute('aria-label', 'Notifications')
  const icon = el('span', 'wd-notify-icon')
  icon.textContent = '\u{1F514}'
  icon.setAttribute('aria-hidden', 'true')
  const badge = el('span', 'wd-notify-badge')
  bell.append(icon, badge)

  const caret = document.createElement('button')
  caret.type = 'button'
  caret.className = 'kc-button wd-notify-caret'
  caret.textContent = '▾'
  caret.setAttribute('aria-label', 'Recent notifications')
  caret.setAttribute('aria-expanded', 'false')

  group.append(bell, caret)

  let panel: HTMLElement | null = null
  let rows: Notification[] = []

  // Subscribed before anything renders, and the ONLY path that draws: `notify`, `clear` and
  // `markAllSeen` all land here, so the badge, the blink and an open panel can never
  // disagree about the list.
  const unsubscribe = center.subscribe((list) => {
    rows = list
    renderButton()
    if (panel) renderPanel(panel)
  })

  function renderButton(): void {
    const unseen = rows.reduce((count, row) => count + (row.seen ? 0 : 1), 0)
    // The class carries the animation; the count is what the animation is ABOUT, so both
    // are driven from the same read rather than toggled at their own call sites.
    group.classList.toggle('is-blinking', unseen > 0)
    badge.textContent = unseen > 0 ? (unseen > 99 ? '99+' : String(unseen)) : ''
    badge.hidden = unseen === 0
    bell.title = unseen > 0 ? `${unseen} unread notification${unseen === 1 ? '' : 's'}` : 'Notifications'
    caret.title = rows.length > 0 ? `${rows.length} recent` : 'No notifications yet'
  }

  bell.addEventListener('click', () => {
    center.markAllSeen()
  })

  caret.addEventListener('click', () => {
    if (panel) close()
    else open()
  })

  function open(): void {
    // Appended into the themed chart root rather than the slot itself, for the reason
    // client/chartlayers/settings.ts documents: `.klinecharts-pro` clips its overflow, and
    // the `--popover`/`--border` tokens are defined on it.
    const host = group.closest('.klinecharts-pro') ?? document.body
    panel = el('div', 'kc-popover wd-notify-panel')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-label', 'Notifications')
    renderPanel(panel)
    host.appendChild(panel)
    place(panel)
    caret.setAttribute('aria-expanded', 'true')
    caret.classList.add('is-active')
    // Deferred to the next frame: this very click is still propagating, and an immediate
    // listener would see it and close the panel it just opened.
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', onOutside, true)
    })
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onReposition)
  }

  function close(): void {
    if (!panel) return
    panel.remove()
    panel = null
    caret.setAttribute('aria-expanded', 'false')
    caret.classList.remove('is-active')
    document.removeEventListener('mousedown', onOutside, true)
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('resize', onReposition)
  }

  function onOutside(event: MouseEvent): void {
    const target = event.target as Node | null
    if (!target) return
    if (panel?.contains(target) || group.contains(target)) return
    close()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
  }

  function onReposition(): void {
    if (panel) place(panel)
  }

  function place(node: HTMLElement): void {
    const rect = caret.getBoundingClientRect()
    node.style.position = 'fixed'
    node.style.top = `${rect.bottom + 4}px`
    // Right-aligned to the caret, then clamped: the bell sits at the rail's right edge, so
    // a left-aligned panel would hang off the viewport at every window width.
    const left = Math.min(
      Math.max(PANEL_MARGIN, rect.right - PANEL_WIDTH),
      Math.max(PANEL_MARGIN, window.innerWidth - PANEL_WIDTH - PANEL_MARGIN)
    )
    node.style.left = `${left}px`
    node.style.width = `${PANEL_WIDTH}px`
  }

  function renderPanel(node: HTMLElement): void {
    node.innerHTML = ''

    const header = el('div', 'kc-popover-header wd-notify-header')
    const title = el('span', '')
    title.textContent = 'Notifications'
    header.appendChild(title)
    node.appendChild(header)

    const list = el('div', 'wd-notify-list')
    if (rows.length === 0) {
      const empty = el('div', 'wd-notify-empty')
      empty.textContent = 'Nothing yet.'
      list.appendChild(empty)
    }
    for (const row of rows) list.appendChild(renderRow(row))
    node.appendChild(list)

    const footer = el('div', 'wd-notify-footer')
    const clear = button('kc-button kc-button-outline wd-notify-clear', 'Clear all', () => {
      center.clear()
    })
    clear.disabled = rows.length === 0
    footer.appendChild(clear)
    node.appendChild(footer)
  }

  function renderRow(row: Notification): HTMLElement {
    const item = el('div', `wd-notify-row is-${row.level}${row.seen ? '' : ' is-unseen'}`)

    const head = el('div', 'wd-notify-row-head')
    const rowTitle = el('span', 'wd-notify-row-title')
    rowTitle.textContent = row.title
    const when = el('span', 'wd-notify-row-time')
    when.textContent = relativeTime(row.at)
    when.title = new Date(row.at).toLocaleString()
    head.append(rowTitle, when)
    item.appendChild(head)

    if (row.body) {
      const body = el('div', 'wd-notify-row-body')
      body.textContent = row.body
      item.appendChild(body)
    }

    if (row.source) {
      const tag = el('span', 'wd-notify-row-source')
      tag.textContent = row.source
      item.appendChild(tag)
    }

    const dismiss = button('wd-notify-dismiss', '×', () => center.remove(row.id))
    dismiss.setAttribute('aria-label', `Dismiss: ${row.title}`)
    dismiss.title = 'Dismiss'
    item.appendChild(dismiss)
    return item
  }

  renderButton()

  return {
    element: group,
    close,
    dispose(): void {
      close()
      unsubscribe()
      group.remove()
    }
  }
}

/** "just now" / "6m ago" / "3h ago" / "2d ago". Coarse on purpose: the exact instant is in
 * the row's `title`, and a notification list is read for order, not for timing. */
export function relativeTime(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 45) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.textContent = text
  node.addEventListener('click', onClick)
  return node
}
