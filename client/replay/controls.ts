import type { SignalCatalogueEntry } from '../plugins/types'
import { formatInstant } from '../trading/format'
import type { AdvanceResult, ReplayController } from './session'
import { type BaseCheck, defaultBase, sortByLength, validateBase } from './timeframes'
import { createFloatingWindow } from './window'

// GLUE (DOM). The replay controls and the start dialog: plain DOM in the house style
// (`kc-*` tokens, `wd-*` classes), driven by a `ReplayController` they do not implement.
//
// The controls are a FLOATING WINDOW over the chart (window.ts), not a strip inside the
// trading dock. Only what is used on every step is on screen:
//
//   title bar   the cursor, Step, collapse, Exit -- and the drag handle
//   advance     the timeframe picker x a multiple, and Next signal
//   last stop   why the last advance stopped (absent until one has)
//   toggles     Signals / Base / Account, one panel open at a time
//
// The signal list, the base timeframe and pause-on-fill are all one click away instead of
// permanently on screen, and the account dock is opened from here rather than taking half
// the wall from the moment replay starts.

/** Where the window's position and collapsed state are remembered (per browser). */
const PLACEMENT_KEY = 'wd.replay.window'

type PanelId = 'signals' | 'settings' | null

export interface ReplayControlsOptions {
  controller: ReplayController
  /** The wall's pane intervals, for the advance picker and the base validation. */
  intervalsInUse: () => string[]
  /** The element the window stays inside: the chart's container, which shrinks when the
   * trading dock opens below it. */
  bounds: HTMLElement
  onExit: () => void
  /** The panel scrolls the stop's event into view. */
  onStop?: (result: AdvanceResult) => void
  /** The trading dock the Account toggle shows and hides. */
  account?: { isOpen: () => boolean; toggle: () => boolean }
}

export interface ReplayControls {
  readonly element: HTMLElement
  /** Re-render: the intervals in use changed, or the dock was opened from outside. */
  refresh(): void
  dispose(): void
}

export function createReplayControls(options: ReplayControlsOptions): ReplayControls {
  const { controller } = options
  const win = createFloatingWindow({
    className: 'wd-replay-window',
    storageKey: PLACEMENT_KEY,
    bounds: options.bounds,
    theme: chartTheme()
  })
  let panel: PanelId = null
  // The signal list is the only scrollable thing here and every step re-renders the body,
  // so its scroll position is carried across a render rather than snapping back to the top.
  let signalScroll = 0
  const unsubscribe = controller.onControlChange(() => render())

  function render(): void {
    renderHeader()
    renderBody()
  }

  // -- the title bar (visible collapsed, and the drag handle) -----------------------------

  function renderHeader(): void {
    const head = win.header
    head.innerHTML = ''
    const busy = controller.busy

    const grip = el('span', 'wd-float-grip')
    grip.textContent = '⠿'
    grip.setAttribute('aria-hidden', 'true')
    const title = el('span', 'wd-float-title')
    title.textContent = 'Replay'
    const clock = el('span', 'wd-replay-clock-value')
    clock.textContent = formatInstant(controller.cursor)
    clock.title = new Date(controller.cursor).toISOString()

    // Step lives in the title bar, not the body: it is the one control used on every single
    // interaction, so it stays reachable with the window rolled up.
    const step = button('kc-button kc-button-primary wd-replay-step', busy ? '…' : 'Step', () => {
      void controller.step().then((r) => r && options.onStop?.(r))
    })
    step.disabled = busy
    step.title = `Advance ${controller.advance.multiple} × ${controller.advance.interval}`

    const collapse = button('kc-button kc-icon-button wd-float-collapse', win.collapsed ? '▾' : '▴', () => {
      win.setCollapsed(!win.collapsed)
      renderHeader()
    })
    collapse.title = win.collapsed ? 'Show the controls' : 'Roll up to the title bar'

    const exit = button('kc-button wd-replay-exit', 'Exit', () => options.onExit())
    exit.disabled = busy
    exit.title = 'Leave replay and return to the live wall'

    head.append(grip, title, clock, el('span', 'wd-float-spacer'), step, collapse, exit)
  }

  // -- the body ----------------------------------------------------------------------------

  function renderBody(): void {
    const body = win.body
    body.innerHTML = ''
    body.appendChild(renderAdvance())
    const last = controller.lastStop
    if (last) {
      // Absent until an advance has stopped: an empty row is a row of height for nothing.
      const stop = el('div', 'wd-replay-status')
      const reason = el('span', `wd-replay-stop-reason is-${last.reason}`)
      reason.textContent = describeStop(last, controller.signals.catalogue)
      reason.title = reason.textContent
      stop.appendChild(reason)
      body.appendChild(stop)
    }
    body.appendChild(renderToggles())
    if (panel === 'signals') body.appendChild(renderSignals())
    if (panel === 'settings') body.appendChild(renderSettings())
    win.reflow()
  }

  function renderAdvance(): HTMLElement {
    const row = el('div', 'wd-replay-row')
    const busy = controller.busy
    const label = el('span', 'wd-replay-label')
    label.textContent = 'Advance'
    const choices = advanceChoices(controller, options.intervalsInUse())
    const picker = select(
      choices.map((c) => ({ value: c, label: c })),
      controller.advance.interval,
      (value) => controller.setAdvance({ interval: value, multiple: controller.advance.multiple })
    )
    picker.title = 'Advance timeframe'
    picker.disabled = busy
    const times = el('span', 'wd-replay-times')
    times.textContent = '×'
    const multiple = numberInput(String(controller.advance.multiple), (raw) => {
      const n = Math.max(1, Math.floor(Number(raw) || 1))
      controller.setAdvance({ interval: controller.advance.interval, multiple: n })
    })
    multiple.title = 'How many candles'
    multiple.disabled = busy
    const next = button('kc-button kc-button-outline wd-replay-next', 'Next signal', () => {
      void controller.nextSignal().then((r) => r && options.onStop?.(r))
    })
    next.disabled = busy || controller.signals.armed.length === 0
    next.title = controller.signals.armed.length === 0 ? 'Arm a signal first' : 'Advance to the next armed signal'
    row.append(label, picker, times, multiple, next)
    return row
  }

  function renderToggles(): HTMLElement {
    const row = el('div', 'wd-replay-toggles')
    const book = controller.signals
    const published = book.catalogue.filter((e) => e.available).length
    const armed = book.armed.length

    const signals = toggleButton('Signals', armed > 0 ? String(armed) : '', panel === 'signals', () => showPanel('signals'))
    signals.disabled = published === 0
    signals.title = published === 0 ? 'No signal plugin publishes on this wall' : `${published} available, ${armed} armed`

    // The base is on the toggle itself: it decides how accurately every fill is priced, so
    // it should be legible without opening anything.
    const baseCheck = validateBase(controller.base, controller.intervalsInUse, controller.storedIntervals)
    const settings = toggleButton(`Base ${controller.base}`, '', panel === 'settings', () => showPanel('settings'))
    settings.classList.toggle('is-invalid', !baseCheck.ok)
    settings.title = baseCheck.ok ? 'Base timeframe and pause on fill' : (baseCheck.reason ?? '')
    row.append(signals, settings)

    if (options.account) {
      const account = options.account
      const open = account.isOpen()
      const toggle = toggleButton('Account', '', open, () => {
        account.toggle()
        renderBody()
      })
      toggle.title = open ? 'Hide the account, ticket and tables' : 'Show the account, ticket and tables'
      row.appendChild(toggle)
    }
    return row
  }

  function showPanel(next: PanelId): void {
    panel = panel === next ? null : next
    renderBody()
  }

  function renderSettings(): HTMLElement {
    const box = el('div', 'wd-replay-panel')
    const row = el('div', 'wd-replay-row')
    const label = el('span', 'wd-replay-label')
    label.textContent = 'Base'
    const baseCheck = validateBase(controller.base, controller.intervalsInUse, controller.storedIntervals)
    const basePicker = select(
      controller.storedIntervals.map((s) => ({ value: s, label: s })),
      controller.base,
      (value) => {
        const check = controller.setBase(value)
        if (!check.ok) flash(win.element, check.reason ?? 'Invalid base')
      }
    )
    basePicker.disabled = controller.busy
    basePicker.title = baseCheck.ok
      ? 'The interval the engine walks; finer = more accurate fills, more bars'
      : (baseCheck.reason ?? '')
    basePicker.classList.toggle('is-invalid', !baseCheck.ok)
    row.append(label, basePicker, checkbox('Pause on fill', controller.pauseOnFill, (on) => controller.setPauseOnFill(on)))
    box.appendChild(row)
    if (!baseCheck.ok) {
      const warn = el('div', 'wd-replay-warning')
      warn.textContent = baseCheck.reason ?? ''
      box.appendChild(warn)
    }
    return box
  }

  function renderSignals(): HTMLElement {
    const box = el('div', 'wd-replay-panel')
    const book = controller.signals
    const available = book.catalogue.filter((e) => e.available)
    if (available.length === 0) {
      const none = el('span', 'wd-replay-muted')
      none.textContent = 'none published'
      box.appendChild(none)
      return box
    }
    const list = el('div', 'wd-replay-signal-list')
    list.addEventListener('scroll', () => {
      signalScroll = list.scrollTop
    })
    // Starred first (the working shortlist), then the rest of the catalogue.
    const ordered = [...available].sort((a, b) => Number(book.isStarred(b.ref)) - Number(book.isStarred(a.ref)))
    const resolutions = sortByLength([...new Set(options.intervalsInUse())])
    for (const entry of ordered) {
      const row = el('div', 'wd-replay-signal')
      const starred = book.isStarred(entry.ref)
      const star = button(`wd-replay-star ${starred ? 'is-on' : ''}`, starred ? '★' : '☆', () => {
        book.star(entry.ref, !starred)
        controller.persist()
        renderBody()
      })
      star.title = starred ? 'Unstar' : 'Star (shortlist)'
      const name = el('span', `wd-replay-signal-name is-${entry.side ?? 'none'}`)
      name.textContent = `${entry.title}${entry.variant ? ` ${entry.variant}` : ''} · ${entry.label}`
      name.title = entry.description || entry.ref
      row.append(star, name)
      if (starred) {
        const arms = el('span', 'wd-replay-arms')
        for (const res of resolutions) {
          const armed = book.isArmed(entry.ref, res)
          const arm = button(`wd-replay-arm ${armed ? 'is-on' : ''}`, res, () => {
            book.arm(entry.ref, res, !armed)
            controller.persist()
            renderBody()
          })
          arm.title = armed ? `Armed on ${res}: click to disarm` : `Arm as a pause point on ${res}`
          arms.appendChild(arm)
        }
        row.appendChild(arms)
      }
      list.appendChild(row)
    }
    box.appendChild(list)
    // Assigned after the list is built but before it is on screen; the browser applies it on
    // the first layout, so re-rendering under the pointer does not jump the list.
    list.scrollTop = signalScroll
    return box
  }

  render()
  return {
    element: win.element,
    refresh: render,
    dispose(): void {
      unsubscribe()
      win.dispose()
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

/** A toggle in the window's footer: label, optional count badge, on/off. */
function toggleButton(label: string, badge: string, on: boolean, onClick: () => void): HTMLButtonElement {
  const b = button(`kc-button wd-replay-toggle${on ? ' is-on' : ''}`, label, onClick)
  b.setAttribute('aria-pressed', String(on))
  if (badge) {
    const count = el('span', 'wd-replay-badge')
    count.textContent = badge
    b.appendChild(count)
  }
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
