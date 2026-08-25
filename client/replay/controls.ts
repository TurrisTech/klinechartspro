import type { SignalCatalogueEntry } from '../plugins/types'
import { formatInstant } from '../trading/format'
import type { AdvanceResult, ReplayController } from './session'
import { type BaseCheck, defaultBase, sortByLength, validateBase } from './timeframes'

// GLUE (DOM). The replay control strip and the start dialog: plain DOM in the house style
// (`kc-*` tokens, `wd-*` classes), driven by a `ReplayController` they do not implement.
//
// The strip: the cursor instant, the advance control (timeframe picker x multiple + Step),
// the signal list (star + arm), Next signal, the last stop reason, pause-on-fill, the base
// timeframe, and Exit.

export interface ControlStripOptions {
  controller: ReplayController
  /** The wall's pane intervals, for the advance picker and the base validation. */
  intervalsInUse: () => string[]
  onExit: () => void
  /** The panel scrolls the stop's event into view. */
  onStop?: (result: AdvanceResult) => void
}

export interface ControlStrip {
  readonly element: HTMLElement
  /** Re-render (a pane change altered the intervals in use). */
  refresh(): void
  dispose(): void
}

export function createControlStrip(options: ControlStripOptions): ControlStrip {
  const { controller } = options
  const root = el('div', 'wd-replay-strip')
  const unsubscribe = controller.onControlChange(() => render())

  function render(): void {
    root.innerHTML = ''
    const busy = controller.busy

    // 1. The clock.
    const clock = el('div', 'wd-replay-clock')
    const clockLabel = el('span', 'wd-replay-label')
    clockLabel.textContent = 'Cursor'
    const clockValue = el('span', 'wd-replay-clock-value')
    clockValue.textContent = formatInstant(controller.cursor)
    clockValue.title = new Date(controller.cursor).toISOString()
    clock.append(clockLabel, clockValue)
    root.appendChild(clock)

    // 2. The advance control: any timeframe x a multiple, and Step.
    const advance = el('div', 'wd-replay-advance')
    const choices = advanceChoices(controller, options.intervalsInUse())
    const picker = select(
      choices.map((c) => ({ value: c, label: c })),
      controller.advance.interval,
      (value) => controller.setAdvance({ interval: value, multiple: controller.advance.multiple })
    )
    picker.title = 'Advance timeframe'
    const times = el('span', 'wd-replay-times')
    times.textContent = '×'
    const multiple = numberInput(String(controller.advance.multiple), (raw) => {
      const n = Math.max(1, Math.floor(Number(raw) || 1))
      controller.setAdvance({ interval: controller.advance.interval, multiple: n })
    })
    multiple.title = 'How many candles'
    const step = button('kc-button kc-button-primary wd-replay-step', busy ? 'Stepping…' : 'Step', () => {
      void controller.step().then((r) => r && options.onStop?.(r))
    })
    step.disabled = busy
    const next = button('kc-button kc-button-outline wd-replay-next', 'Next signal', () => {
      void controller.nextSignal().then((r) => r && options.onStop?.(r))
    })
    next.disabled = busy || controller.signals.armed.length === 0
    next.title = controller.signals.armed.length === 0 ? 'Arm a signal first' : 'Advance to the next armed signal'
    advance.append(picker, times, multiple, step, next)
    root.appendChild(advance)

    // 3. The last stop reason.
    const stop = el('div', 'wd-replay-stop')
    const last = controller.lastStop
    if (last) {
      const reason = el('span', `wd-replay-stop-reason is-${last.reason}`)
      reason.textContent = describeStop(last, controller.signals.catalogue)
      stop.appendChild(reason)
    }
    root.appendChild(stop)

    // 4. Base timeframe + pause on fill.
    const settings = el('div', 'wd-replay-settings')
    const baseLabel = el('span', 'wd-replay-label')
    baseLabel.textContent = 'Base'
    const baseCheck = validateBase(controller.base, controller.intervalsInUse, controller.storedIntervals)
    const basePicker = select(
      controller.storedIntervals.map((s) => ({ value: s, label: s })),
      controller.base,
      (value) => {
        const check = controller.setBase(value)
        if (!check.ok) flash(root, check.reason ?? 'Invalid base')
      }
    )
    basePicker.disabled = busy
    basePicker.title = baseCheck.ok ? 'The interval the engine walks; finer = more accurate fills, more bars' : (baseCheck.reason ?? '')
    basePicker.classList.toggle('is-invalid', !baseCheck.ok)
    const pause = checkbox('Pause on fill', controller.pauseOnFill, (on) => controller.setPauseOnFill(on))
    settings.append(baseLabel, basePicker, pause)
    if (!baseCheck.ok) {
      const warn = el('span', 'wd-replay-warning')
      warn.textContent = baseCheck.reason ?? ''
      settings.appendChild(warn)
    }
    root.appendChild(settings)

    // 5. Signals: star + arm.
    root.appendChild(renderSignals(controller, options.intervalsInUse()))

    // 6. Exit.
    const exit = button('kc-button kc-button-outline wd-replay-exit', 'Exit replay', () => options.onExit())
    exit.disabled = busy
    root.appendChild(exit)
  }

  render()
  return {
    element: root,
    refresh: render,
    dispose(): void {
      unsubscribe()
      root.remove()
    }
  }
}

function advanceChoices(controller: ReplayController, inUse: string[]): string[] {
  return sortByLength([...new Set([controller.base, ...controller.storedIntervals, ...inUse, controller.advance.interval])])
}

function describeStop(result: AdvanceResult, catalogue: readonly SignalCatalogueEntry[]): string {
  switch (result.reason) {
    case 'signal': {
      const entry = catalogue.find((e) => e.ref === result.signal?.ref)
      const name = entry ? `${entry.title}${entry.variant ? ` ${entry.variant}` : ''} ${entry.label}` : (result.signal?.ref ?? 'signal')
      return `Stopped at ${name} @${result.signal?.resolution ?? ''}`
    }
    case 'fill':
      return `Paused on ${result.events.some((e) => e.kind === 'fill') ? 'a fill' : 'a close'}`
    case 'end':
      return 'End of data'
    default:
      // A seek (nothing could fill) consumed no bars by design -- say so rather than
      // reporting "0 bars", which reads as a broken step.
      return result.walked
        ? `Advanced ${result.bars.length} bar${result.bars.length === 1 ? '' : 's'}`
        : 'Jumped — nothing working'
  }
}

function renderSignals(controller: ReplayController, inUse: string[]): HTMLElement {
  const box = el('div', 'wd-replay-signals')
  const book = controller.signals
  const head = el('span', 'wd-replay-label')
  head.textContent = 'Signals'
  box.appendChild(head)
  const available = book.catalogue.filter((e) => e.available)
  if (available.length === 0) {
    const none = el('span', 'wd-replay-muted')
    none.textContent = 'none published'
    box.appendChild(none)
    return box
  }
  const list = el('div', 'wd-replay-signal-list')
  // Starred first (the working shortlist), then the rest of the catalogue.
  const ordered = [...available].sort((a, b) => Number(book.isStarred(b.ref)) - Number(book.isStarred(a.ref)))
  const resolutions = sortByLength([...new Set(inUse)])
  for (const entry of ordered) {
    const row = el('div', 'wd-replay-signal')
    const star = button(`wd-replay-star ${book.isStarred(entry.ref) ? 'is-on' : ''}`, book.isStarred(entry.ref) ? '★' : '☆', () => {
      book.star(entry.ref, !book.isStarred(entry.ref))
      controller.persist()
      rerender()
    })
    star.title = book.isStarred(entry.ref) ? 'Unstar' : 'Star (shortlist)'
    const name = el('span', `wd-replay-signal-name is-${entry.side ?? 'none'}`)
    name.textContent = `${entry.title}${entry.variant ? ` ${entry.variant}` : ''} · ${entry.label}`
    name.title = entry.description || entry.ref
    row.append(star, name)
    if (book.isStarred(entry.ref)) {
      const arms = el('span', 'wd-replay-arms')
      for (const res of resolutions) {
        const armed = book.isArmed(entry.ref, res)
        const arm = button(`wd-replay-arm ${armed ? 'is-on' : ''}`, res, () => {
          book.arm(entry.ref, res, !armed)
          controller.persist()
          rerender()
        })
        arm.title = armed ? `Armed on ${res}: click to disarm` : `Arm as a pause point on ${res}`
        arms.appendChild(arm)
      }
      row.appendChild(arms)
    }
    list.appendChild(row)
  }
  box.appendChild(list)
  function rerender(): void {
    const fresh = renderSignals(controller, inUse)
    box.replaceWith(fresh)
  }
  return box
}

// -- the start dialog ------------------------------------------------------------------------

export interface StartDialogOptions {
  anchor: HTMLElement
  /** The active pane's instrument, `vendor:TICKER`. */
  symbol: string
  intervalsInUse: string[]
  /** The intervals the store holds for this instrument (probed by the caller). */
  stored: string[]
  /** Newest instant the store has for the instrument (the latest a replay can start). */
  latest: number
  onStart: (choice: { startAt: number; balance: number; base: string }) => void
}

export interface StartDialog {
  close(): void
}

export function openStartDialog(options: StartDialogOptions): StartDialog {
  // The kc tokens are scoped under the chart's themed root (`.klinecharts-pro.dark`); a
  // body-level card has to carry the theme class itself or it renders in the light defaults.
  const overlay = el('div', `wd-replay-dialog-backdrop ${chartTheme()}`)
  const dialog = el('div', 'wd-replay-dialog')
  overlay.appendChild(dialog)
  const title = el('div', 'wd-replay-dialog-title')
  title.textContent = 'Start bar replay'
  dialog.appendChild(title)

  const info = el('div', 'wd-replay-dialog-info')
  info.textContent = `${options.symbol.split(':')[1] ?? options.symbol} · panes: ${sortByLength(options.intervalsInUse).join(', ') || '—'}`
  dialog.appendChild(info)

  // Default start: a week before the newest bar, at 17:00 New York (a session open).
  const defaultStart = options.latest - 7 * 86_400_000
  const startField = field('Start (New York time)')
  const startInput = document.createElement('input')
  startInput.type = 'datetime-local'
  startInput.className = 'kc-input wd-replay-input'
  startInput.value = toLocalInputValue(defaultStart)
  startInput.step = '60'
  startField.appendChild(startInput)
  dialog.appendChild(startField)

  const balanceField = field('Starting balance')
  const balanceInput = numberInput('10000', () => {})
  balanceField.appendChild(balanceInput)
  dialog.appendChild(balanceField)

  const suggested = defaultBase(options.intervalsInUse, options.stored)
  const baseField = field('Base timeframe')
  const basePicker = select(
    options.stored.map((s) => ({ value: s, label: s === suggested ? `${s} (highest common denominator)` : s })),
    suggested ?? options.stored[0] ?? '1m',
    () => validate()
  )
  baseField.appendChild(basePicker)
  const baseNote = el('div', 'wd-replay-dialog-note')
  baseNote.textContent = 'The interval the engine walks: a finer base gives more accurate fills and more bars to walk. It must divide every pane interval and be stored for the instrument.'
  baseField.appendChild(baseNote)
  const baseError = el('div', 'kc-field-error wd-replay-dialog-error')
  baseField.appendChild(baseError)
  dialog.appendChild(baseField)

  const actions = el('div', 'wd-replay-dialog-actions')
  const cancel = button('kc-button kc-button-outline', 'Cancel', () => close())
  const start = button('kc-button kc-button-primary', 'Start', () => {
    const check = validate()
    if (!check.ok) return
    const startAt = fromLocalInputValue(startInput.value)
    if (startAt === null) {
      baseError.textContent = 'Enter a start date and time'
      return
    }
    const balance = Number(balanceInput.value)
    if (!(balance > 0)) {
      baseError.textContent = 'Balance must be positive'
      return
    }
    options.onStart({ startAt: Math.min(startAt, options.latest), balance, base: basePicker.value })
    close()
  })
  actions.append(cancel, start)
  dialog.appendChild(actions)

  function validate(): BaseCheck {
    const check = validateBase(basePicker.value, options.intervalsInUse, options.stored)
    baseError.textContent = check.ok ? '' : (check.reason ?? '')
    start.disabled = !check.ok
    return check
  }
  validate()

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  document.body.appendChild(overlay)
  startInput.focus()

  function close(): void {
    document.removeEventListener('keydown', onKey)
    overlay.remove()
  }
  return { close }
}

// New York wall clock <-> the datetime-local input, which is timezone-less text.
const nyParts = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})

function toLocalInputValue(ms: number): string {
  const p = Object.fromEntries(nyParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

function fromLocalInputValue(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  // Resolve the New York wall time to an instant (timeframes.fromWall semantics, inlined
  // to keep this module DOM-only): try both offsets around the date.
  const naive = Date.UTC(y, mo - 1, d, h, mi)
  for (const guess of [naive + 4 * 3_600_000, naive + 5 * 3_600_000]) {
    if (toLocalInputValue(guess) === value.slice(0, 16)) return guess
  }
  return naive + 5 * 3_600_000
}

// -- small DOM helpers -------------------------------------------------------------------------

/** The mounted chart's theme class ('dark' or ''), for chrome mounted outside its root. */
export function chartTheme(): string {
  return document.querySelector('.klinecharts-pro.dark') ? 'dark' : ''
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = className
  b.textContent = text
  b.addEventListener('click', onClick)
  return b
}

function select(options: Array<{ value: string; label: string }>, current: string, onChange: (value: string) => void): HTMLSelectElement {
  const s = document.createElement('select')
  s.className = 'kc-input wd-replay-select'
  for (const o of options) {
    const opt = document.createElement('option')
    opt.value = o.value
    opt.textContent = o.label
    opt.selected = o.value === current
    s.appendChild(opt)
  }
  s.addEventListener('change', () => onChange(s.value))
  return s
}

function numberInput(value: string, onCommit: (raw: string) => void): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'text'
  input.inputMode = 'numeric'
  input.className = 'kc-input wd-replay-input wd-replay-number'
  input.value = value
  input.addEventListener('change', () => onCommit(input.value))
  return input
}

function checkbox(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
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

function field(label: string): HTMLElement {
  const wrap = el('label', 'wd-replay-field')
  const l = el('span', 'wd-replay-label')
  l.textContent = label
  wrap.appendChild(l)
  return wrap
}

function flash(root: HTMLElement, message: string): void {
  const note = el('div', 'wd-replay-flash')
  note.textContent = message
  root.appendChild(note)
  setTimeout(() => note.remove(), 3000)
}
