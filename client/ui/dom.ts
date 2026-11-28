// THE DOM KIT: the plain-element builders every hand-built surface in client/ uses -- the alert
// manager and its editors, the Strategy Lab, the replay's windows, the account panel, the bell and
// its Delivery window, the price watch and price-alert cards. In the house style: `kc-*` tokens,
// the caller's `wd-*` classes, plain elements, nothing kept between calls.
//
// They used to carry their own copies of `el` and `button`, word for word the same, and the Lab
// borrowed the alert editors'. A builder whose markup is an area's own stays in that area, beside
// the styles it is written for: the replay's toggles and checkboxes (client/replay/dom.ts), the
// alert editors' typed inputs (client/alerts/dom.ts), the trading kit's `h`, which leaves out an
// empty class attribute where `el` writes one (client/trading/kit.ts).

/** An element with its classes, and its text when given. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K]
export function el(tag: string, className: string, text?: string): HTMLElement
export function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** A button that submits nothing: `type="button"`, so one inside a form never sends it. */
export function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = className
  b.textContent = text
  b.addEventListener('click', onClick)
  return b
}

/** A one-glyph button (× to remove, ⧉ to copy) whose title says what it does, to the pointer and
 * to a screen reader. The class is the alert manager's, whose stylesheet draws it
 * (styles/alerts.css); the Lab's rule and basket editors use the same buttons. */
export function iconButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = button('kc-button wd-alert-icon', text, onClick)
  b.title = title
  b.setAttribute('aria-label', title)
  return b
}

export interface SelectOptions {
  /** The select's classes; `kc-input` when not given. */
  className?: string
  /** When `value` names none of the options: false (the default) chooses none, which is what a
   * browser does with a value it does not have; true leaves the first one showing. */
  keepFirst?: boolean
}

export function select(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string,
  onChange: (value: string) => void,
  opts: SelectOptions = {}
): HTMLSelectElement {
  const s = document.createElement('select')
  s.className = opts.className ?? 'kc-input'
  for (const o of options) {
    const option = document.createElement('option')
    option.value = o.value
    option.textContent = o.label
    s.appendChild(option)
  }
  // By value once every option exists, not `option.selected` per option as it is appended:
  // happy-dom (the DOM the tests render into) loses track of which one was marked.
  if (!opts.keepFirst || options.some((o) => o.value === value)) s.value = value
  s.addEventListener('change', () => onChange(s.value))
  return s
}

/** A `kc-input` of `type`, reporting every keystroke. */
export function input(type: string, value: string, onInput: (value: string) => void): HTMLInputElement {
  const i = document.createElement('input')
  i.type = type
  i.className = 'kc-input'
  i.value = value
  i.addEventListener('input', () => onInput(i.value))
  return i
}
