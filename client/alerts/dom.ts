// The alert editors' own inputs (./editor.ts, ./ruletree.ts): a number, a time of day and a date
// that commit as they are typed and say so with a bubbling `wd-alert-edited` (the sentence above
// the rule follows), and a captioned field. The plain builders they are made of, which the Lab and
// every other hand-built surface share, are ../ui/dom.ts.

import { fromWall, toWall } from '../time/timeframes'
import { el } from '../ui/dom'
import { formatMinute } from './rules'

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
