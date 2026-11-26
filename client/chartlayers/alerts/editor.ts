// The small card a price alert opens beside its bell: the buffer in pips, the zone it makes,
// "Make default" for that buffer, whether it has fired, and Remove. Opened by a click on the
// bell; a click on the line itself steps its alert round off, every time, once (view.ts).
//
// Its foot removes many at once (user, 2026-11-24: "an option to remove all levels alerts and
// all stale levels alerts"): every alert of the layer on the instrument, or the stale ones --
// those armed once that have fired (user, 2026-11-26: "make fired once alerts count as stale
// too"), and those whose line could no longer have one, a level spent since. Remove all asks
// first, in the card; Remove stale says how many it will take and does not.
//
// A popover rather than a modal: it belongs to one line on one pane and should not hide the
// chart it describes. Appended into the themed chart root and `position: fixed`, for the reason
// client/watch/menu.ts gives (`.klinecharts-pro` clips its overflow and defines the `kc-*`
// tokens). Plain DOM, like every control in client/.

interface PriceAlertEditorOptions {
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
  /** What a new alert is given on this pane, shown beside "Make default". */
  defaultPips: number
  /** Make a buffer the pane's default for new alerts. Absent: no such control. */
  onMakeDefault?(pips: number): void
  /** Whether it has fired, and when. */
  status: string
  /** The zone a buffer makes, as text: shown under the input while it is typed. */
  describe(pips: number): string
  /** A buffer typed but not yet applied: the chart shows the zone it would make. */
  onPreview(pips: number): void
  /** Apply a buffer -- on Enter, on leaving the box, on Done, and on closing with one typed. */
  onCommit(pips: number): void
  onRemove(): void
  /** The foot's removal of many at once. Absent: no foot. */
  bulk?: PriceAlertBulk
  /** However it closed. */
  onClose(): void
}

export interface PriceAlertBulk {
  /** What they are and where: `Levels alerts on EURUSD`. */
  title: string
  /** How many there are, this one among them. */
  count: number
  /** How many of them are stale, once known; null when it could not be told. Absent: no
   * Remove stale. */
  stale?: Promise<number | null>
  onRemoveStale(): void
  onRemoveAll(): void
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

/** The card's foot: how many alerts of the kind there are on the instrument, Remove stale and
 * Remove all. Either closes the card once pressed -- the foot of the pane says what went. */
function bulkFoot(bulk: PriceAlertBulk, close: () => void): HTMLElement {
  const foot = el('div', 'wd-price-alert-bulk')
  const summary = el('div', 'wd-price-alert-bulk-summary', `${bulk.title}: ${bulk.count}`)
  const row = el('div', 'wd-price-alert-bulk-actions')
  const stale = el('button', 'kc-button wd-price-alert-remove-stale')
  stale.type = 'button'
  const all = el('button', 'kc-button wd-price-alert-remove-all', `Remove all (${bulk.count})`)
  all.type = 'button'
  if (bulk.stale) row.appendChild(stale)
  row.appendChild(all)
  foot.append(summary, row)

  // Stale is asked of the server as the card opens; until it answers the button waits.
  let staleCount: number | null = null
  const showStale = (text: string, title: string, enabled: boolean): void => {
    stale.textContent = text
    stale.title = title
    stale.disabled = !enabled
  }
  showStale('Checking for stale…', 'Asking which of them are stale', false)
  void bulk.stale?.then((count) => {
    staleCount = count
    if (count === null) showStale('Stale: could not check', 'Which are stale could not be read; try again later', false)
    else if (count === 0) showStale('None stale', 'None has fired once and finished, and every one is on a line still live', false)
    else showStale(`Remove stale (${count})`, `Remove the ${count} stale ${count === 1 ? 'alert' : 'alerts'}: fired once and done, or on a line no longer live`, true)
  })
  stale.addEventListener('click', () => {
    if (!staleCount) return
    bulk.onRemoveStale()
    close()
  })

  // Remove all asks first, in place: the row becomes the question, its two answers under it.
  all.addEventListener('click', () => {
    const ask = el('div', 'wd-price-alert-bulk-confirm')
    const answers = el('div', 'wd-price-alert-bulk-actions')
    const no = el('button', 'kc-button', 'Cancel')
    no.type = 'button'
    const yes = el('button', 'kc-button wd-price-alert-remove-all-confirm', `Remove ${bulk.count}`)
    yes.type = 'button'
    answers.append(el('span', 'wd-price-alert-spacer'), no, yes)
    const question = bulk.count === 1 ? 'Remove the 1 alert?' : `Remove all ${bulk.count} alerts?`
    ask.append(el('div', 'wd-price-alert-bulk-question', question), answers)
    row.replaceWith(ask)
    no.addEventListener('click', () => ask.replaceWith(row))
    yes.addEventListener('click', () => {
      bulk.onRemoveAll()
      close()
    })
    yes.focus()
  })
  return foot
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

  // The pane's default for a new alert, and the control that makes the buffer in the box it.
  // Disabled while the box already holds the default, so a press always changes something.
  let defaultPips = options.defaultPips
  const defaultText = el('span', 'wd-price-alert-default-text')
  const makeDefault = el('button', 'kc-button wd-price-alert-make-default', 'Make default')
  makeDefault.type = 'button'
  const showDefault = (): void => {
    defaultText.textContent = `New alerts: ${defaultPips} ${options.unitLabel} each side`
    const typed = parsePips(input.value)
    makeDefault.disabled = typed === null || typed === defaultPips
  }
  if (options.onMakeDefault) {
    const row = el('div', 'wd-price-alert-default')
    row.append(defaultText, makeDefault)
    card.appendChild(row)
    showDefault()
  }
  card.appendChild(el('div', 'wd-price-alert-status', options.status))

  const actions = el('div', 'wd-price-alert-actions')
  const remove = el('button', 'kc-button wd-price-alert-remove', 'Remove alert')
  remove.type = 'button'
  const done = el('button', 'kc-button kc-button-primary', 'Done')
  done.type = 'button'
  actions.append(remove, el('span', 'wd-price-alert-spacer'), done)
  card.appendChild(actions)
  if (options.bulk) card.appendChild(bulkFoot(options.bulk, () => close()))

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
    showDefault()
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
  makeDefault.addEventListener('click', () => {
    const pips = typed()
    if (pips === null || !options.onMakeDefault) return
    // The buffer in the box is this alert's too: a default it does not have itself would be a
    // strange thing to have just pressed.
    commit()
    defaultPips = pips
    options.onMakeDefault(pips)
    showDefault()
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
