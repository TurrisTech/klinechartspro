// The small card a price alert opens beside its bell: the buffer in pips, the zone it makes,
// whether it has fired, and Remove. Opened by a click on an enabled line or its bell, and at
// once by the click that enables one, so the buffer can be set while the line is in view.
//
// A popover rather than a modal: it belongs to one line on one pane and should not hide the
// chart it describes. Appended into the themed chart root and `position: fixed`, for the reason
// client/watch/menu.ts gives (`.klinecharts-pro` clips its overflow and defines the `kc-*`
// tokens). Plain DOM, like every control in client/.

export interface PriceAlertEditorOptions {
  /** An element inside the pane, whose themed root the card is appended into. */
  host: HTMLElement
  /** The bell, in viewport coordinates: the card hangs below it, right-aligned, or above it
   * when there is no room below. Null centres it on the host. */
  anchor: { x: number; y: number } | null
  /** The alert's name: the instrument, what the line is, and its price. */
  title: string
  /** `pips`, or `ticks` for an instrument not priced in pips. */
  unitLabel: string
  pips: number
  /** Whether it has fired, and when. */
  status: string
  /** The zone a buffer makes, as text: shown under the input while it is typed. */
  describe(pips: number): string
  /** A buffer typed but not yet applied: the chart shows the zone it would make. */
  onPreview(pips: number): void
  /** Apply a buffer -- on Enter, on leaving the box, on Done, and on closing with one typed. */
  onCommit(pips: number): void
  onRemove(): void
  /** However it closed. */
  onClose(): void
}

export interface PriceAlertEditor {
  close(): void
}

const EDGE_MARGIN = 8
const ANCHOR_GAP = 12

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A buffer the box can hold: a finite number, not negative. */
function parsePips(raw: string): number | null {
  if (raw.trim() === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

export function openPriceAlertEditor(options: PriceAlertEditorOptions): PriceAlertEditor {
  const root = options.host.closest('.klinecharts-pro') ?? document.body
  const card = el('div', 'kc-popover wd-price-alert')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-label', `Alert on ${options.title}`)

  card.appendChild(el('div', 'kc-popover-header wd-price-alert-title', options.title))

  const row = el('label', 'wd-price-alert-row')
  row.appendChild(el('span', 'wd-price-alert-label', 'Alert zone ±'))
  const input = el('input', 'kc-input wd-price-alert-input')
  input.type = 'number'
  input.min = '0'
  input.step = '0.5'
  input.inputMode = 'decimal'
  input.value = String(options.pips)
  row.appendChild(input)
  row.appendChild(el('span', 'wd-price-alert-unit', options.unitLabel))
  card.appendChild(row)

  const zone = el('div', 'wd-price-alert-zone', options.describe(options.pips))
  card.appendChild(zone)
  card.appendChild(el('div', 'wd-price-alert-status', options.status))

  const actions = el('div', 'wd-price-alert-actions')
  const remove = el('button', 'kc-button wd-price-alert-remove', 'Remove alert')
  remove.type = 'button'
  const done = el('button', 'kc-button kc-button-primary', 'Done')
  done.type = 'button'
  actions.append(remove, el('span', 'wd-price-alert-spacer'), done)
  card.appendChild(actions)

  let committed = options.pips
  let closed = false

  const typed = (): number | null => parsePips(input.value)

  const commit = (): void => {
    const pips = typed()
    if (pips === null || pips === committed) return
    committed = pips
    options.onCommit(pips)
  }

  input.addEventListener('input', () => {
    const pips = typed()
    input.classList.toggle('is-invalid', pips === null)
    if (pips === null) return
    zone.textContent = options.describe(pips)
    options.onPreview(pips)
  })
  input.addEventListener('change', commit)
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      commit()
      close()
    }
  })
  remove.addEventListener('click', () => {
    options.onRemove()
    close()
  })
  done.addEventListener('click', () => {
    commit()
    close()
  })

  card.style.position = 'fixed'
  card.style.visibility = 'hidden'
  root.appendChild(card)
  // Measured, then placed, as the right-click menu is: below the bell and right-aligned to it,
  // flipped above when the pane's foot is too close, and never off the screen.
  const rect = card.getBoundingClientRect()
  const host = options.host.getBoundingClientRect()
  const anchor = options.anchor ?? { x: host.left + (host.width + rect.width) / 2, y: host.top + host.height / 2 }
  let top = anchor.y + ANCHOR_GAP
  if (top + rect.height > window.innerHeight - EDGE_MARGIN) top = anchor.y - ANCHOR_GAP - rect.height
  const left = Math.min(anchor.x - rect.width, window.innerWidth - rect.width - EDGE_MARGIN)
  card.style.left = `${Math.max(EDGE_MARGIN, left)}px`
  card.style.top = `${Math.max(EDGE_MARGIN, Math.min(top, window.innerHeight - rect.height - EDGE_MARGIN))}px`
  card.style.visibility = ''
  input.focus()
  input.select()

  // A click elsewhere closes it, keeping what was typed: leaving the box is how the browser
  // applies a value, and the box is removed before it could say so itself.
  function onOutside(event: Event): void {
    if (card.contains(event.target as Node | null)) return
    commit()
    close()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
  }

  // Deferred a frame: the click that opened this is still on its way through the document.
  requestAnimationFrame(() => {
    if (closed) return
    document.addEventListener('pointerdown', onOutside, true)
  })
  document.addEventListener('keydown', onKey)

  function close(): void {
    if (closed) return
    closed = true
    document.removeEventListener('pointerdown', onOutside, true)
    document.removeEventListener('keydown', onKey)
    card.remove()
    options.onClose()
  }

  return { close }
}
