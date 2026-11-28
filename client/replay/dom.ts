// GLUE (DOM). The builders the replay's three DOM components share -- the controls window
// (./controls.ts), the start dialog (./startdialog.ts) and the list of past sessions both of them
// show (./sessionlist.ts) -- whose markup is the replay's own: `wd-replay-*` classes, styled in
// styles/replay.css. The plain ones (`el`, `button`, `select`) are every surface's, ../ui/dom.ts;
// a builder only one of the three uses stays in that module.

import { button, el, type SelectOptions } from '../ui/dom'

/** How every replay picker is built (../ui/dom.ts `select`): styled as the replay's, and showing
 * its first choice when the current value is not one of them. */
export const REPLAY_SELECT: SelectOptions = { className: 'kc-input wd-replay-select', keepFirst: true }

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
