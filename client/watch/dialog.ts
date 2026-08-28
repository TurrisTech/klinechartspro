import { PRICE_DIRECTIONS, type PriceDirection } from './types'

// The one dialog the feature has: set a price, say which way, then apply. Both flows the
// chart offers end here -- picking a price from the right-click menu creates a watch, and
// dropping a dragged line moves one -- so the price is editable before anything is committed,
// in exactly one place, with one set of validation rules.
//
// Modal, `position: fixed` over the page, carrying the chart's theme class: the `kc-*` design
// tokens are defined on `.klinecharts-pro.dark`, and a card appended to <body> resolves them
// only if it carries that class itself (client/replay/controls.ts's start dialog has the same
// note). Plain DOM, like every control in client/.

export interface WatchDialogResult {
  price: number
  direction: PriceDirection
  note?: string
  /** Keep watching after it fires, instead of stopping at the first hit. */
  repeat: boolean
}

export interface WatchDialogOptions {
  title: string
  /** `EURUSD` — shown so a wall of panes cannot leave you guessing which one this is. */
  instrument: string
  /** Pre-filled, and where the number input's step comes from. */
  price: number
  /** Instrument display precision (SymbolInfo.pricePrecision), or undefined for the input's
   * own default. Governs both the seeded text and the step. */
  precision?: number
  note?: string
  direction?: PriceDirection
  repeat?: boolean
  submitLabel: string
  /** The market price now, shown as context ("market 1.16240"). Omitted when unknown. */
  market?: number
  /** A destructive third button — "Delete" on an existing watch. Absent when creating. */
  onDelete?: () => void
  onSubmit: (result: WatchDialogResult) => void
  /** Fires when the dialog closes WITHOUT submitting, however it closed. A drag flow uses it
   * to put the line back where it was. */
  onCancel?: () => void
}

export interface WatchDialog {
  close(): void
}

export function openWatchDialog(options: WatchDialogOptions): WatchDialog {
  const precision = options.precision ?? 5
  const theme = document.querySelector('.klinecharts-pro.dark') ? 'dark' : ''

  const backdrop = el('div', `wd-watch-backdrop ${theme}`.trim())
  const card = el('div', 'wd-watch-dialog')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', options.title)
  backdrop.appendChild(card)

  const title = el('div', 'wd-watch-dialog-title')
  title.textContent = options.title
  card.appendChild(title)

  const info = el('div', 'wd-watch-dialog-info')
  info.textContent =
    options.market !== undefined
      ? `${options.instrument} · market ${options.market.toFixed(precision)}`
      : options.instrument
  card.appendChild(info)

  const priceField = field('Price')
  const priceInput = document.createElement('input')
  priceInput.type = 'number'
  priceInput.className = 'kc-input wd-watch-input'
  priceInput.step = String(10 ** -precision)
  priceInput.value = options.price.toFixed(precision)
  priceField.appendChild(priceInput)
  card.appendChild(priceField)

  // The default is "either way" and the server decides the side from where the market is
  // when the watch is armed -- so the usual case needs no choice at all, and the two
  // one-directional options are there for when the direction is the point.
  const directionField = field('Fires when price')
  const direction = document.createElement('select')
  direction.className = 'kc-input wd-watch-input'
  for (const option of PRICE_DIRECTIONS) {
    const node = document.createElement('option')
    node.value = option.value
    node.textContent = option.label
    node.selected = option.value === (options.direction ?? 'crosses')
    direction.appendChild(node)
  }
  directionField.appendChild(direction)
  card.appendChild(directionField)

  const noteField = field('Note (optional)')
  const noteInput = document.createElement('input')
  noteInput.type = 'text'
  noteInput.className = 'kc-input wd-watch-input'
  noteInput.maxLength = 120
  noteInput.value = options.note ?? ''
  noteField.appendChild(noteInput)
  card.appendChild(noteField)

  const repeatRow = el('label', 'wd-watch-check')
  const repeat = document.createElement('input')
  repeat.type = 'checkbox'
  repeat.checked = options.repeat ?? false
  const repeatText = el('span', '')
  repeatText.textContent = 'Keep watching after it fires'
  repeatRow.append(repeat, repeatText)
  card.appendChild(repeatRow)

  const error = el('div', 'kc-field-error wd-watch-dialog-error')
  card.appendChild(error)

  const actions = el('div', 'wd-watch-dialog-actions')
  if (options.onDelete) {
    const remove = button('kc-button wd-watch-delete', 'Delete', () => {
      // Submitted, not cancelled: the caller asked for this, so a drag flow must not also
      // revert the line it is about to remove.
      submitted = true
      close()
      options.onDelete?.()
    })
    actions.appendChild(remove)
  }
  actions.appendChild(el('span', 'wd-watch-dialog-spacer'))
  actions.appendChild(button('kc-button kc-button-outline', 'Cancel', () => close()))
  actions.appendChild(button('kc-button kc-button-primary', options.submitLabel, () => apply()))
  card.appendChild(actions)

  let submitted = false

  function apply(): void {
    const price = Number(priceInput.value)
    if (!Number.isFinite(price) || price <= 0) {
      error.textContent = 'Enter a price above zero'
      priceInput.focus()
      return
    }
    submitted = true
    close()
    const note = noteInput.value.trim()
    options.onSubmit({
      price,
      direction: direction.value as PriceDirection,
      note: note === '' ? undefined : note,
      repeat: repeat.checked
    })
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
    // Enter from either text field applies; not from the select, where Enter opens it.
    if (event.key === 'Enter' && (event.target === priceInput || event.target === noteInput)) apply()
  }

  document.addEventListener('keydown', onKey)
  backdrop.addEventListener('mousedown', (event) => {
    if (event.target === backdrop) close()
  })
  document.body.appendChild(backdrop)
  priceInput.focus()
  priceInput.select()

  function close(): void {
    document.removeEventListener('keydown', onKey)
    backdrop.remove()
    if (!submitted) options.onCancel?.()
  }

  return { close }
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

function field(label: string): HTMLElement {
  const wrap = el('label', 'wd-watch-field')
  const text = el('span', 'wd-watch-label')
  text.textContent = label
  wrap.appendChild(text)
  return wrap
}
