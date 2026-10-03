import type { ReadoutPart } from './levels'
import type { ProtectMode } from './prefs'
import type { StatRow } from './stats'

// The trading kit: the controls every trading surface is built from -- the trade box (ticket.ts),
// the order card on the pane (ordercard.ts) and the position popup (inspector.ts). They used to be
// three hand-built UIs that stated one stop loss three ways, sized their buttons three ways and
// confirmed a close in two of three; now a stop is one `LevelField` wherever it is edited, a
// figure is one `FigureList` row wherever it is read, and the ways to end a trade are one
// `TradeActions` row wherever it is managed (user, 2026-10-03: "redesign for consistency").
//
// Plain DOM like the rest of client/trading, BUILT ONCE and updated in place: every surface
// re-renders on each session notification (two seconds while anything is working), and a control
// rebuilt each time would take the focus and a half-typed value away. A field never overwrites
// what is being typed in it.
//
// Styles are `wd-tk-*`, scoped under a `.wd-tk` root (each surface puts it on its own root) so a
// rule that colours a border beats the library's `.klinecharts-pro * { border-color }` on the pane.

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export type ButtonVariant = 'primary' | 'buy' | 'sell' | 'danger' | 'chip' | 'icon' | 'quiet' | 'armed'

/** A kit button. Its click never reaches anything under it -- on the pane that would be the chart. */
export function kbtn(text: string, onClick: (event: MouseEvent) => void, variants: ButtonVariant[] = [], title?: string): HTMLButtonElement {
  const b = h('button', ['wd-tk-btn', ...variants.map((v) => `is-${v}`)].join(' '), text)
  b.type = 'button'
  if (title) {
    b.title = title
    b.setAttribute('aria-label', title)
  }
  b.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick(event)
  })
  return b
}

/** Enable or refuse a button, with the reason as its tooltip. */
export function allow(b: HTMLButtonElement, refusal: string | null, title = ''): void {
  b.disabled = refusal !== null
  b.title = refusal ?? title
}

// -- two presses -------------------------------------------------------------------------------

export const CONFIRM_MS = 3_000

/** The keys a pending second press is held under, one spelling for every surface. */
export const armKey = {
  place: 'place',
  flatten: 'flatten',
  close: (id: string, fraction: number) => `close:${id}:${fraction}`,
  reverse: (id: string) => `reverse:${id}`,
  cancel: (id: string) => `cancel:${id}`
}

/** Two-press confirmation with no modal: the first press relabels the button, a second within
 * `CONFIRM_MS` goes ahead -- or the first does, with one-click trading on. */
export class Arming {
  key: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly onChange: () => void) {}

  /** True when the action should happen now. */
  press(key: string, oneClick: boolean): boolean {
    if (oneClick || this.key === key) {
      this.disarm()
      return true
    }
    this.key = key
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.disarm(), CONFIRM_MS)
    this.onChange()
    return false
  }

  disarm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.key === null) return
    this.key = null
    this.onChange()
  }
}

// -- a number with steps -----------------------------------------------------------------------

export interface NumberFieldOptions {
  label: string
  /** Every keystroke. The trade box re-prices as you type. */
  onInput?: (text: string) => void
  /** Enter, or the field left with a changed value. The pane proposes a change on it. */
  onCommit?: (text: string) => void
  /** −/+ and the arrow keys; `big` (Shift) is ten steps. */
  onStep: (direction: 1 | -1, big: boolean) => void
  /** A unit picker after the number, when given. */
  units?: Array<[string, string]>
  onUnit?: (unit: string) => void
  /** After Enter has committed (the trade box places the order). */
  onEnter?: () => void
}

/** `[− | 20.0 | pips ▾ | +]`: a number in one bordered group, with its steps and unit. */
export class NumberField {
  readonly element: HTMLElement
  readonly input: HTMLInputElement
  readonly select: HTMLSelectElement | null = null
  private readonly minus: HTMLButtonElement
  private readonly plus: HTMLButtonElement
  private committed = ''

  constructor(private readonly options: NumberFieldOptions) {
    this.element = h('div', 'wd-tk-num')
    this.input = h('input', 'wd-tk-num-input')
    this.input.type = 'text'
    this.input.inputMode = 'decimal'
    this.input.autocomplete = 'off'
    this.input.spellcheck = false
    this.input.setAttribute('aria-label', options.label)
    this.minus = kbtn('−', (e) => this.step(-1, e.shiftKey), ['quiet'], `Less (Shift: ten steps)`)
    this.plus = kbtn('+', (e) => this.step(1, e.shiftKey), ['quiet'], `More (Shift: ten steps)`)
    this.minus.classList.add('wd-tk-num-step')
    this.plus.classList.add('wd-tk-num-step')
    this.minus.tabIndex = -1
    this.plus.tabIndex = -1
    this.element.append(this.minus, this.input)
    if (options.units) {
      const select = h('select', 'wd-tk-num-unit')
      select.setAttribute('aria-label', `${options.label}: unit`)
      for (const [value, text] of options.units) {
        const option = h('option', '', text)
        option.value = value
        select.appendChild(option)
      }
      select.addEventListener('change', () => options.onUnit?.(select.value))
      select.addEventListener('click', (e) => e.stopPropagation())
      this.select = select
      this.element.appendChild(select)
    }
    this.element.appendChild(this.plus)

    this.input.addEventListener('input', () => options.onInput?.(this.input.value))
    this.input.addEventListener('change', () => this.commit())
    this.input.addEventListener('keydown', (event) => {
      // On the pane the field sits inside klinecharts' container, whose own keys (arrows scroll
      // the chart) must not see typing. Escape still travels: the layer cancels a waiting change.
      if (event.key !== 'Escape') event.stopPropagation()
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        this.step(event.key === 'ArrowUp' ? 1 : -1, event.shiftKey)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        this.commit()
        options.onEnter?.()
      } else if (event.key === 'Escape' && options.onCommit) {
        // Typing on the pane is a proposal not yet made: Escape puts the field back.
        this.input.value = this.committed
        this.input.blur()
      }
    })
  }

  private step(direction: 1 | -1, big: boolean): void {
    this.options.onStep(direction, big)
  }

  private commit(): void {
    if (this.input.value === this.committed) return
    this.committed = this.input.value
    this.options.onCommit?.(this.input.value)
  }

  focused(): boolean {
    return document.activeElement === this.input
  }

  /** Show `text` -- unless it is being typed in, which is never overwritten. */
  show(text: string): void {
    if (this.focused()) return
    this.input.value = text
    this.committed = text
  }

  /** Put `text` in the field even while it has the focus: a step or a drag wrote it. */
  write(text: string): void {
    this.input.value = text
    this.committed = text
  }

  value(): string {
    return this.input.value
  }

  set(state: {
    placeholder?: string
    unit?: string
    unitRefusals?: Record<string, string | null>
    stepRefusal?: string | null
    invalid?: boolean
    pending?: boolean
    disabled?: boolean
  }): void {
    this.input.placeholder = state.placeholder ?? ''
    if (this.select && state.unit !== undefined) {
      this.select.value = state.unit
      for (const option of this.select.options) {
        const refusal = state.unitRefusals?.[option.value] ?? null
        option.disabled = refusal !== null
        option.title = refusal ?? ''
      }
    }
    const stepRefusal = state.stepRefusal ?? null
    for (const b of [this.minus, this.plus]) b.disabled = stepRefusal !== null || state.disabled === true
    this.input.disabled = state.disabled === true
    this.element.classList.toggle('is-invalid', state.invalid === true)
    this.element.classList.toggle('is-pending', state.pending === true)
  }
}

// -- a level: stop loss, take profit, resting price --------------------------------------------

export const PROTECT_UNITS: Array<[ProtectMode, string]> = [
  ['pips', 'pips'],
  ['price', 'price'],
  ['percent', '% bal']
]

export interface PresetView {
  text: string
  title: string
  refusal: string | null
  active?: boolean
}

export interface LevelFieldView {
  /** What the field states while it is not being typed in; '' is no level. */
  text: string
  placeholder: string
  unit?: ProtectMode
  unitRefusals?: Record<string, string | null>
  readout: ReadoutPart[]
  presets: PresetView[]
  removable: boolean
  /** Why the level is wrong as it stands, under the field. */
  problem: string | null
  /** A change to it is waiting to be confirmed. */
  pending: boolean
  stepRefusal?: string | null
}

export interface LevelFieldOptions {
  role: 'entry' | 'stop' | 'target'
  label: string
  /** Stops and targets take a unit; a resting price is always a price. */
  withUnits: boolean
  onInput?: (text: string) => void
  onCommit?: (text: string) => void
  onStep: (direction: 1 | -1, big: boolean) => void
  onUnit?: (unit: ProtectMode) => void
  onPreset?: (index: number) => void
  onClear?: () => void
  onEnter?: () => void
}

/** One level, the same in the trade box and on the pane:
 *
 *     ╌╌ Stop loss                         [Risk 1%]  [×]
 *     [− | 20.0 | pips ▾ | +]   1.12333 · −20.00 USD · −0.20%
 */
export class LevelField {
  readonly element: HTMLElement
  readonly field: NumberField
  private readonly presets: HTMLElement
  private presetButtons: HTMLButtonElement[] = []
  private presetSignature = ''
  private readonly remove: HTMLButtonElement
  private readonly readout: HTMLElement
  private readonly problem: HTMLElement

  constructor(private readonly options: LevelFieldOptions) {
    this.element = h('div', 'wd-tk-level')
    this.element.dataset.role = options.role
    const head = h('div', 'wd-tk-level-head')
    const label = h('span', 'wd-tk-level-label')
    label.append(h('i', 'wd-tk-mark'), options.label)
    this.presets = h('span', 'wd-tk-presets')
    this.remove = kbtn('×', () => options.onClear?.(), ['icon', 'quiet'], `Remove the ${options.label.toLowerCase()}`)
    head.append(label, this.presets, this.remove)

    const body = h('div', 'wd-tk-level-body')
    this.field = new NumberField({
      label: options.label,
      onInput: options.onInput,
      onCommit: options.onCommit,
      onStep: options.onStep,
      units: options.withUnits ? PROTECT_UNITS : undefined,
      onUnit: (unit) => options.onUnit?.(unit as ProtectMode),
      onEnter: options.onEnter
    })
    this.readout = h('span', 'wd-tk-readout')
    body.append(this.field.element, this.readout)
    this.problem = h('div', 'wd-tk-problem')
    this.problem.setAttribute('role', 'status')
    this.element.append(head, body, this.problem)
  }

  update(view: LevelFieldView): void {
    this.field.show(view.text)
    this.field.set({
      placeholder: view.placeholder,
      unit: view.unit,
      unitRefusals: view.unitRefusals,
      stepRefusal: view.stepRefusal ?? null,
      invalid: view.problem !== null,
      pending: view.pending
    })
    this.element.classList.toggle('is-unset', view.text === '' && !this.field.focused())
    this.element.classList.toggle('is-pending', view.pending)
    this.remove.hidden = !view.removable

    const signature = view.presets.map((p) => p.text).join('|')
    if (signature !== this.presetSignature) {
      this.presetSignature = signature
      this.presets.innerHTML = ''
      this.presetButtons = view.presets.map((_, i) => {
        const b = kbtn('', () => this.options.onPreset?.(i), ['chip'])
        this.presets.appendChild(b)
        return b
      })
    }
    view.presets.forEach((preset, i) => {
      const b = this.presetButtons[i]
      b.textContent = preset.text
      allow(b, preset.refusal === null ? null : `${preset.title} (${preset.refusal})`, preset.title)
      b.classList.toggle('is-active', preset.active === true)
    })

    this.readout.innerHTML = ''
    view.readout.forEach((part, i) => {
      if (i > 0) this.readout.append(h('span', 'wd-tk-sep', '·'))
      this.readout.append(h('span', part.tone ? `is-${part.tone}` : '', part.text))
    })
    this.problem.textContent = view.problem ?? ''
    this.problem.hidden = view.problem === null
  }

  /** A step, a drag or a preset wrote a new value: show it even while the field has the focus. */
  write(text: string): void {
    this.field.write(text)
  }
}

// -- figures -----------------------------------------------------------------------------------

/** Label/value rows in two columns: the same figures, laid out the same, on every surface. Rows
 * are rebuilt only when WHICH rows there are changes, so a poll does not rebuild what is being
 * read (or selected to copy). */
export class FigureList {
  readonly element: HTMLElement
  private signature = ''
  private values: HTMLElement[] = []

  constructor(className = '') {
    this.element = h('dl', `wd-tk-figs ${className}`.trim())
  }

  update(rows: StatRow[]): void {
    const signature = rows.map((r) => r.label).join('|')
    if (signature !== this.signature) {
      this.signature = signature
      this.element.innerHTML = ''
      this.values = rows.map((row) => {
        const item = h('div', 'wd-tk-fig')
        const dd = h('dd')
        item.append(h('dt', '', row.label), dd)
        // A long note gets the width.
        if (row.label === 'Note') item.classList.add('is-wide')
        this.element.appendChild(item)
        return dd
      })
    }
    rows.forEach((row, i) => {
      const node = this.values[i]
      node.textContent = row.value
      node.className = row.tone ? `is-${row.tone}` : ''
    })
    this.element.hidden = rows.length === 0
  }
}

// -- the waiting change ------------------------------------------------------------------------

export interface ConfirmView {
  title: string
  detail: string
  refusal: string | null
  sending: boolean
}

/** A change to a working stop, target or price, asked in words: the same bar on the pane's card,
 * in the account window and in the popup. */
export class ConfirmBar {
  readonly element: HTMLElement
  private readonly title: HTMLElement
  private readonly detail: HTMLElement
  private readonly confirm: HTMLButtonElement

  constructor(onConfirm: () => void, onCancel: () => void) {
    this.element = h('div', 'wd-tk-confirm')
    this.element.setAttribute('role', 'alertdialog')
    const words = h('div', 'wd-tk-confirm-text')
    this.title = h('div', 'wd-tk-confirm-title')
    this.detail = h('div', 'wd-tk-confirm-detail')
    words.append(this.title, this.detail)
    const answers = h('div', 'wd-tk-row is-end')
    this.confirm = kbtn('Confirm', onConfirm, ['primary'])
    answers.append(kbtn('Cancel', onCancel), this.confirm)
    this.element.append(words, answers)
    this.element.hidden = true
  }

  update(view: ConfirmView | null): void {
    this.element.hidden = view === null
    if (!view) return
    this.title.textContent = view.title
    this.detail.textContent = view.refusal ?? view.detail
    this.detail.classList.toggle('is-warn', view.refusal !== null)
    this.confirm.disabled = view.sending || view.refusal !== null
    this.confirm.textContent = view.sending ? 'Sending…' : 'Confirm'
  }
}

// -- ending a trade ----------------------------------------------------------------------------

export type TradeAction = { kind: 'breakeven' } | { kind: 'reverse' } | { kind: 'close'; fraction: number }

export interface TradeActionsView {
  id: string
  armed: string | null
  /** Why breakeven is not open now, or null when it is. */
  breakeven: string | null
  breakevenTitle: string
  /** Why the trade cannot be reversed now, or null. */
  reverse: string | null
  reverseTitle: string
  /** Each fraction of the trade a Close chip ends, with its units (null: too small to split). */
  fractions: Array<{ fraction: number; units: number | null; title: string }>
}

const FRACTION_TEXT: Record<string, string> = { '0.25': '¼', '0.5': '½', '0.75': '¾', '1': 'All' }

/** `[Breakeven] [Reverse]      Close [¼] [½] [¾] [All]` -- every way to manage an open trade, the
 * same row on the pane's card and in the popup. Right-aligned, so a chip relabelled "Confirm" grows
 * leftwards and its right edge -- under the pointer -- stays put for the second press. */
export class TradeActions {
  readonly element: HTMLElement
  private readonly breakeven: HTMLButtonElement
  private readonly reverse: HTMLButtonElement
  private readonly closes = new Map<number, HTMLButtonElement>()
  private id = ''

  constructor(onAction: (action: TradeAction) => void) {
    this.element = h('div', 'wd-tk-actions')
    const manage = h('div', 'wd-tk-row')
    this.breakeven = kbtn('Breakeven', () => onAction({ kind: 'breakeven' }))
    this.reverse = kbtn('Reverse', () => onAction({ kind: 'reverse' }))
    manage.append(this.breakeven, this.reverse)
    const close = h('div', 'wd-tk-row is-end wd-tk-close')
    close.append(h('span', 'wd-tk-row-label', 'Close'))
    for (const fraction of [0.25, 0.5, 0.75, 1]) {
      const b = kbtn(FRACTION_TEXT[String(fraction)], () => onAction({ kind: 'close', fraction }), fraction === 1 ? ['danger'] : ['chip'])
      this.closes.set(fraction, b)
      close.appendChild(b)
    }
    this.element.append(manage, close)
  }

  update(view: TradeActionsView): void {
    this.id = view.id
    allow(this.breakeven, view.breakeven, view.breakevenTitle)
    const reverseArmed = view.armed === armKey.reverse(this.id)
    this.reverse.textContent = reverseArmed ? 'Confirm reverse' : 'Reverse'
    this.reverse.classList.toggle('is-armed', reverseArmed)
    allow(this.reverse, view.reverse, view.reverseTitle)
    for (const { fraction, units, title } of view.fractions) {
      const b = this.closes.get(fraction)
      if (!b) continue
      const armed = view.armed === armKey.close(this.id, fraction)
      b.textContent = armed ? 'Confirm' : FRACTION_TEXT[String(fraction)]
      b.classList.toggle('is-armed', armed)
      allow(b, units === null ? 'Too small to split' : null, title)
    }
  }
}
