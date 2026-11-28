// GLUE (DOM). The small builders the replay's three DOM components share -- the controls window
// (./controls.ts), the start dialog (./startdialog.ts) and the list of past sessions both of them
// show (./sessionlist.ts) -- in the house style: `kc-*` tokens, `wd-replay-*` classes, plain
// elements. A builder only one of them uses stays in that module.

/** The mounted chart's theme class ('dark' or ''), for chrome mounted outside its root. */
export function chartTheme(): string {
  return document.querySelector('.klinecharts-pro.dark') ? 'dark' : ''
}

export function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

export function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = className
  b.textContent = text
  b.addEventListener('click', onClick)
  return b
}

/** A toggle -- the window's footer, the dialog's tabs: label, optional count badge, on/off. */
export function toggleButton(label: string, badge: string, on: boolean, onClick: () => void): HTMLButtonElement {
  const b = button(`kc-button wd-replay-toggle${on ? ' is-on' : ''}`, label, onClick)
  b.setAttribute('aria-pressed', String(on))
  if (badge) {
    const count = el('span', 'wd-replay-badge')
    count.textContent = badge
    b.appendChild(count)
  }
  return b
}

export function select(options: Array<{ value: string; label: string }>, current: string, onChange: (value: string) => void): HTMLSelectElement {
  const s = document.createElement('select')
  s.className = 'kc-input wd-replay-select'
  for (const o of options) {
    const opt = document.createElement('option')
    opt.value = o.value
    opt.textContent = o.label
    s.appendChild(opt)
  }
  // By value once every option exists, not `option.selected` per option as it is appended:
  // happy-dom (the controls' test DOM) loses track of which one was marked.
  if (options.some((o) => o.value === current)) s.value = current
  s.addEventListener('change', () => onChange(s.value))
  return s
}

export function checkbox(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
  const wrap = el('label', 'wd-replay-check')
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  input.addEventListener('change', () => onChange(input.checked))
  const text = el('span', '')
  text.textContent = label
  wrap.append(input, text)
  return wrap
}

export function dayInput(value: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'date'
  input.className = 'kc-input wd-replay-input'
  input.value = value
  return input
}

export function flash(root: HTMLElement, message: string): void {
  const note = el('div', 'wd-replay-flash')
  note.textContent = message
  root.appendChild(note)
  setTimeout(() => note.remove(), 3000)
}
