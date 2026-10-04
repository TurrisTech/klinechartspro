import type { SignalCatalogueEntry } from '../plugins/types'
import { Arming } from '../trading/kit'
import { formatClock } from './format'
import { defaultRange, randomStart, type StartRange } from './pick'
import { DEFAULT_PLAY_DELAY_MS, PLAY_DELAYS_MS, ReplayPlayer } from './player'
import type { AdvanceResult, ReplayController } from './session'
import { type BaseCheck, defaultBase, intervalStart, isMarketOpen, sortByLength, validateBase } from './timeframes'
import { dragByHandle } from '../chrome/drag'
import { createDockableWindow } from '../chrome/window'

// GLUE (DOM). The replay controls and the start dialog: plain DOM in the house style
// (`kc-*` tokens, `wd-*` classes), driven by a `ReplayController` they do not implement.
//
// The controls live in a DOCKABLE WINDOW (../chrome/window.ts) — floating over the chart by
// default, docked below it on request — not in a strip nailed inside the trading panel. Only
// what is used on every step is on screen:
//
//   title bar   the instrument and the replay's clock, roll up, dock/float -- the drag handle,
//               with nothing in it that acts on the replay
//   transport   Play and Step, each beside the setting it uses (timeframe x multiple, the pace)
//   next        Next signal, and how far a running walk has got or why the last advance stopped
//   footer      Signals / Base, one panel open at a time; Account and Trade, the two windows;
//               Exit replay, set apart at the far end
//
// The signal list, the base timeframe and pause-on-fill are all one click away instead of
// permanently on screen, and the account window and the trade box are opened from here rather
// than taking half the wall from the moment replay starts.
//
// KEYS (TradingView's, so the hands already know them): Shift+→ is Step (Stop while an advance
// runs) and Shift+↓ is Play/Pause. Shift+→ is klinecharts' own "scroll right"; on a replay wall
// the replay takes it, which is why the listener is on `window` in the capture phase.

/** Identity of the window: its stored placement, and `data-window` on the card. */
const WINDOW_KEY = 'replay'

/** The controls sit ABOVE the account when both are docked. */
const DOCK_ORDER = 10

/** The play pace, per browser: a viewer's preference, not part of the replay. */
const PLAY_DELAY_KEY = 'wd.replay.playDelay'

/** The Exit button's key in its two-press arming. */
const EXIT = 'exit'

/** How long an advance runs before the controls show that it is running. A one-candle step
 * lands well inside this, and the controls flipping to a red Stop and greying out on every Step
 * -- twice a second while playing -- was noise, not information. A walk long enough to report
 * its progress, or a Stop already pressed, shows at once. */
const BUSY_REVEAL_MS = 300

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
  /** Resolves once the wall has loaded what the last step made it refetch: Play waits for it
   * between steps as well as for its pace, so it cannot outrun the server. */
  settled?: () => Promise<void>
  /** The trading dock the Account toggle shows and hides. */
  account?: { isOpen: () => boolean; toggle: () => boolean }
  /** The trade box (the order ticket's floating window) the Trade toggle shows and hides. */
  trade?: { isOpen: () => boolean; toggle: () => boolean }
  /** Injected by the tests: the wait between two played steps. */
  sleep?: (ms: number) => Promise<void>
  /** How long an advance runs before the controls show it (BUSY_REVEAL_MS). The tests pass 0. */
  busyRevealMs?: number
}

export interface ReplayControls {
  readonly element: HTMLElement
  /** Re-render: the intervals in use changed, or the dock was opened from outside. */
  refresh(): void
  dispose(): void
}

export function createReplayControls(options: ReplayControlsOptions): ReplayControls {
  const { controller } = options
  const win = createDockableWindow({
    key: WINDOW_KEY,
    className: 'wd-replay-window',
    title: 'Replay',
    bounds: options.bounds,
    theme: chartTheme(),
    defaultMode: 'float',
    order: DOCK_ORDER,
    // Docked, the rows lay out along one line instead of stacking, so the strip costs the
    // wall a single row rather than three (the CSS branches on `data-mode`); the toggles'
    // labels shorten to match.
    onModeChange: () => render()
  })
  let panel: PanelId = null
  // The signal list is the only scrollable thing here and every step re-renders the body,
  // so its scroll position is carried across a render rather than snapping back to the top.
  let signalScroll = 0
  // The status row's walk line while a walk is in progress, so a progress report can patch it.
  let walkLine: HTMLElement | null = null
  // Whether the running advance has gone on long enough to show (BUSY_REVEAL_MS).
  const revealAfter = options.busyRevealMs ?? BUSY_REVEAL_MS
  let revealed = false
  let revealTimer: ReturnType<typeof setTimeout> | null = null

  /** Follow the controller's busy flag into `revealed`, arming the timer that shows it. */
  function trackBusy(): void {
    if (!controller.busy) {
      if (revealTimer) clearTimeout(revealTimer)
      revealTimer = null
      revealed = false
      return
    }
    if (revealed || revealTimer) return
    if (revealAfter <= 0) {
      revealed = true
      return
    }
    revealTimer = setTimeout(() => {
      revealTimer = null
      if (!controller.busy) return
      revealed = true
      render()
    }, revealAfter)
  }

  /** The advance running, as the controls show it: not for its first BUSY_REVEAL_MS. */
  function busyShown(): boolean {
    return controller.busy && (revealed || controller.cancelling || controller.walkedTo !== null)
  }
  // Exit throws the replay away -- nothing lists a replay to reopen -- and it sits beside Step,
  // the button pressed most. So it takes two presses, the trading kit's rule for anything that
  // cannot be taken back.
  const arming = new Arming(() => renderBody())
  const player = new ReplayPlayer({
    step: () => controller.step(),
    settled: options.settled,
    onResult: (r) => options.onStop?.(r),
    onChange: () => {
      writeDelay(player.delayMs)
      render()
    },
    sleep: options.sleep,
    delayMs: readDelay()
  })
  const unsubscribe = controller.onControlChange((change) => {
    // A progress report moves one date, several times a second: patch that line. Rebuilding
    // the window instead would replace the Stop button under a pointer pressing it, and a
    // press released on the new button is no click at all.
    const walked = controller.walkedTo
    if (change === 'walk' && walked !== null && walkLine) showWalk(walkLine, walked)
    else render()
  })

  // -- what the buttons (and their keys) do -------------------------------------------------

  /** Step, or Stop while an advance runs. Either way a play in progress ends: a Step pressed
   * by hand means "I'll take it from here". */
  function pressStep(): void {
    if (controller.busy) {
      // Stop -- but only once the button SAYS Stop. In an advance's first moments it still reads
      // Step, and a quick second click (a double click, a repeat) must not cancel the step it
      // is waiting on.
      if (!busyShown()) return
      player.pause()
      controller.cancel()
      return
    }
    player.pause()
    void controller.step().then((r) => r && options.onStop?.(r))
  }

  function pressPlay(): void {
    // Busy with an advance the player did not start (a Next signal run): Play waits for it.
    if (!player.playing && controller.busy) return
    player.toggle()
  }

  const onKey = (event: KeyboardEvent): void => {
    if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown') return
    if (isEditable(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'ArrowRight') {
      // Held down, the key repeats: each repeat is another step, but never a Stop -- a step
      // still landing must not be cancelled by the same finger that asked for the next one.
      if (event.repeat && controller.busy) return
      pressStep()
    } else if (!event.repeat) pressPlay()
  }
  window.addEventListener('keydown', onKey, true)

  function render(): void {
    trackBusy()
    renderHeader()
    renderBody()
  }

  // -- the title bar (visible collapsed, and the drag handle) -----------------------------

  function renderHeader(): void {
    // The title bar is the window's identity and its state -- which instrument, what time it is
    // in the replay -- and the window's own controls (roll up, dock). Nothing in it acts on the
    // replay: Play, Step and Exit are in the body, where a press on them is never a press on the
    // drag handle and the transport reads as one group (user, 2026-10-04: "move the Step and
    // play button out of the title area"). Rolled up, the keys still play and step.
    win.titleSlot.innerHTML = ''
    win.actions.innerHTML = ''
    const symbol = el('span', 'wd-replay-symbol')
    symbol.textContent = controller.symbol.split(':')[1] ?? controller.symbol
    symbol.title = `The replay walks ${controller.symbol}`
    // The chart's position, which is where the running advance STARTED until it lands: a walk
    // moves `cursor` bar by bar far ahead of the panes, and this re-renders mid-walk (a Stop
    // click, the walk's first progress report), so reading `cursor` here would show the walk's
    // reach as if the chart were there.
    const at = controller.advanceFrom ?? controller.cursor
    const clock = el('span', 'wd-replay-clock-value')
    clock.textContent = formatClock(at)
    clock.title = `${new Date(at).toISOString()} — the replay's clock, New York time. Every pane shows the bars that had closed by then.`
    win.titleSlot.append(symbol, clock)
  }

  // -- the body ----------------------------------------------------------------------------
  //
  //   [▶] [Step]  [1h v] × [1]  every [1 s v]      transport: each button beside what it uses
  //   [Next signal]  Stepped 1h                     the other way to move, and why it stopped
  //   Signals 1  Base 1h  Account  Trade    Exit replay   panels and windows; Exit set apart

  function renderBody(): void {
    const body = win.body
    body.innerHTML = ''
    walkLine = null
    body.append(renderTransport(), renderNext(), renderToggles())
    if (panel === 'signals') body.appendChild(renderSignals())
    if (panel === 'settings') body.appendChild(renderSettings())
    win.reflow()
  }

  function showWalk(line: HTMLElement, walked: number): void {
    line.textContent = `Walking… reached ${formatClock(walked)}`
    line.title = `How far the walk has checked the bars (${new Date(walked).toISOString()}). The chart and the clock move when it stops.`
  }

  /** Play and Step, each beside the setting it uses: "Step 1h × 1", "play every 1 s". */
  function renderTransport(): HTMLElement {
    const row = el('div', 'wd-replay-row wd-replay-transport')
    const busy = busyShown()
    const playing = player.playing
    const play = iconButton(`kc-button wd-replay-play${playing ? ' is-on' : ''}`, playing ? PAUSE_ICON : PLAY_ICON, pressPlay)
    play.setAttribute('aria-label', playing ? 'Pause' : 'Play')
    play.setAttribute('aria-pressed', String(playing))
    play.disabled = busy && !playing
    play.title = playing
      ? 'Pause after this step (Shift+↓)'
      : `Play: step ${describeAdvance(controller.advance)} every ${delayLabel(player.delayMs)} until a fill, a signal or a watch stops it (Shift+↓)`

    // While an advance runs -- a Step or Next signal -- the same button stops it, at the next
    // base bar.
    const cancelling = controller.busy && controller.cancelling
    const label = !busy ? 'Step' : cancelling ? 'Stopping…' : 'Stop'
    const step = button('kc-button kc-button-primary wd-replay-step', label, pressStep)
    step.classList.toggle('is-stop', busy)
    step.disabled = cancelling
    step.title = busy ? 'Stop at the next bar (Shift+→)' : `Advance ${describeAdvance(controller.advance)} (Shift+→)`

    // How far one Step goes. The Step button is this group's label: it reads "Step 1h × 1".
    const size = el('span', 'wd-replay-group')
    const choices = advanceChoices(controller, options.intervalsInUse())
    const picker = select(
      choices.map((c) => ({ value: c, label: c })),
      controller.advance.interval,
      (value) => controller.setAdvance({ interval: value, multiple: controller.advance.multiple })
    )
    picker.title = 'How far one Step goes: this timeframe…'
    picker.setAttribute('aria-label', 'Step timeframe')
    picker.disabled = busy
    const times = el('span', 'wd-replay-times')
    times.textContent = '×'
    const multiple = numberInput(String(controller.advance.multiple), (raw) => {
      const n = Math.max(1, Math.floor(Number(raw) || 1))
      controller.setAdvance({ interval: controller.advance.interval, multiple: n })
    })
    multiple.title = '…times this many candles'
    multiple.setAttribute('aria-label', 'Candles per step')
    multiple.disabled = busy
    size.append(picker, times, multiple)

    // The pace Play steps at. Never disabled: slowing down is most wanted while playing.
    const paceGroup = el('span', 'wd-replay-group')
    const every = el('span', 'wd-replay-every')
    every.textContent = 'every'
    const pace = select(
      PLAY_DELAYS_MS.map((ms) => ({ value: String(ms), label: delayLabel(ms) })),
      String(player.delayMs),
      (value) => player.setDelay(Number(value))
    )
    pace.classList.add('wd-replay-pace')
    pace.title = 'Play: the time between two steps (it also waits for the chart to load)'
    pace.setAttribute('aria-label', 'Play speed')
    paceGroup.append(every, pace)

    row.append(play, step, size, paceGroup)
    return row
  }

  /** Next signal, and beside it what the replay is doing or why it last stopped. */
  function renderNext(): HTMLElement {
    const row = el('div', 'wd-replay-row wd-replay-next-row')
    const busy = busyShown()
    const next = button('kc-button kc-button-outline wd-replay-next', 'Next signal', () => {
      if (controller.busy) return
      player.pause()
      void controller.nextSignal().then((r) => r && options.onStop?.(r))
    })
    // An armed price watch is a stop too, so a wall with watches and no signals can still run
    // to the next one.
    const stops = controller.signals.armed.length + controller.armedStops
    next.disabled = busy || stops === 0
    next.title = stops === 0 ? 'Arm a signal or place a price watch first' : 'Advance to the next armed signal or price watch'
    row.appendChild(next)

    const walked = controller.walkedTo
    const last = controller.lastStop
    if (walked !== null) {
      // A walk in progress replaces the last stop's reason, which is stale by now anyway. In the
      // body and not the title bar: the date is the walk's reach, ahead of everything drawn, and
      // must not read as the replay's clock.
      walkLine = el('span', 'wd-replay-walk')
      showWalk(walkLine, walked)
      row.appendChild(walkLine)
    } else if (player.playing) {
      // Playing: every step's "Stepped 1h" would say the same thing twice a second. When the play
      // stops by itself this gives way to why it stopped, which is the line worth reading.
      const playingLine = el('span', 'wd-replay-stop-reason is-playing')
      playingLine.textContent = `Playing every ${delayLabel(player.delayMs)}`
      playingLine.title = 'Stops by itself at a fill pause, an armed signal, a price watch or the end of the data (Shift+↓ pauses)'
      row.appendChild(playingLine)
    } else if (last) {
      // Absent until an advance has stopped.
      const reason = el('span', `wd-replay-stop-reason is-${last.reason}`)
      reason.textContent = describeStop(last, controller.signals.catalogue)
      reason.title = reason.textContent
      row.appendChild(reason)
    }
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
      toggle.title = open ? 'Hide the account and tables' : 'Show the account and tables'
      row.appendChild(toggle)
    }
    if (options.trade) {
      const trade = options.trade
      const open = trade.isOpen()
      const toggle = toggleButton('Trade', '', open, () => {
        trade.toggle()
        renderBody()
      })
      toggle.title = open ? 'Hide the order ticket' : 'Buy or sell: show the order ticket'
      row.appendChild(toggle)
    }

    // Exit, at the far end of the footer: the one control here that ends the session, as far
    // from Play and Step as the window allows, and two presses besides.
    const armedExit = arming.key === EXIT
    const exit = button(`kc-button wd-replay-exit${armedExit ? ' is-armed' : ''}`, armedExit ? 'Confirm exit' : 'Exit replay', () => {
      // Never mid-advance: leaving rebuilds the wall under a session still walking.
      if (controller.busy) return
      if (!arming.press(EXIT, false)) return
      player.pause()
      options.onExit()
    })
    exit.disabled = busyShown()
    exit.title = armedExit
      ? 'Press again to leave. This replay, its account and its orders cannot be reopened.'
      : 'Leave replay and return to the live wall'
    row.appendChild(exit)
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
    basePicker.disabled = busyShown()
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
    // What arming is FOR, said once: the list is otherwise a wall of names and timeframes.
    const help = el('div', 'wd-replay-muted wd-replay-signal-help')
    help.textContent = 'Arm a signal on a timeframe and Next signal stops at it. ☆ keeps it at the top.'
    box.appendChild(help)
    const list = el('div', 'wd-replay-signal-list')
    list.addEventListener('scroll', () => {
      signalScroll = list.scrollTop
    })
    const resolutions = sortByLength([...new Set(options.intervalsInUse())])

    const row = (entry: SignalCatalogueEntry, name: string): HTMLElement => {
      const node = el('div', 'wd-replay-signal')
      const starred = book.isStarred(entry.ref)
      const star = button(`wd-replay-star ${starred ? 'is-on' : ''}`, starred ? '★' : '☆', () => {
        book.star(entry.ref, !starred)
        controller.persist()
        renderBody()
      })
      star.title = starred ? 'Unstar (also disarms it)' : 'Star: keep it at the top of the list'
      const text = el('span', `wd-replay-signal-name is-${entry.side ?? 'none'}`)
      text.textContent = name
      text.title = entry.description ? `${fullName(entry)}: ${entry.description}` : fullName(entry)
      // The arm buttons are on EVERY row: arming is the point of the list, and hiding it behind
      // the star left a first-time user with nothing to press. Arming stars (the book's rule).
      const arms = el('span', 'wd-replay-arms')
      for (const res of resolutions) {
        const armed = book.isArmed(entry.ref, res)
        const arm = button(`wd-replay-arm ${armed ? 'is-on' : ''}`, res, () => {
          book.arm(entry.ref, res, !armed)
          controller.persist()
          renderBody()
        })
        arm.title = armed ? `Armed on ${res}: Next signal stops here. Click to disarm` : `Arm on ${res}: Next signal stops at it`
        arm.setAttribute('aria-pressed', String(armed))
        arms.appendChild(arm)
      }
      node.append(star, text, arms)
      return node
    }

    // The shortlist first, under its own heading and by its full name (it mixes plugins); then
    // the rest of the catalogue grouped by plugin, each row named by what tells it apart there.
    const starred = available.filter((e) => book.isStarred(e.ref))
    if (starred.length > 0) {
      list.appendChild(groupHeading('Starred'))
      for (const entry of starred) list.appendChild(row(entry, fullName(entry)))
    }
    for (const [title, entries] of groupByTitle(available.filter((e) => !book.isStarred(e.ref)))) {
      list.appendChild(groupHeading(title))
      for (const entry of entries) list.appendChild(row(entry, shortName(entry)))
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
      if (revealTimer) clearTimeout(revealTimer)
      window.removeEventListener('keydown', onKey, true)
      player.dispose()
      arming.disarm()
      unsubscribe()
      win.dispose()
    }
  }
}

function advanceChoices(controller: ReplayController, inUse: string[]): string[] {
  return sortByLength([...new Set([controller.base, ...controller.storedIntervals, ...inUse, controller.advance.interval])])
}

/** "1h" for one candle, "3 × 15m" for several. */
function describeAdvance(advance: { interval: string; multiple: number }): string {
  return advance.multiple === 1 ? advance.interval : `${advance.multiple} × ${advance.interval}`
}

/** "¼ s", "1 s": the pace picker's labels. */
export function delayLabel(ms: number): string {
  const fractions: Record<number, string> = { 250: '¼ s', 500: '½ s' }
  return fractions[ms] ?? `${ms / 1000} s`
}

function readDelay(): number {
  try {
    const stored = Number(window.localStorage.getItem(PLAY_DELAY_KEY))
    return (PLAY_DELAYS_MS as readonly number[]).includes(stored) ? stored : DEFAULT_PLAY_DELAY_MS
  } catch {
    return DEFAULT_PLAY_DELAY_MS
  }
}

function writeDelay(ms: number): void {
  try {
    window.localStorage.setItem(PLAY_DELAY_KEY, String(ms))
  } catch {
    // A private window or blocked storage: the pace just is not remembered.
  }
}

/** A key typed into a field is the field's, not a shortcut -- and so is an arrow pressed on a
 * focused pane grip, which moves its pane through the wall with any arrow, Shift or not. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || target.isContentEditable || target.closest('.klinecharts-pro-pane-grip') !== null
}

/** "AREV arev21 · long": the plugin, its variant and the label, for a row out of its group. */
function fullName(entry: SignalCatalogueEntry): string {
  return `${entry.title} ${shortName(entry)}`.trim()
}

/** What tells a signal apart INSIDE its plugin's group: the catalogue repeats the plugin in the
 * variant ("arev21_outlier_rank" under "AREV21 outlier") and in the label ("AREV long" under
 * "AREV"), and three AREVs per row is how the list read before. */
function shortName(entry: SignalCatalogueEntry): string {
  const slug = `${entry.title.toLowerCase().replace(/\s+/g, '_')}_`
  const variant = entry.variant?.toLowerCase().startsWith(slug) ? entry.variant.slice(slug.length) : (entry.variant ?? '')
  const titled = `${entry.title.toLowerCase()} `
  const label = entry.label.toLowerCase().startsWith(titled) ? entry.label.slice(titled.length) : entry.label
  return [variant, label].filter((part) => part.length > 0).join(' · ')
}

/** Catalogue order kept, both for the groups and inside them. */
function groupByTitle(entries: SignalCatalogueEntry[]): Map<string, SignalCatalogueEntry[]> {
  const groups = new Map<string, SignalCatalogueEntry[]>()
  for (const entry of entries) {
    const group = groups.get(entry.title)
    if (group) group.push(entry)
    else groups.set(entry.title, [entry])
  }
  return groups
}

function groupHeading(text: string): HTMLElement {
  const heading = el('div', 'wd-replay-signal-group')
  heading.textContent = text
  return heading
}

function describeStop(result: AdvanceResult, catalogue: readonly SignalCatalogueEntry[]): string {
  switch (result.reason) {
    case 'signal': {
      const entry = catalogue.find((e) => e.ref === result.signal?.ref)
      const name = entry ? fullName(entry) : (result.signal?.ref ?? 'signal')
      return `Stopped at ${name} @${result.signal?.resolution ?? ''}`
    }
    case 'fill':
      return `Paused on ${result.events.some((e) => e.kind === 'fill') ? 'a fill' : 'a close'}`
    case 'watch': {
      const [first, ...rest] = result.observed
      return `Stopped at watch ${first?.label ?? ''}${rest.length > 0 ? ` +${rest.length}` : ''}`
    }
    case 'cancel':
      return result.bars.length > 0
        ? `Stopped by you after ${result.bars.length} bar${result.bars.length === 1 ? '' : 's'}`
        : 'Stopped by you before the first bar'
    case 'end':
      return 'End of data'
    default:
      // What was asked for, which is what happened. Not the bars walked: whether the engine
      // walked them or seeked over the span (nothing working could fill) is the replay's
      // business, and "Jumped — nothing working" on a plain one-candle step read as an error.
      return 'interval' in result.request ? `Stepped ${describeAdvance(result.request)}` : 'Advanced'
  }
}

const PLAY_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 2.75v10.5L13 8z" fill="currentColor"/></svg>'
const PAUSE_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="2.75" width="3" height="10.5" rx="0.75" fill="currentColor"/><rect x="9.5" y="2.75" width="3" height="10.5" rx="0.75" fill="currentColor"/></svg>'

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
  /** Choose the start by clicking a bar on the chart (./pickbar.ts): the dialog steps aside
   * while it runs and gets the bar's close back, or null when the pick was cancelled. Absent,
   * there is no "On chart" button. */
  pickOnChart?: (done: (startAt: number | null) => void) => void
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
  title.title = 'Drag to move'
  dialog.appendChild(title)
  // Movable by its title, like the replay's own window: centred on the app is where it opens,
  // not necessarily where it should sit over the bars you are choosing between.
  const undrag = dragByHandle(dialog, title)

  const info = el('div', 'wd-replay-dialog-info')
  info.textContent = `${options.symbol.split(':')[1] ?? options.symbol} · panes: ${sortByLength(options.intervalsInUse).join(', ') || '—'}`
  dialog.appendChild(info)

  const suggested = defaultBase(options.intervalsInUse, options.stored)
  const initialBase = suggested ?? options.stored[0] ?? '1m'

  const defaultStart = defaultStartAt(initialBase, options.latest)
  const startField = field('Start (New York time)')
  const startRow = el('div', 'wd-replay-dialog-row')
  const startInput = dateInput(toLocalInputValue(defaultStart))
  startInput.max = toLocalInputValue(options.latest)
  startRow.appendChild(startInput)
  // The two ways to set the start without typing a date sit next to the field they write.
  // "On chart" first: pointing at the bar you want is how a start is usually found.
  if (options.pickOnChart) {
    const pickOnChart = options.pickOnChart
    const pick = button('kc-button kc-button-outline wd-replay-pick-button', 'On chart', () => {
      overlay.hidden = true
      pickOnChart((startAt) => {
        overlay.hidden = false
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
  dialog.appendChild(startField)

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
  dialog.appendChild(rangeField)

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
    startInput.value = toLocalInputValue(randomStart(range, basePicker.value))
    baseError.textContent = ''
  }

  const balanceField = field('Starting balance')
  const balanceInput = numberInput('10000', () => {})
  balanceField.appendChild(balanceInput)
  dialog.appendChild(balanceField)

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
    // Stepped aside for a pick on the chart: the keys are the pick's (Escape cancels IT).
    if (overlay.hidden) return
    if (e.key === 'Escape') close()
    // Enter starts, from any field -- but a focused button answers Enter itself, and a select
    // uses it to commit its list.
    else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLSelectElement) && !start.disabled) {
      e.preventDefault()
      start.click()
    }
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
  startInput.focus()

  function close(): void {
    document.removeEventListener('keydown', onKey)
    undrag()
    overlay.remove()
  }
  return { close }
}

/** The start the dialog offers: a week before the newest bar, on a base candle open -- the
 * instant Start will actually use, not whatever minute the dialog happened to open at -- and
 * inside the market week. A week before a weekend afternoon is a weekend afternoon, and a
 * replay opened there shows Friday's close and makes the first Step cross two days of nothing;
 * this backs off, an hour at a time, to the last candle that opened while the market traded.
 * (Random is deliberately NOT treated like this: see pick.ts.) */
export function defaultStartAt(base: string, latest: number): number {
  let at = intervalStart(base, latest - 7 * DAY_MS)
  for (let i = 0; i < 24 * 7 && !isMarketOpen(at); i++) at = intervalStart(base, at - HOUR_MS)
  return at
}

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

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

/** The New York calendar date of an instant, for a `type=date` input. */
function toDayInputValue(ms: number): string {
  return toLocalInputValue(ms).slice(0, 10)
}

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

/** A button whose face is an inline SVG (Play/Pause): text glyphs like ▶ render as emoji on
 * some platforms. Its name is the caller's `aria-label`. */
function iconButton(className: string, svg: string, onClick: () => void): HTMLButtonElement {
  const b = button(className, '', onClick)
  b.innerHTML = svg
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
    s.appendChild(opt)
  }
  // By value once every option exists, not `option.selected` per option as it is appended:
  // happy-dom (the controls' test DOM) loses track of which one was marked.
  if (options.some((o) => o.value === current)) s.value = current
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

function dateInput(value: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'datetime-local'
  input.className = 'kc-input wd-replay-input'
  input.step = '60'
  input.value = value
  return input
}

function dayInput(value: string): HTMLInputElement {
  const input = document.createElement('input')
  input.type = 'date'
  input.className = 'kc-input wd-replay-input'
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

function flash(root: HTMLElement, message: string): void {
  const note = el('div', 'wd-replay-flash')
  note.textContent = message
  root.appendChild(note)
  setTimeout(() => note.remove(), 3000)
}
