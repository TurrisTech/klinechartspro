import { dragByHandle } from '../chrome/drag'
import { zoneName } from '../time/format'
import { type BaseCheck, defaultBase, sortByLength, validateBase } from '../time/intervals'
import { type CandleGrid, fromWall, toWall } from '../time/timeframes'
import { button, chartTheme, checkbox, dayInput, el, select, toggleButton } from './dom'
import { defaultRange, randomStart, type StartRange } from './pick'
import { createSessionList, type SessionsSource } from './sessionlist'

// GLUE (DOM). The start dialog the rail's Replay button opens: plain DOM in the house style
// (`kc-*` tokens, `wd-replay-*` classes), centred on the app and dragged by its title. Two tabs
// when there is a session list (./sessionlist.ts):
//
//   New replay   the start form -- a date (typed, On chart (./pickbar.ts), or Random from an
//                optional day range), a balance and a base -- or, when the active pane's
//                instrument cannot start a replay, why not
//   Sessions     this owner's past replays: resume, score, delete
//
// Every date in it is read and written on the instrument's own clock, and named.

/** What every start dialog opens with: the wall it was asked from. */
interface StartDialogBase {
  anchor: HTMLElement
  /** The active pane's instrument, `vendor:TICKER`. */
  symbol: string
  intervalsInUse: string[]
}

interface StartDialogOptions extends StartDialogBase {
  /** The intervals the store holds for this instrument (probed by the caller). */
  stored: string[]
  /** Newest instant the store has for the instrument (the latest a replay can start). */
  latest: number
  /** The instrument's candle schedule: the default start and Random land on its candle opens,
   * and every date in the dialog is read and written on its clock. */
  grid: CandleGrid
  /** Choose the start by clicking a bar on the chart (./pickbar.ts): the dialog steps aside
   * while it runs and gets the bar's close back, or null when the pick was cancelled. Absent,
   * there is no "On chart" button. */
  pickOnChart?: (done: (startAt: number | null) => void) => void
  onStart: (choice: { startAt: number; balance: number; base: string }) => void
  /** This owner's past replays, for the Sessions tab. Absent, the dialog has no tabs. */
  sessions?: SessionsSource
}

/** The active pane's instrument cannot start a replay -- no market hours, nothing stored. The
 * dialog opens anyway, on Sessions, so every other replay stays one press away instead of out of
 * reach until the pane is moved; its New replay tab says why in place of the form. */
interface RefusedDialogOptions extends StartDialogBase {
  /** Why, in a few words: "No market hours for GBPUSD". */
  refusal: string
  sessions: SessionsSource
}

interface StartDialog {
  close(): void
}

/** Which tab the dialog last showed: per browser, a convenience. */
const DIALOG_TAB_KEY = 'wd.replay.dialogTab'
type DialogTab = 'new' | 'sessions'

function readTab(): DialogTab {
  try {
    return window.localStorage.getItem(DIALOG_TAB_KEY) === 'sessions' ? 'sessions' : 'new'
  } catch {
    return 'new'
  }
}

function writeTab(tab: DialogTab): void {
  try {
    window.localStorage.setItem(DIALOG_TAB_KEY, tab)
  } catch {
    // storage unavailable: the dialog opens on New
  }
}

export function openStartDialog(options: StartDialogOptions | RefusedDialogOptions): StartDialog {
  // The kc tokens are scoped under the chart's themed root (`.klinecharts-pro.dark`); a
  // body-level card has to carry the theme class itself or it renders in the light defaults.
  const overlay = el('div', `wd-replay-dialog-backdrop ${chartTheme()}`)
  // The card carries it too: src/app.css pins `.wd-replay-dialog` itself to a light
  // `color-scheme` unless the SAME element is `.dark`, and that scheme is what draws the native
  // parts -- the base select's popup, the session list's scrollbar -- which came out light on a
  // dark chart while the theme class sat only on the backdrop.
  const dialog = el('div', `wd-replay-dialog ${chartTheme()}`.trim())
  overlay.appendChild(dialog)
  const title = el('div', 'wd-replay-dialog-title')
  title.textContent = options.sessions ? 'Bar replay' : 'Start bar replay'
  title.title = 'Drag to move'
  dialog.appendChild(title)
  // Movable by its title, like the replay's own window: centred on the app is where it opens,
  // not necessarily where it should sit over the bars you are choosing between.
  const undrag = dragByHandle(dialog, title)

  // Two panes behind two tabs when there is a session list: New (the start form, or why this
  // instrument cannot start one) and Sessions (past replays: resume, score, delete).
  const newPane = el('div', 'wd-replay-dialog-pane')
  dialog.appendChild(newPane)

  const info = el('div', 'wd-replay-dialog-info')
  info.textContent = `${options.symbol.split(':')[1] ?? options.symbol} · panes: ${sortByLength(options.intervalsInUse).join(', ') || '—'}`
  newPane.appendChild(info)

  // New replay: the start form, or -- when this instrument cannot start one -- why not.
  const form = 'refusal' in options ? mountRefusal(newPane, options.refusal, close) : mountStartForm(newPane, options, { overlay, close })
  // A refused dialog opens on Sessions (and does not remember it): that tab is the one with
  // something to do.
  const sessionsTab = options.sessions ? mountSessionsTab(dialog, options.sessions, () => close(), 'refusal' in options ? 'sessions' : null) : null

  const onKey = (e: KeyboardEvent): void => {
    // Stepped aside for a pick on the chart: the keys are the pick's (Escape cancels IT).
    if (overlay.hidden) return
    if (e.key === 'Escape') close()
    // Enter starts, from any field of the form. Never from the Sessions tab, which has no Start
    // to press.
    else if (e.key === 'Enter' && !newPane.hidden) form.enter(e)
  }
  document.addEventListener('keydown', onKey)
  // Only a click that both STARTED and ended on the backdrop closes it. A click is dispatched to
  // the nearest common ancestor of the press and the release, so a drag of the title -- or a
  // text selection in a field -- released over the backdrop arrives as a click on it.
  let pressedBackdrop = false
  overlay.addEventListener('pointerdown', (e) => {
    pressedBackdrop = e.target === overlay
  })
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && pressedBackdrop) close()
    pressedBackdrop = false
  })
  // Centred on the APP, not over the active pane (chrome/focus.ts's rule for a very wide page):
  // a replay is the whole wall's mode -- it rebuilds every pane on one clock -- so the dialog
  // that starts one belongs to no single pane (user, 2026-10-04).
  document.body.appendChild(overlay)
  if (!newPane.hidden) form.focus()

  function close(): void {
    document.removeEventListener('keydown', onKey)
    sessionsTab?.dispose()
    undrag()
    overlay.remove()
  }
  return { close }

  /** The Sessions tab and the tab bar: the bar goes in above the New pane, the list after it. */
  function mountSessionsTab(root: HTMLElement, source: SessionsSource, closeDialog: () => void, opening: DialogTab | null): { dispose(): void } {
    const tabs = el('div', 'wd-replay-dialog-tabs')
    tabs.setAttribute('role', 'tablist')
    root.insertBefore(tabs, newPane)
    const pane = el('div', 'wd-replay-dialog-pane')
    root.appendChild(pane)

    let tab: DialogTab = opening ?? readTab()
    let loaded = false
    const list = createSessionList({
      source,
      empty: 'No past replays. Start one from New replay; it is kept here to resume.',
      // The dialog goes first: a resume rebuilds the wall under it.
      beforeResume: () => {
        closeDialog()
        return true
      },
      onRender: () => {
        // Remembered on a list that has since emptied: open on what there is to do.
        const switched = !loaded && list.count === 0 && tab === 'sessions'
        if (list.count !== null) loaded = true
        if (switched) tab = 'new'
        renderTabs()
        if (switched && document.activeElement === document.body) form.focus()
      }
    })
    pane.appendChild(list.element)

    function show(next: DialogTab): void {
      tab = next
      writeTab(next)
      renderTabs()
      if (next === 'new') form.focus()
    }

    function renderTabs(): void {
      newPane.hidden = tab !== 'new'
      pane.hidden = tab !== 'sessions'
      tabs.innerHTML = ''
      const newTab = toggleButton('New replay', '', tab === 'new', () => show('new'))
      const count = list.count === null || list.count === 0 ? '' : String(list.count)
      const listTab = toggleButton('Sessions', count, tab === 'sessions', () => show('sessions'))
      for (const b of [newTab, listTab]) b.setAttribute('role', 'tab')
      listTab.title = 'Your past replays: resume one, see its score, or delete it'
      tabs.append(newTab, listTab)
    }

    renderTabs()
    return { dispose: () => list.dispose() }
  }
}

/** The New replay tab's content: the start form, or why there is none (`mountRefusal`). */
interface NewReplayPane {
  /** Its first field, or its one button. */
  focus(): void
  /** Enter, pressed while the tab shows. */
  enter(e: KeyboardEvent): void
}

/** The start form, into the New replay pane. `dialog.overlay` is hidden while a pick on the chart
 * runs; `dialog.close` is Cancel, and what Start does after handing the choice over. */
function mountStartForm(newPane: HTMLElement, options: StartDialogOptions, dialog: { overlay: HTMLElement; close: () => void }): NewReplayPane {
  const suggested = defaultBase(options.intervalsInUse, options.stored)
  const initialBase = suggested ?? options.stored[0] ?? '1m'

  const grid = options.grid
  const zone = grid.schedule.timezone
  const toLocalInputValue = (ms: number): string => localInputValue(ms, zone)
  const fromLocalInputValue = (value: string): number | null => instantOfInput(value, zone)
  const toDayInputValue = (ms: number): string => localInputValue(ms, zone).slice(0, 10)
  const defaultStart = defaultStartAt(initialBase, options.latest, grid)
  // The instrument's own clock, named: a coinbase replay is chosen in UTC, as its chart reads.
  const startField = field(`Start (${zoneName(zone)})`)
  const startRow = el('div', 'wd-replay-dialog-row')
  const startInput = dateInput(toLocalInputValue(defaultStart))
  startInput.max = toLocalInputValue(options.latest)
  startRow.appendChild(startInput)
  // The two ways to set the start without typing a date sit next to the field they write.
  // "On chart" first: pointing at the bar you want is how a start is usually found.
  if (options.pickOnChart) {
    const pickOnChart = options.pickOnChart
    const pick = button('kc-button kc-button-outline wd-replay-pick-button', 'On chart', () => {
      dialog.overlay.hidden = true
      pickOnChart((startAt) => {
        dialog.overlay.hidden = false
        if (startAt !== null) {
          startInput.value = toLocalInputValue(Math.min(startAt, options.latest))
          baseError.textContent = ''
          start.focus()
        } else pick.focus()
      })
    })
    pick.title = 'Click a bar on the chart: the replay opens with that bar as the last one shown'
    startRow.appendChild(pick)
  }
  const random = button('kc-button kc-button-outline wd-replay-random', 'Random', () => roll())
  random.title = 'Pick a random start date from the range'
  startRow.appendChild(random)
  startField.appendChild(startRow)
  const startNote = el('div', 'wd-replay-dialog-note')
  startNote.textContent = 'The replay opens with every bar that had closed by then.'
  startField.appendChild(startNote)
  newPane.appendChild(startField)

  // -- the range Random draws from (optional; hidden until asked for) ---------------------

  const initialRange = defaultRange(options.latest)
  const rangeField = el('div', 'wd-replay-field')
  const rangeBody = el('div', 'wd-replay-dialog-range')
  rangeBody.hidden = true
  const rangeError = el('div', 'kc-field-error wd-replay-dialog-error')
  rangeField.appendChild(
    checkbox('Draw from a date range', false, (on) => {
      rangeBody.hidden = !on
      rangeError.textContent = ''
    })
  )
  // Day granularity: a draw range does not need a time of day, and two datetime-locals side
  // by side in a 28rem dialog render their value under the picker icon.
  const fromInput = dayInput(toDayInputValue(initialRange.from))
  const toInput = dayInput(toDayInputValue(initialRange.to))
  toInput.max = toDayInputValue(options.latest)
  rangeBody.append(labelled('From', fromInput), labelled('To', toInput))
  rangeField.appendChild(rangeBody)
  const rangeNote = el('div', 'wd-replay-dialog-note')
  rangeNote.textContent = 'Random picks a candle open inside this range. Unchecked, it draws from the last two years.'
  rangeField.appendChild(rangeNote)
  rangeField.appendChild(rangeError)
  newPane.appendChild(rangeField)

  /** The range Random draws from: the two inputs when they are showing, else the default. */
  function drawRange(): StartRange | null {
    if (rangeBody.hidden) return defaultRange(options.latest)
    // From is that day's first instant, To its last: the range reads as inclusive of both days.
    const from = fromLocalInputValue(`${fromInput.value}T00:00`)
    const to = fromLocalInputValue(`${toInput.value}T23:59`)
    if (from === null || to === null) {
      rangeError.textContent = 'Enter both range dates'
      return null
    }
    if (to <= from) {
      rangeError.textContent = 'The range ends before it starts'
      return null
    }
    return { from, to: Math.min(to, options.latest) }
  }

  function roll(): void {
    const range = drawRange()
    if (!range) return
    rangeError.textContent = ''
    startInput.value = toLocalInputValue(randomStart(range, basePicker.value, grid))
    baseError.textContent = ''
  }

  const balanceField = field('Starting balance')
  const balanceInput = numberInput('10000', () => {})
  balanceField.appendChild(balanceInput)
  newPane.appendChild(balanceField)

  const baseField = field('Base timeframe')
  const basePicker = select(
    options.stored.map((s) => ({ value: s, label: s === suggested ? `${s} (recommended)` : s })),
    initialBase,
    () => validate()
  )
  baseField.appendChild(basePicker)
  const baseNote = el('div', 'wd-replay-dialog-note')
  baseNote.textContent = 'The interval the engine walks: a finer base gives more accurate fills and more bars to walk. It must divide every pane interval and be stored for the instrument.'
  baseField.appendChild(baseNote)
  const baseError = el('div', 'kc-field-error wd-replay-dialog-error')
  baseField.appendChild(baseError)
  newPane.appendChild(baseField)

  const actions = el('div', 'wd-replay-dialog-actions')
  const cancel = button('kc-button kc-button-outline', 'Cancel', () => dialog.close())
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
    dialog.close()
  })
  actions.append(cancel, start)
  newPane.appendChild(actions)

  function validate(): BaseCheck {
    const check = validateBase(basePicker.value, options.intervalsInUse, options.stored)
    baseError.textContent = check.ok ? '' : (check.reason ?? '')
    start.disabled = !check.ok
    return check
  }
  validate()

  return {
    focus: () => startInput.focus(),
    enter: (e) => {
      // A focused button answers Enter itself, and a select uses it to commit its list.
      if (e.target instanceof HTMLButtonElement || e.target instanceof HTMLSelectElement || start.disabled) return
      e.preventDefault()
      start.click()
    }
  }
}

/** The New replay pane when this instrument cannot start a replay: the reason, what to do, and
 * Close -- no form to fill for a Start that could only fail. */
function mountRefusal(pane: HTMLElement, refusal: string, close: () => void): NewReplayPane {
  const reason = el('div', 'kc-field-error wd-replay-dialog-error')
  reason.setAttribute('role', 'status')
  reason.textContent = refusal
  const note = el('div', 'wd-replay-dialog-note')
  note.textContent = 'A new replay cannot start here. Move the active pane to another instrument to start one, or resume a past replay from Sessions.'
  const actions = el('div', 'wd-replay-dialog-actions')
  const done = button('kc-button kc-button-outline', 'Close', () => close())
  actions.appendChild(done)
  pane.append(reason, note, actions)
  return { focus: () => done.focus(), enter: () => {} }
}

/** The start the dialog offers: a week before the newest bar, on a base candle open -- the
 * instant Start will actually use, not whatever minute the dialog happened to open at -- and
 * inside the market week. A week before a weekend afternoon is a weekend afternoon, and a
 * replay opened there shows Friday's close and makes the first Step cross two days of nothing;
 * this backs off, an hour at a time, to the last candle that opened while the market traded.
 * (Random is deliberately NOT treated like this: see pick.ts.) */
export function defaultStartAt(base: string, latest: number, grid: CandleGrid): number {
  let at = grid.start(base, latest - 7 * DAY_MS)
  for (let i = 0; i < 24 * 7 && !grid.isOpen(at); i++) at = grid.start(base, at - HOUR_MS)
  return at
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

// The instrument's wall clock <-> the datetime-local input, which is timezone-less text. Through
// the replay's own wall-clock conversion (timeframes.ts), which resolves a DST gap and a repeated
// hour the way wmarkettypes does.

/** `YYYY-MM-DDTHH:MM` of an instant on `zone`'s wall clock. */
function localInputValue(ms: number, zone: string): string {
  return new Date(toWall(ms, zone)).toISOString().slice(0, 16)
}

/** The instant a `YYYY-MM-DDTHH:MM` reading names on `zone`'s wall clock; null when unreadable. */
function instantOfInput(value: string, zone: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi] = m.slice(1).map(Number)
  return fromWall(Date.UTC(y, mo - 1, d, h, mi), zone)
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

function dateInput(value: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'datetime-local'
  input.className = 'kc-input wd-replay-input'
  input.step = '60'
  input.value = value
  return input
}

/** A caption above a control, for the two range inputs sitting side by side. */
function labelled(text: string, control: HTMLElement): HTMLElement {
  const wrap = el('label', 'wd-replay-field')
  const l = el('span', 'wd-replay-label')
  l.textContent = text
  wrap.append(l, control)
  return wrap
}

function field(label: string): HTMLElement {
  const wrap = el('label', 'wd-replay-field')
  const l = el('span', 'wd-replay-label')
  l.textContent = label
  wrap.appendChild(l)
  return wrap
}
