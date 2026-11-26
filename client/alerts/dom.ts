// DOM helpers for the alert manager's forms (./editor.ts, ./ruletree.ts) and the Strategy Lab's
// (client/lab), in the house style: `kc-*` tokens, `wd-*` classes, plain elements.

import { fromWall, toWall } from '../replay/timeframes'
import { formatMinute } from './rules'

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

export function iconButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = button('kc-button wd-alert-icon', text, onClick)
  b.title = title
  b.setAttribute('aria-label', title)
  return b
}

export function select(options: Array<{ value: string; label: string }>, value: string, onChange: (value: string) => void): HTMLSelectElement {
  const s = document.createElement('select')
  s.className = 'kc-input'
  for (const o of options) {
    const option = document.createElement('option')
    option.value = o.value
    option.textContent = o.label
    s.appendChild(option)
  }
  s.value = value
  s.addEventListener('change', () => onChange(s.value))
  return s
}

export function input(type: string, value: string, onInput: (value: string) => void): HTMLInputElement {
  const i = document.createElement('input')
  i.type = type
  i.className = 'kc-input'
  i.value = value
  i.addEventListener('input', () => onInput(i.value))
  return i
}

/** A number committed on change; while typing, the model follows and the sentence with it. */
export function numberInput(value: number, onValue: (value: number) => void): HTMLInputElement {
  const i = document.createElement('input')
  i.type = 'number'
  i.step = 'any'
  i.className = 'kc-input wd-alert-number'
  i.value = String(value)
  const commit = (): void => {
    const n = Number(i.value)
    if (i.value.trim() !== '' && Number.isFinite(n)) onValue(n)
  }
  i.addEventListener('input', () => {
    commit()
    i.dispatchEvent(new CustomEvent('wd-alert-edited', { bubbles: true }))
  })
  i.addEventListener('change', commit)
  return i
}

/** A time of day, typed HH:MM, committed as minutes past midnight. */
export function timeInput(minute: number, onValue: (minute: number) => void): HTMLInputElement {
  const i = document.createElement('input')
  i.type = 'time'
  i.className = 'kc-input wd-alert-time'
  i.value = formatMinute(minute)
  const commit = (): void => {
    const m = /^(\d{1,2}):(\d{2})/.exec(i.value)
    if (m) onValue(Number(m[1]) * 60 + Number(m[2]))
  }
  i.addEventListener('input', () => {
    commit()
    i.dispatchEvent(new CustomEvent('wd-alert-edited', { bubbles: true }))
  })
  i.addEventListener('change', commit)
  return i
}

/** A date and time typed on `zone`'s wall clock, kept as the instant (epoch ms). */
export function dateTimeInput(at: number, zone: string, onValue: (at: number) => void): HTMLInputElement {
  const i = document.createElement('input')
  i.type = 'datetime-local'
  i.className = 'kc-input wd-alert-datetime'
  i.value = new Date(toWall(at, zone)).toISOString().slice(0, 16)
  const commit = (): void => {
    const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(i.value)
    if (m) onValue(fromWall(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])), zone))
  }
  i.addEventListener('input', () => {
    commit()
    i.dispatchEvent(new CustomEvent('wd-alert-edited', { bubbles: true }))
  })
  i.addEventListener('change', commit)
  return i
}

export function labelled(text: string, control: HTMLElement): HTMLElement {
  const label = el('label', 'wd-alert-field')
  const caption = el('span', 'wd-alert-caption')
  caption.textContent = text
  label.append(caption, control)
  return label
}
