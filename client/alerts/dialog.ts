// The one dialog the feature has: edit a price, then apply it. Both flows the prompt asks
// for end here -- picking a price from the right-click menu opens it to CREATE, and dropping
// a dragged line opens it to MOVE -- so the price is editable before anything is committed,
// in exactly one place, with one set of validation rules.
//
// Modal, `position: fixed` over the page, carrying the chart's theme class: the `kc-*` design
// tokens are defined on `.klinecharts-pro.dark`, and a card appended to <body> resolves them
// only if it carries that class itself (client/replay/controls.ts's start dialog has the same
// note). Plain DOM, like every control in client/.

export interface AlertDialogOptions {
  title: string
  /** `EURUSD` — shown so a wall of panes cannot leave you guessing which one this is. */
  instrument: string
  /** Pre-filled, and where the number input's step comes from. */
  price: number
  /** Instrument display precision (SymbolInfo.pricePrecision), or undefined for the input's
   * own default. Governs both the seeded text and the step. */
  precision?: number
  note?: string
  submitLabel: string
  /** The market price now, shown as context ("market 1.16240"). Omitted when unknown. */
  market?: number
  /** A destructive third button — "Delete" on an existing alert. Absent when creating. */
  onDelete?: () => void
  onSubmit: (result: { price: number; note?: string }) => void
  /** Fires when the dialog closes WITHOUT submitting, however it closed. A drag flow uses it
   * to put the line back where it was. */
  onCancel?: () => void
}

export interface AlertDialog {
  close(): void
}

export function openAlertDialog(options: AlertDialogOptions): AlertDialog {
  const precision = options.precision ?? 5
  const theme = document.querySelector('.klinecharts-pro.dark') ? 'dark' : ''

  const backdrop = el('div', `wd-alert-backdrop ${theme}`.trim())
  const card = el('div', 'wd-alert-dialog')
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')
  card.setAttribute('aria-label', options.title)
  backdrop.appendChild(card)

  const title = el('div', 'wd-alert-dialog-title')
  title.textContent = options.title
  card.appendChild(title)

  const info = el('div', 'wd-alert-dialog-info')
  info.textContent =
    options.market !== undefined
      ? `${options.instrument} · market ${options.market.toFixed(precision)}`
      : options.instrument
  card.appendChild(info)

  const priceField = field('Price')
  const priceInput = document.createElement('input')
  priceInput.type = 'number'
  priceInput.className = 'kc-input wd-alert-input'
  priceInput.step = String(10 ** -precision)
  priceInput.value = options.price.toFixed(precision)
  priceField.appendChild(priceInput)
  card.appendChild(priceField)

  const noteField = field('Note (optional)')
  const noteInput = document.createElement('input')
  noteInput.type = 'text'
  noteInput.className = 'kc-input wd-alert-input'
  noteInput.maxLength = 120
  noteInput.value = options.note ?? ''
  noteField.appendChild(noteInput)
  card.appendChild(noteField)

  const error = el('div', 'kc-field-error wd-alert-dialog-error')
  card.appendChild(error)

  const actions = el('div', 'wd-alert-dialog-actions')
  if (options.onDelete) {
    const remove = button('kc-button wd-alert-delete', 'Delete', () => {
      // Submitted, not cancelled: the caller asked for this, so a drag flow must not also
      // revert the line it is about to remove.
      submitted = true
      close()
      options.onDelete?.()
    })
    actions.appendChild(remove)
  }
  const spacer = el('span', 'wd-alert-dialog-spacer')
  actions.appendChild(spacer)
  actions.appendChild(button('kc-button kc-button-outline', 'Cancel', () => close()))
  const confirm = button('kc-button kc-button-primary', options.submitLabel, () => apply())
  actions.appendChild(confirm)
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
    options.onSubmit({ price, note: note === '' ? undefined : note })
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
    // Enter from either input applies: the whole dialog is two fields and a button.
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
  const wrap = el('label', 'wd-alert-field')
  const text = el('span', 'wd-alert-label')
  text.textContent = label
  wrap.appendChild(text)
  return wrap
}
