import { Arming, FigureList } from '../trading/kit'
import { type GoToMode, type GoToSpec, goToInstant } from './clock'
import { blocked, describeBlockers, type FollowNotice, undoBlockers } from './follow'
import { formatClock, formatSpan, zoneName } from './format'
import { defaultRange, randomStart, type StartRange } from './pick'
import { DEFAULT_PLAY_DELAY_MS, PLAY_DELAYS_MS, ReplayPlayer } from './player'
import { replayResults, resultHeadline, resultRows } from './results'
import { describeQuiet, localZone, type QuietSetting } from './quiet'
import { lastPlayed, type ReplaySessionSummary, resumable, sessionFacts } from './sessions'
import type { AdvanceResult, ReplayController } from './session'
import { describeStep, forgetStep, parseStep, readSavedSteps, rememberStep, sameStep, type StepSetting, stepKey } from './steps'
import type { SimTrade } from '../trading/api'
import { type BaseCheck, type CandleGrid, defaultBase, fromWall, sortByLength, toWall, validateBase } from './timeframes'
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
//   next        Next alert, and how far a running search or walk has got or why the last
//               advance stopped
//   notice      only when the chart's active pane moved to an instrument the replay has not
//               followed: which one it walks, why it stayed, what to do, and Follow (follow.ts)
//   footer      Alerts (the alert manager), and Go to / Base / Results / Sessions, one panel open
//               at a time; Account and Trade, the two windows; Exit replay, set apart at the far end
//
// SESSIONS (the panel): your other replays, as the start dialog's Sessions tab lists them, so one
// replay can be swapped for another without going back to the live wall. Resume leaves this one
// (it is saved, as Exit leaves it) and opens that one where it was left; the replay you are in is
// not on the list, so it cannot be deleted from under itself.
//
// GO TO (the panel): a time of day on the instrument's clock -- on its next trading day, at its
// next occurrence, or on a date -- and a stop price, which is a price watch like any other (the
// line on the chart, the Notification Center) so every advance stops at it, with Run to run on
// until it fires.
//
// The base timeframe and pause-on-fill are one click away instead of permanently on screen;
// the alerts Next alert runs to are the alert manager's (client/alerts), opened from here; and
// the account window and the trade box are opened from here rather than taking half the wall
// from the moment replay starts.
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

/** The Go to panel's time and day, per browser: "06:00 on the next trading day" is a habit. */
const GO_TO_KEY = 'wd.replay.goTo'


/** How long an advance runs before the controls show that it is running. A one-candle step
 * lands well inside this, and the controls flipping to a red Stop and greying out on every Step
 * -- twice a second while playing -- was noise, not information. A walk long enough to report
 * its progress, or a Stop already pressed, shows at once. */
const BUSY_REVEAL_MS = 300

type PanelId = 'goto' | 'settings' | 'results' | 'sessions' | 'quiet' | null

/** The step picker's last option: type a step of your own. */
const CUSTOM_STEP = 'custom'

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
  /** The alert manager the Alerts toggle opens -- where the alerts Next alert stops at are
   * written. Absent, there is no toggle. */
  alerts?: { isOpen: () => boolean; toggle: () => void }
  /** The stop price the Go to panel sets: a price watch on the replay's instrument (watches.ts).
   * Absent, the panel has no price row. */
  priceStop?: PriceStop
  /** The owner's OTHER replays, for the Sessions panel: `resume` leaves this one for it. Absent,
   * there is no Sessions toggle. */
  sessions?: SessionsSource
  /** The viewer's quiet hours (quiet.ts), set from the moon beside Next alert. Absent, there is
   * no moon. */
  quiet?: QuietHoursControl
  /** Injected by the tests: the wait between two played steps. */
  sleep?: (ms: number) => Promise<void>
  /** How long an advance runs before the controls show it (BUSY_REVEAL_MS). The tests pass 0. */
  busyRevealMs?: number
}

/** The one price watch the controls own. */
export interface PriceStop {
  /** The price it stops at while armed, or null when there is none (or it has fired). */
  get(): number | null
  set(price: number): Promise<void>
  clear(): Promise<void>
}

/** The quiet hours as the controls see them: `ReplayQuiet`, or a stub. */
export interface QuietHoursControl {
  readonly value: QuietSetting
  set(next: QuietSetting): void
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
  // What the Go to panel holds between renders: every control change rebuilds the body, and a
  // half-typed price must survive it.
  let goTo: GoToSpec = readGoTo()
  let priceDraft = ''
  // A step being typed into the step field ("15h"), or null while the field is the picker. Kept
  // across renders like the price, and focused again after each: Play re-renders twice a second.
  let stepDraft: string | null = null
  let savedSteps = readSavedSteps()
  // Whether the running advance is Next alert's, so its own button is the one that stops it.
  let nextRunning = false
  // The status row's walk line while a walk or a search is in progress, so a progress report
  // can patch it.
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
    return controller.busy && (revealed || controller.cancelling || controller.walkedTo !== null || controller.searchedTo !== null)
  }
  // Exit took two presses while it threw the replay away. It no longer does -- the replay is kept,
  // and the start dialog's Sessions tab reopens it where it was left -- so it is one press, like
  // every other button that can be taken back.
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
  // The Results panel's figures: one list for the controls' life, so a re-render updates its
  // values in place rather than rebuilding what is being read.
  const figures = new FigureList('wd-replay-results-figures')
  // The Sessions panel's list while it is open: loaded when the panel opens (another tab may have
  // added or deleted one since), kept across re-renders -- Play re-renders twice a second -- and
  // dropped when the panel closes.
  let sessionList: SessionList | null = null
  // A trade placed or closed between advances changes the score with no control change.
  const unsubscribeSnapshot = controller.subscribe(() => {
    if (panel === 'results') renderBody()
  })
  const unsubscribe = controller.onControlChange((change) => {
    // A progress report moves one date, several times a second: patch that line. Rebuilding
    // the window instead would replace the Stop button under a pointer pressing it, and a
    // press released on the new button is no click at all.
    if (change === 'walk' && walkLine && showProgress(walkLine)) return
    render()
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

  /** Next alert, or Stop while its own run is showing: the button pressed most stops what it
   * started, rather than sending the hand to Step. */
  function pressNext(): void {
    if (controller.busy) {
      if (!nextRunning || !busyShown()) return
      player.pause()
      controller.cancel()
      return
    }
    if (!nextEnabled()) return
    player.pause()
    nextRunning = true
    void controller
      .nextAlert()
      .then((r) => r && options.onStop?.(r))
      .finally(() => {
        nextRunning = false
        render()
      })
  }

  /** What Next alert can stop at: every enabled alert, price watch, working order or stop and
   * pending milestone. */
  function nextStops(): number {
    return controller.alertCount + controller.armedStops + controller.workingStops + (controller.pendingMilestones ?? 0)
  }

  function nextEnabled(): boolean {
    return nextStops() > 0
  }

  function pressPlay(): void {
    // Busy with an advance the player did not start (a Next alert run): Play waits for it.
    if (!player.playing && controller.busy) return
    player.toggle()
  }

  const onKey = (event: KeyboardEvent): void => {
    if (!event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    if (isEditable(event.target)) return
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'ArrowRight') {
      // Held down, the key repeats: each repeat is another step, but never a Stop -- a step
      // still landing must not be cancelled by the same finger that asked for the next one.
      if (event.repeat && controller.busy) return
      pressStep()
    } else if (event.key === 'ArrowUp') {
      // Next alert (Stop while its run shows). A repeat never stops the run it asked for.
      if (event.repeat && controller.busy) return
      pressNext()
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
    // On the instrument's own clock, the zone its chart is drawn in: New York for the FX week,
    // UTC for a coinbase pair.
    const zone = controller.grid.schedule.timezone
    clock.textContent = formatClock(at, zone)
    clock.title = `${new Date(at).toISOString()} — the replay's clock, ${zoneName(zone)}. Every pane shows the bars that had closed by then.`
    win.titleSlot.append(symbol, clock)
  }

  // -- the body ----------------------------------------------------------------------------
  //
  //   [  Next alert  ⇧↑ ] [☾ 22:00–06:00]  Alert: …   the way the replay is mostly moved, first and
  //                                                    largest, and why the last advance stopped
  //   [▶] [Step]  [15h v]  every [1 s v]               transport: each button beside what it uses
  //   Alerts 2  Go to  Base 1h  Results  Sessions  Account  Trade   Exit replay
  //
  // Next alert leads (user, 2026-11-24: "the Next alert button should be more prominent. i use
  // it the most"): the primary button, the size of a row, with Step and Play below it.

  function renderBody(): void {
    const body = win.body
    // Taking the list out of the page loses where it was scrolled to: put back below.
    const scrolled = sessionList?.scroller.scrollTop ?? 0
    const typing = stepDraft !== null && win.body.querySelector('.wd-replay-step-custom') === document.activeElement
    body.innerHTML = ''
    walkLine = null
    body.append(renderNext(), renderTransport())
    const notice = controller.followNotice
    if (notice) body.appendChild(renderFollowNotice(notice))
    body.appendChild(renderToggles())
    if (panel === 'goto') body.appendChild(renderGoTo())
    if (panel === 'settings') body.appendChild(renderSettings())
    if (panel === 'results') body.appendChild(renderResults())
    if (panel === 'quiet' && options.quiet) body.appendChild(renderQuiet(options.quiet))
    if (panel === 'sessions' && sessionList) {
      body.appendChild(renderSessions(sessionList))
      sessionList.scroller.scrollTop = scrolled
    }
    win.reflow()
    // A step being typed keeps its caret through the rebuild.
    if (typing) {
      const field = body.querySelector<HTMLInputElement>('.wd-replay-step-custom')
      field?.focus()
      field?.setSelectionRange(field.value.length, field.value.length)
    }
  }

  /** Write how far a running search or walk has got into `line`; false when neither runs. A
   * search comes first (it decides where the walk goes), then the walk to what it found. */
  function showProgress(line: HTMLElement): boolean {
    const searched = controller.searchedTo
    const walked = controller.walkedTo
    const zone = controller.grid.schedule.timezone
    if (searched !== null) {
      line.textContent = `Looking for the next alert… reached ${formatClock(searched, zone)}`
      line.title = `How far ahead the alerts have been checked (${new Date(searched).toISOString()}). Nothing moves until one triggers.`
      return true
    }
    if (walked !== null) {
      line.textContent = `Walking… reached ${formatClock(walked, zone)}`
      line.title = `How far the walk has checked the bars (${new Date(walked).toISOString()}). The chart and the clock move when it stops.`
      return true
    }
    return false
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
      : `Play: step ${describeStep(controller.advance, timeframes())} every ${delayLabel(player.delayMs)} until a fill or a price watch stops it (Shift+↓)`

    // While an advance runs -- a Step or Next alert -- the same button stops it, at the next
    // base bar (or, while Next alert is still searching, before anything moves).
    const cancelling = controller.busy && controller.cancelling
    const label = !busy ? 'Step' : cancelling ? 'Stopping…' : 'Stop'
    const step = button('kc-button kc-button-outline wd-replay-step', label, pressStep)
    step.classList.toggle('is-stop', busy)
    step.disabled = cancelling
    step.title = busy ? 'Stop at the next bar (Shift+→)' : `Advance ${describeStep(controller.advance, timeframes())} (Shift+→)`

    // How far one Step goes. The Step button is this group's label: it reads "Step 15h". Any
    // amount can be typed ("Custom step…": 15h, 30h, 90m, 2D, 3 × 4h), and what is typed is
    // offered again (steps.ts).
    const size = el('span', 'wd-replay-group')
    size.appendChild(stepDraft === null ? stepPicker(busy) : stepField())
    if (stepDraft === null && savedSteps.includes(describeStep(controller.advance, timeframes()))) {
      const label = describeStep(controller.advance, timeframes())
      const forget = button('kc-button kc-icon-button wd-replay-step-forget', '×', () => {
        savedSteps = forgetStep(label)
        renderBody()
      })
      forget.title = `Take ${label} off the list (the step stays as it is)`
      forget.setAttribute('aria-label', `Forget the step ${label}`)
      forget.disabled = busy
      size.appendChild(forget)
    }

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

  /** The picker's own intervals: the base, what is stored, what the panes show. */
  function timeframes(): string[] {
    return advanceChoices(controller, options.intervalsInUse())
  }

  /** The step picker: the timeframes, the steps typed before, the current one, and "Custom step…". */
  function stepPicker(busy: boolean): HTMLSelectElement {
    const frames = timeframes()
    const choices: Array<{ value: string; label: string; step: StepSetting }> = frames.map((code) => ({
      value: stepKey({ interval: code, multiple: 1 }),
      label: code,
      step: { interval: code, multiple: 1 }
    }))
    const add = (step: StepSetting): void => {
      if (choices.some((c) => sameStep(c.step, step))) return
      choices.push({ value: stepKey(step), label: describeStep(step, frames), step })
    }
    // A typed step that no longer fits the base (one typed on a finer wall) is left off, not lost.
    for (const typed of savedSteps) {
      const parsed = parseStep(typed, controller.base, frames)
      if (parsed.ok) add(parsed.step)
    }
    add(controller.advance)
    const picker = select(
      [...choices.map(({ value, label }) => ({ value, label })), { value: CUSTOM_STEP, label: 'Custom step…' }],
      stepKey(controller.advance),
      (value) => {
        if (value === CUSTOM_STEP) {
          stepDraft = ''
          renderBody()
          const field = win.body.querySelector<HTMLInputElement>('.wd-replay-step-custom')
          field?.focus()
          return
        }
        const chosen = choices.find((c) => c.value === value)
        if (chosen) controller.setAdvance(chosen.step)
      }
    )
    picker.classList.add('wd-replay-step-size')
    picker.title = 'How far one Step goes. Custom step… takes any amount: 15h, 30h, 90m, 2D, 3 × 4h'
    picker.setAttribute('aria-label', 'Step size')
    picker.disabled = busy
    return picker
  }

  /** The step typed in words; Enter applies it (and remembers it), Escape gives the picker back. */
  function stepField(): HTMLInputElement {
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'kc-input wd-replay-input wd-replay-step-custom'
    input.value = stepDraft ?? ''
    input.placeholder = '15h, 30h, 90m…'
    input.setAttribute('aria-label', 'Step size, typed')
    input.title = 'Any amount: 15h is fifteen hourly candles (the weekend skipped), 90m, 2D, 3 × 4h. Enter to use it, Esc to cancel.'
    input.addEventListener('input', () => {
      stepDraft = input.value
    })
    const done = (): void => {
      stepDraft = null
      renderBody()
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        done()
        return
      }
      if (event.key !== 'Enter') return
      event.preventDefault()
      const frames = timeframes()
      const parsed = parseStep(input.value, controller.base, frames)
      if (!parsed.ok) {
        flash(win.element, parsed.reason)
        return
      }
      stepDraft = null
      // A listed timeframe is on the list already; anything else is kept to pick again.
      if (!(parsed.step.multiple === 1 && frames.includes(parsed.step.interval))) {
        savedSteps = rememberStep(describeStep(parsed.step, frames))
      }
      controller.setAdvance(parsed.step)
      renderBody()
    })
    // Clicking away gives the picker back -- but not the rebuild of the body, which takes the
    // field out of the page (and puts it back focused) while it is still being typed in.
    input.addEventListener('blur', () => {
      setTimeout(() => {
        if (stepDraft !== null && !input.isConnected) return
        if (stepDraft !== null && document.activeElement !== input) done()
      }, 0)
    })
    return input
  }

  /** Next alert, and beside it what the replay is doing or why it last stopped. */
  function renderNext(): HTMLElement {
    const row = el('div', 'wd-replay-row wd-replay-next-row')
    const busy = busyShown()
    // While its own run shows, the same button stops it -- as Step does for a step -- so the
    // hand that pressed it need not travel to Step.
    const stopping = nextRunning && busy
    const cancelling = stopping && controller.cancelling
    const next = el('button', `kc-button kc-button-primary wd-replay-next${stopping ? ' is-stop' : ''}`) as HTMLButtonElement
    next.type = 'button'
    next.addEventListener('click', pressNext)
    const nextLabel = el('span', 'wd-replay-next-label')
    nextLabel.textContent = !stopping ? 'Next alert' : cancelling ? 'Stopping…' : 'Stop'
    next.innerHTML = stopping ? '' : NEXT_ICON
    next.appendChild(nextLabel)
    if (!stopping) {
      const key = el('kbd', 'wd-replay-key')
      key.textContent = '⇧↑'
      key.setAttribute('aria-hidden', 'true')
      next.appendChild(key)
    }
    // A price watch is a stop too, so a wall with watches and no alert can still run to the
    // next one.
    // Every enabled alert on the Alerts list, whatever instrument it watches -- and every price
    // watch, resting order, stop loss (trailing and breakeven too), take profit and milestone,
    // since each ends the run where it happens.
    const alerts = controller.alertCount
    const working = controller.workingStops
    const milestones = controller.pendingMilestones ?? 0
    const stops = nextStops()
    next.disabled = stopping ? cancelling : busy || stops === 0
    const also = [
      controller.armedStops > 0 ? 'a price watch fires' : null,
      working > 0 ? 'an order, stop loss or take profit fills' : null,
      milestones > 0 ? 'a trade reaches a "Notify at"' : null
    ].filter((part) => part !== null)
    const quiet = options.quiet?.value
    const quietNote = quiet?.on ? `, outside quiet hours (${describeQuiet(quiet)})` : ''
    next.title = stopping
      ? 'Stop the run where it has got to (Shift+↑)'
      : stops === 0
        ? 'Enable an alert (Alerts), place a price watch, or rest an order or a stop first'
        : `Advance to where the next of ${alerts} alert${alerts === 1 ? '' : 's'} triggers${quietNote}${also.map((part) => `, or ${part}`).join('')} (Shift+↑)`
    row.appendChild(next)
    if (options.quiet) row.appendChild(quietToggle(options.quiet.value))

    const last = controller.lastStop
    const progress = el('span', 'wd-replay-walk')
    if (showProgress(progress)) {
      // A search or walk in progress replaces the last stop's reason, which is stale by now
      // anyway. In the body and not the title bar: the date is how far it has looked, ahead of
      // everything drawn, and must not read as the replay's clock.
      walkLine = progress
      row.appendChild(progress)
    } else if (player.playing) {
      // Playing: every step's "Stepped 1h" would say the same thing twice a second. When the play
      // stops by itself this gives way to why it stopped, which is the line worth reading.
      const playingLine = el('span', 'wd-replay-stop-reason is-playing')
      playingLine.textContent = `Playing every ${delayLabel(player.delayMs)}`
      playingLine.title = 'Stops by itself at a fill pause, a price watch or the end of the data (Shift+↓ pauses)'
      row.appendChild(playingLine)
    } else if (last) {
      // Absent until an advance has stopped.
      const reason = el('span', `wd-replay-stop-reason is-${last.reason}`)
      reason.textContent = describeStop(last, controller.grid.schedule.timezone, controller.snapshot.trades)
      reason.title = last.alert?.readings ? `${reason.textContent} — ${last.alert.readings}` : reason.textContent
      row.appendChild(reason)
    }
    return row
  }

  /** The moon beside Next alert: lit, and reading the hours, while they silence anything. */
  function quietToggle(setting: QuietSetting): HTMLButtonElement {
    const on = setting.on
    const toggle = iconButton(`kc-button wd-replay-toggle wd-replay-quiet-toggle${on ? ' is-on' : ''}${panel === 'quiet' ? ' is-open' : ''}`, MOON_ICON, () => showPanel('quiet'))
    if (on) {
      const hours = el('span', 'wd-replay-quiet-hours')
      hours.textContent = describeQuiet(setting)
      toggle.appendChild(hours)
    }
    toggle.setAttribute('aria-pressed', String(panel === 'quiet'))
    toggle.setAttribute('aria-label', on ? `Quiet hours ${describeQuiet(setting)}` : 'Quiet hours')
    toggle.title = on
      ? `Quiet hours ${describeQuiet(setting)} ${zoneName(quietZone(setting))}: alerts then do not stop the replay or ring`
      : 'Quiet hours: silence alerts at night (off)'
    return toggle
  }

  function quietZone(setting: QuietSetting): string {
    return setting.zone === 'local' ? localZone() : controller.grid.schedule.timezone
  }

  //   QUIET HOURS  [x] Silence alerts  from [22:00] to [06:00]  [New York time (replay) v]
  //   what is silenced, and what is not

  function renderQuiet(quiet: QuietHoursControl): HTMLElement {
    const box = el('div', 'wd-replay-panel wd-replay-quiet')
    const setting = quiet.value
    const row = el('div', 'wd-replay-row')
    const label = el('span', 'wd-replay-label')
    label.textContent = 'Quiet hours'
    const on = checkbox('Silence alerts', setting.on, (checked) => quiet.set({ ...quiet.value, on: checked }))
    on.classList.add('wd-replay-quiet-on')
    const time = (value: number, aria: string, apply: (minute: number) => QuietSetting): HTMLInputElement => {
      const input = document.createElement('input')
      input.type = 'time'
      input.className = 'kc-input wd-replay-input wd-replay-quiet-time'
      input.value = minuteValue(value)
      input.setAttribute('aria-label', aria)
      input.addEventListener('change', () => {
        const minute = minuteOf(input.value)
        if (minute !== null) quiet.set(apply(minute))
      })
      return input
    }
    const fromLabel = el('span', 'wd-replay-every')
    fromLabel.textContent = 'from'
    const from = time(setting.from, 'Quiet from', (minute) => ({ ...quiet.value, from: minute }))
    const toLabel = el('span', 'wd-replay-every')
    toLabel.textContent = 'to'
    const to = time(setting.to, 'Quiet until', (minute) => ({ ...quiet.value, to: minute }))
    row.append(label, on, fromLabel, from, toLabel, to)
    // The clock they are read on: the replay's (the title bar's), or this browser's when it differs.
    const replayZone = controller.grid.schedule.timezone
    const mine = localZone()
    if (mine !== replayZone) {
      const zone = select(
        [
          { value: 'replay', label: `${zoneName(replayZone)} (replay)` },
          { value: 'local', label: `${zoneName(mine)} (yours)` }
        ],
        setting.zone,
        (value) => quiet.set({ ...quiet.value, zone: value === 'local' ? 'local' : 'replay' })
      )
      zone.setAttribute('aria-label', 'Quiet hours clock')
      zone.title = 'The clock the hours are read on: the replay’s, as the title bar shows it, or your own'
      row.appendChild(zone)
    } else {
      const zone = el('span', 'wd-replay-muted')
      zone.textContent = zoneName(replayZone)
      row.appendChild(zone)
    }
    box.appendChild(row)
    const note = el('div', 'wd-replay-muted wd-replay-quiet-note')
    note.textContent = setting.from === setting.to
      ? 'From and to are the same time, so nothing is silenced.'
      : 'Alerts and price watches that trigger in these hours do not stop the replay or ring: Next alert runs on to the first one outside them, and an alert set to fire once is still armed when they end. Orders, stops, take profits, "Notify at" and the Go to stop price still stop it.'
    box.appendChild(note)
    return box
  }

  /** The chart moved to an instrument the replay has not followed. It says which instrument the
   * replay walks -- the title bar names it too, but this is where the eye goes after a symbol
   * pick that seemed to do nothing -- why it stayed, and what to do. What keeps it is read live
   * (`followBlockers`): close the last trade and the same notice offers the follow. */
  function renderFollowNotice(notice: FollowNotice): HTMLElement {
    const box = el('div', 'wd-replay-notice')
    box.setAttribute('role', 'status')
    const walked = tickerOf(controller.symbol)
    const to = notice.ticker
    const holding = controller.followBlockers
    const stuck = notice.problem === null && blocked(holding)
    const text = el('div', 'wd-replay-notice-text')
    if (notice.moving) text.textContent = `Following ${to}…`
    else if (notice.problem !== null) {
      text.textContent = `The replay walks ${walked}, not ${to}: ${lowerFirst(notice.problem)}. Keep walking ${walked}, or exit and start a replay of ${to}.`
    } else if (stuck) {
      text.textContent = `The replay walks ${walked}, not ${to}: ${walked} has ${describeBlockers(holding)}. ${undoBlockers(holding)} to follow ${to}, or exit the replay.`
    } else text.textContent = `The replay walks ${walked}. Nothing is open on it any more, so it can follow the chart to ${to} from here.`
    box.appendChild(text)
    if (notice.moving) return box

    const actions = el('div', 'wd-replay-notice-actions')
    const follow = button('kc-button kc-button-outline wd-replay-follow', `Follow ${to}`, () => {
      if (controller.busy) return
      player.pause()
      void controller.follow()
    })
    follow.disabled = stuck || busyShown()
    follow.title = stuck
      ? `${undoBlockers(holding)} first: the replay walks one instrument, and only its walk can fill, close or fire what is open on ${walked}`
      : `Walk ${to} from ${formatClock(controller.cursor, controller.grid.schedule.timezone)}: the same account, its history kept`
    const keep = button('kc-button kc-icon-button wd-replay-notice-close', '×', () => controller.dismissFollow())
    keep.setAttribute('aria-label', `Keep walking ${walked}`)
    keep.title = `Keep walking ${walked}`
    actions.append(follow, keep)
    box.appendChild(actions)
    return box
  }

  function renderToggles(): HTMLElement {
    const row = el('div', 'wd-replay-toggles')
    if (options.alerts) {
      const manager = options.alerts
      const count = controller.alertCount
      const toggle = toggleButton('Alerts', count > 0 ? String(count) : '', manager.isOpen(), () => {
        manager.toggle()
        renderBody()
      })
      toggle.title = `The alert manager: ${count} enabled, which is where Next alert stops`
      row.appendChild(toggle)
    }

    const goToggle = toggleButton('Go to', '', panel === 'goto', () => showPanel('goto'))
    goToggle.title = 'Go to a time, or stop at a price'
    row.appendChild(goToggle)

    // The base is on the toggle itself: it decides how accurately every fill is priced, so
    // it should be legible without opening anything.
    const baseCheck = validateBase(controller.base, controller.intervalsInUse, controller.storedIntervals)
    const settings = toggleButton(`Base ${controller.base}`, '', panel === 'settings', () => showPanel('settings'))
    settings.classList.toggle('is-invalid', !baseCheck.ok)
    settings.title = baseCheck.ok ? 'Base timeframe and pause on fill' : (baseCheck.reason ?? '')
    const results = toggleButton('Results', '', panel === 'results', () => showPanel('results'))
    results.title = 'How the session is going: P&L, win rate, drawdown'
    row.append(settings, results)
    if (options.sessions) {
      const sessions = toggleButton('Sessions', '', panel === 'sessions', () => showPanel('sessions'))
      sessions.title = 'Your other replays: switch to one where you left it, see its score, or delete it'
      row.appendChild(sessions)
    }

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

    // Exit, at the far end of the footer: the one control here that leaves the session, as far
    // from Play and Step as the window allows.
    const exit = button('kc-button wd-replay-exit', 'Exit replay', () => {
      // Never mid-advance: leaving rebuilds the wall under a session still walking.
      if (controller.busy) return
      player.pause()
      options.onExit()
    })
    exit.disabled = busyShown()
    exit.title = 'Leave replay and return to the live wall. It is kept: Replay → Sessions resumes it.'
    row.appendChild(exit)
    return row
  }

  function showPanel(next: PanelId): void {
    panel = panel === next ? null : next
    if (panel !== 'sessions') {
      sessionList?.dispose()
      sessionList = null
    } else if (options.sessions) sessionList = openSessions(options.sessions)
    renderBody()
  }

  // -- Sessions ----------------------------------------------------------------------------

  function openSessions(source: SessionsSource): SessionList {
    return createSessionList({
      source,
      empty: 'No other replays. A replay you start from the live wall is kept here to switch to.',
      beforeResume: () => {
        // A run the user can see -- the red Stop -- is theirs to stop: leaving under it would drop
        // the walk where it had got to.
        if (busyShown()) {
          flash(win.element, 'Stop the advance first')
          return false
        }
        if (controller.followNotice?.moving) {
          flash(win.element, 'Wait for the replay to finish following the chart')
          return false
        }
        // Playing, the next step is cancelled here; one already landing is waited for, so the
        // replay is left where that step put it and saved there.
        player.pause()
        return controller.busy ? whenIdle().then(() => true) : true
      },
      onRender: () => win.reflow()
    })
  }

  /** Once no advance runs: a step already under way when Resume was pressed. */
  function whenIdle(): Promise<void> {
    return new Promise((resolve) => {
      if (!controller.busy) return resolve()
      const off = controller.onControlChange(() => {
        if (controller.busy) return
        off()
        resolve()
      })
    })
  }

  function renderSessions(list: SessionList): HTMLElement {
    const box = el('div', 'wd-replay-panel wd-replay-sessions-panel')
    box.appendChild(list.element)
    return box
  }

  // -- Go to -------------------------------------------------------------------------------
  //
  //   Time   [06:00] [next trading day v]  [Go]  Thu, Oct 22, 06:00
  //   Price  [1.16250      ] [Stop here] [Run]   stops at 1.16250 ×

  function pressGoTo(): void {
    if (controller.busy) return
    const at = goToInstant(controller.cursor, goTo, controller.grid)
    if (at === null) {
      flash(win.element, 'Choose a time after the replay’s clock')
      return
    }
    player.pause()
    void controller.goTo(at).then((r) => r && options.onStop?.(r))
  }

  function renderGoTo(): HTMLElement {
    const box = el('div', 'wd-replay-panel wd-replay-goto')
    const busy = busyShown()
    const zone = controller.grid.schedule.timezone

    const timeRow = el('div', 'wd-replay-row')
    const timeLabel = el('span', 'wd-replay-label')
    timeLabel.textContent = 'Time'
    const time = document.createElement('input')
    time.type = 'time'
    time.className = 'kc-input wd-replay-input wd-replay-goto-time'
    time.value = minuteValue(goTo.minute)
    time.title = `A time of day on ${controller.symbol.split(':')[1] ?? controller.symbol}'s clock (${zoneName(zone)})`
    time.setAttribute('aria-label', 'Go to time')
    time.addEventListener('change', () => {
      const minute = minuteOf(time.value)
      if (minute === null) return
      goTo = { ...goTo, minute }
      writeGoTo(goTo)
      renderBody()
    })
    time.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return
      const minute = minuteOf(time.value)
      if (minute !== null) goTo = { ...goTo, minute }
      pressGoTo()
    })
    const mode = select(
      [
        { value: 'day', label: 'next trading day' },
        { value: 'next', label: 'next time' },
        { value: 'date', label: 'on date' }
      ],
      goTo.mode,
      (value) => {
        goTo = { ...goTo, mode: value as GoToMode, day: goTo.day ?? nextDayOf(controller.cursor, zone) }
        writeGoTo(goTo)
        renderBody()
      }
    )
    mode.title = 'Next trading day: that time on the first day after the replay’s own that the market trades. Next time: the next time the clock reads it.'
    mode.setAttribute('aria-label', 'Go to which day')
    timeRow.append(timeLabel, time, mode)
    if (goTo.mode === 'date') {
      const day = dayInput(new Date(goTo.day ?? nextDayOf(controller.cursor, zone)).toISOString().slice(0, 10))
      day.classList.add('wd-replay-goto-day')
      day.setAttribute('aria-label', 'Go to date')
      day.addEventListener('change', () => {
        const parsed = Date.parse(`${day.value}T00:00Z`)
        if (!Number.isFinite(parsed)) return
        goTo = { ...goTo, day: parsed }
        renderBody()
      })
      timeRow.appendChild(day)
    }
    const target = goToInstant(controller.cursor, goTo, controller.grid)
    const go = button('kc-button kc-button-outline wd-replay-goto-go', 'Go', pressGoTo)
    go.disabled = busy || target === null
    go.title = target === null ? 'Choose a time after the replay’s clock' : `Advance to ${formatClock(target, zone)}, stopping sooner for a fill pause or a price watch`
    const preview = el('span', 'wd-replay-muted wd-replay-goto-target')
    preview.textContent = target === null ? 'before the clock' : formatClock(target, zone)
    timeRow.append(go, preview)
    box.appendChild(timeRow)

    if (options.priceStop) box.appendChild(renderPriceStop(options.priceStop, busy))
    return box
  }

  function renderPriceStop(stop: PriceStop, busy: boolean): HTMLElement {
    const row = el('div', 'wd-replay-row')
    const label = el('span', 'wd-replay-label')
    label.textContent = 'Price'
    const quote = controller.snapshot.quotes[controller.symbol]
    const mid = quote ? (quote.bid + quote.ask) / 2 : null
    const input = document.createElement('input')
    input.type = 'text'
    input.inputMode = 'decimal'
    input.className = 'kc-input wd-replay-input wd-replay-price'
    input.value = priceDraft
    input.placeholder = mid === null ? 'price' : formatPrice(mid, quote?.bid)
    input.setAttribute('aria-label', 'Stop at price')
    input.title = 'The price to stop at: the first bar whose mid of bid and ask reaches it'
    input.addEventListener('input', () => {
      priceDraft = input.value
    })
    const set = (): void => {
      const price = Number(priceDraft.trim())
      if (!priceDraft.trim() || !Number.isFinite(price) || price <= 0) {
        flash(win.element, 'Type the price to stop at')
        return
      }
      priceDraft = ''
      void stop.set(price).then(
        () => renderBody(),
        (err) => flash(win.element, err instanceof Error ? err.message : 'Could not set the stop')
      )
    }
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') set()
    })
    const place = button('kc-button kc-button-outline wd-replay-price-set', 'Stop here', set)
    place.title = 'Stop every advance -- Step, Play, Next alert, Go to -- where the price reaches it'
    const run = button('kc-button kc-button-outline wd-replay-run', 'Run', () => {
      if (controller.busy) return
      player.pause()
      void controller.runToWatch().then((r) => r && options.onStop?.(r))
    })
    run.disabled = busy || controller.armedStops === 0
    run.title =
      controller.armedStops === 0
        ? 'Set a stop price (or place a price watch) first'
        : 'Run on until the price reaches the stop (or another price watch fires) -- quickly, however far. Does not move if it never does.'
    row.append(label, input, place, run)
    const current = stop.get()
    if (current !== null) {
      const at = el('span', 'wd-replay-muted wd-replay-price-current')
      at.textContent = `stops at ${current}`
      const clear = button('kc-button wd-replay-price-clear', '×', () => {
        void stop.clear().then(() => renderBody())
      })
      clear.title = 'Remove the stop price'
      clear.setAttribute('aria-label', 'Remove the stop price')
      row.append(at, clear)
    }
    return row
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

  /** The session's score (results.ts), in the trading kit's figures. */
  function renderResults(): HTMLElement {
    // `wd-tk`: the kit's own scope, so the figures read exactly as they do in the trade box.
    const box = el('div', 'wd-replay-panel wd-tk wd-replay-results')
    const r = replayResults(controller.snapshot, controller.startedAt, controller.cursor)
    const headline = resultHeadline(r)
    const head = el('div', 'wd-replay-results-head')
    const label = el('span', 'wd-replay-label')
    label.textContent = 'Net P&L'
    const value = el('span', `wd-replay-results-net${headline.tone ? ` is-${headline.tone}` : ''}`)
    value.textContent = headline.text
    head.append(label, value)
    box.appendChild(head)
    if (r.closed === 0 && r.open === 0) {
      const none = el('div', 'wd-replay-muted')
      none.textContent = 'No trades yet. Trade from the Trade box or the chart, and the score builds here.'
      box.appendChild(none)
      return box
    }
    figures.update(resultRows(r))
    box.appendChild(figures.element)
    if (r.closed === 0) {
      const note = el('div', 'wd-replay-muted wd-replay-results-note')
      note.textContent = 'Win rate, profit factor and drawdown follow the first closed trade.'
      box.appendChild(note)
    }
    return box
  }

  render()
  return {
    element: win.element,
    refresh: render,
    dispose(): void {
      if (revealTimer) clearTimeout(revealTimer)
      sessionList?.dispose()
      window.removeEventListener('keydown', onKey, true)
      player.dispose()
      unsubscribe()
      unsubscribeSnapshot()
      win.dispose()
    }
  }
}

function advanceChoices(controller: ReplayController, inUse: string[]): string[] {
  return sortByLength([...new Set([controller.base, ...controller.storedIntervals, ...inUse, controller.advance.interval])])
}

/** "1h" for one candle, "15h" for fifteen hourly ones, "3 × 4h" for several longer ones. */
function describeAdvance(advance: { interval: string; multiple: number }): string {
  return describeStep(advance)
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

function readGoTo(): GoToSpec {
  const fallback: GoToSpec = { mode: 'day', minute: 6 * 60 }
  try {
    const stored = JSON.parse(window.localStorage.getItem(GO_TO_KEY) ?? 'null') as Partial<GoToSpec> | null
    if (!stored) return fallback
    const mode = stored.mode === 'next' || stored.mode === 'day' ? stored.mode : 'day'
    const minute = typeof stored.minute === 'number' && stored.minute >= 0 && stored.minute < 1440 ? stored.minute : fallback.minute
    return { mode, minute }
  } catch {
    return fallback
  }
}

/** The time and which day, not a date: a date chosen once is stale by the next replay. */
function writeGoTo(spec: GoToSpec): void {
  try {
    window.localStorage.setItem(GO_TO_KEY, JSON.stringify({ mode: spec.mode === 'date' ? 'day' : spec.mode, minute: spec.minute }))
  } catch {
    // Not remembered.
  }
}

/** `HH:MM` for a minute of the day. */
function minuteValue(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
}

/** The minute of the day a `HH:MM` reading names, or null. */
function minuteOf(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(value)
  if (!m) return null
  const minute = Number(m[1]) * 60 + Number(m[2])
  return minute >= 0 && minute < 1440 ? minute : null
}

/** The calendar day after `ms`'s on `zone`'s clock, as its wall-clock midnight. */
function nextDayOf(ms: number, zone: string): number {
  return Math.floor(toWall(ms, zone) / 86_400_000) * 86_400_000 + 86_400_000
}

/** A price with as many decimals as `like` (a quote's bid) carries, at most six. */
function formatPrice(price: number, like: number | undefined): string {
  const decimals = like === undefined ? 5 : Math.min(6, (String(like).split('.')[1] ?? '').length || 2)
  return price.toFixed(decimals)
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

function describeStop(result: AdvanceResult, zone: string, trades?: readonly SimTrade[]): string {
  switch (result.reason) {
    case 'alert':
      return `Alert: ${result.alert?.name ?? ''}`
    case 'none':
      // Either way the cursor did not move: a replay cannot step back, so a run that would only
      // have reached the end of the data is not made.
      return result.seeking === 'watches' ? 'The price is not reached before the end of the data' : 'No alert triggers before the end of the data'
    case 'fill': {
      // The event that ended it is the last the engine produced.
      const last = [...result.events].reverse().find((e) => e.kind === 'fill' || e.kind === 'close' || e.kind === 'milestone')
      if (last?.kind === 'fill') return 'Order filled'
      if (last?.kind === 'milestone') return `Reached ${last.reason ?? 'a milestone'}`
      if (last?.reason === 'stop_loss') {
        const trade = trades?.find((t) => t.id === last.tradeId)
        return trade?.stopMovedBy === 'trail' ? 'Trailing stop hit' : trade?.stopMovedBy === 'breakeven' ? 'Breakeven stop hit' : 'Stop loss hit'
      }
      return last?.reason === 'take_profit' ? 'Take profit hit' : 'Trade closed'
    }
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
      if ('interval' in result.request) return `Stepped ${describeAdvance(result.request)}`
      return 'to' in result.request ? `Went to ${formatClock(result.to, zone)}` : 'Advanced'
  }
}

/** Next alert's face: a skip-forward mark, so the button reads at a glance among the others. */
const NEXT_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M2.5 3v10l6-5zM8.5 3v10l6-5z" fill="currentColor"/></svg>'
const MOON_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M13.5 10.2A6 6 0 0 1 5.8 2.5a6 6 0 1 0 7.7 7.7z" fill="currentColor"/></svg>'
const PLAY_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 2.75v10.5L13 8z" fill="currentColor"/></svg>'
const PAUSE_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3.5" y="2.75" width="3" height="10.5" rx="0.75" fill="currentColor"/><rect x="9.5" y="2.75" width="3" height="10.5" rx="0.75" fill="currentColor"/></svg>'

// -- the start dialog ------------------------------------------------------------------------

/** What every start dialog opens with: the wall it was asked from. */
interface StartDialogBase {
  anchor: HTMLElement
  /** The active pane's instrument, `vendor:TICKER`. */
  symbol: string
  intervalsInUse: string[]
}

export interface StartDialogOptions extends StartDialogBase {
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
export interface RefusedDialogOptions extends StartDialogBase {
  /** Why, in a few words: "No market hours for GBPUSD". */
  refusal: string
  sessions: SessionsSource
}

/** A past replay as the Sessions tab lists it: its summary, and the zone its dates read in. */
export interface ListedSession {
  summary: ReplaySessionSummary
  /** The instrument's own clock, as its chart and the replay's clock read; UTC when its market
   * hours could not be resolved -- named so beside the dates. */
  zone: string
}

export interface SessionsSource {
  /** The list, most recently played first. */
  load(): Promise<ListedSession[]>
  /** Reopen it where it was left: the dialog has closed by then; the replay window's list says
   * "Opening…" until the wall rebuilds, and that a rejection could not open it. */
  resume(session: ReplaySessionSummary): void | Promise<void>
  /** Delete it on the server; resolves once that is done. */
  remove(id: string): Promise<void>
}

export interface StartDialog {
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

// -- past replays: the list the start dialog's Sessions tab and the replay window's Sessions
// panel both show --------------------------------------------------------------------------------

interface SessionListOptions {
  source: SessionsSource
  /** What it says when there is nothing to list. */
  empty: string
  /** Resume was pressed: true goes ahead at once, false refuses (the caller says why), and a
   * promise goes ahead when it resolves true -- the replay window waiting out a step in flight. */
  beforeResume?: () => boolean | Promise<boolean>
  /** After every render but the first (which is inside the call that builds it): it loaded, a
   * row went or opened its figures. */
  onRender?: () => void
}

interface SessionList {
  /** Mounted by the caller and kept for the list's life: it re-renders inside it. */
  readonly element: HTMLElement
  /** The rows listed; null while loading, or when the list would not load. */
  readonly count: number | null
  /** Where the rows scroll. Kept across the list's own renders, so a Stats or a Delete far down
   * thirty replays does not jump back to the top; a caller that detaches `element` to re-render
   * around it puts `scrollTop` back. */
  readonly scroller: HTMLElement
  dispose(): void
}

/** Past replays, loaded once, each with what it replayed, how far, its score, and Stats, Delete
 * (two presses) and Resume. */
function createSessionList(options: SessionListOptions): SessionList {
  const { source } = options
  const element = el('div', 'wd-tk wd-replay-sessions')
  const scroller = el('div', 'wd-replay-session-list')
  let listed: ListedSession[] | null = null
  let failed = false
  let disposed = false
  /** The row whose Resume is on its way: the rest wait for it. */
  let resuming: string | null = null
  /** The rows whose figures are showing. */
  const expanded = new Set<string>()
  /** The rows whose delete is on its way to the server. */
  const deleting = new Set<string>()
  const arming = new Arming(() => render())

  function render(notify = true): void {
    if (disposed) return
    if (failed) element.replaceChildren(muted('Could not load your replays.'))
    else if (listed === null) element.replaceChildren(muted('Loading your replays…'))
    else if (listed.length === 0) element.replaceChildren(muted(options.empty))
    else {
      // The rows change, never the box they scroll in.
      scroller.replaceChildren(...listed.map(row))
      if (scroller.parentElement !== element) element.replaceChildren(scroller)
    }
    if (notify) options.onRender?.()
  }

  function pressResume(s: ReplaySessionSummary): void {
    if (resuming !== null) return
    // Not refused once disposed: the dialog's own `beforeResume` is what closed it.
    const go = (): void => {
      if (resuming !== null) return
      resuming = s.id
      render()
      const fail = (err: unknown): void => {
        console.error('[replay] could not resume session', s.id, err)
        resuming = null
        render()
        if (!disposed) flash(element, 'Could not open that replay')
      }
      try {
        void Promise.resolve(source.resume(s)).catch(fail)
      } catch (err) {
        fail(err)
      }
    }
    const ready = options.beforeResume ? options.beforeResume() : true
    if (ready === true) go()
    // Waited for: the window may have gone in the meantime (the wall rebuilt by something else).
    else if (ready !== false) void ready.then((ok) => ok && !disposed && go())
  }

  function row({ summary: s, zone }: ListedSession): HTMLElement {
    const box = el('div', 'wd-replay-session')
    box.dataset.session = s.id

    const head = el('div', 'wd-replay-session-head')
    const name = el('span', 'wd-replay-session-ticker')
    name.textContent = s.ticker || 'Unknown instrument'
    head.appendChild(name)
    if (s.state) {
      const base = el('span', 'wd-replay-session-base')
      base.textContent = `${s.state.base} base`
      head.appendChild(base)
    }
    // Net P&L only once something was traded: "0.00 USD · 0.00%" on every idle replay is noise.
    if (s.results && s.results.closed + s.results.open > 0) {
      const headline = resultHeadline(s.results)
      const net = el('span', `wd-replay-session-net${headline.tone ? ` is-${headline.tone}` : ''}`)
      net.textContent = headline.text
      net.title = 'Net P&L: realised plus what is still open, against the starting balance'
      head.appendChild(net)
    }
    box.appendChild(head)

    if (s.state) {
      const span = el('div', 'wd-replay-session-span')
      span.textContent = formatSpan(s.state.startedAt, s.state.cursor, zone)
      span.title = `Where the replay started and how far it got (${zoneName(zone)})`
      box.appendChild(span)
    }
    const facts = el('div', 'wd-replay-session-facts')
    facts.textContent = `${sessionFacts(s)} · ${s.savedAt === null ? 'started' : 'played'} ${formatLocal(lastPlayed(s))}`
    box.appendChild(facts)

    const actions = el('div', 'wd-replay-session-actions')
    const open = expanded.has(s.id)
    if (s.results && s.results.closed + s.results.open > 0) {
      const stats = button(`kc-button kc-button-outline wd-replay-session-stats${open ? ' is-on' : ''}`, open ? 'Hide stats' : 'Stats', () => {
        if (expanded.has(s.id)) expanded.delete(s.id)
        else expanded.add(s.id)
        render()
      })
      stats.setAttribute('aria-expanded', String(open))
      actions.appendChild(stats)
    }
    const busy = deleting.has(s.id)
    const armed = arming.key === `delete:${s.id}`
    const remove = button(`kc-button kc-button-outline wd-replay-session-delete${armed ? ' is-armed' : ''}`, busy ? 'Deleting…' : armed ? 'Confirm delete' : 'Delete', () => {
      if (deleting.has(s.id) || !arming.press(`delete:${s.id}`, false)) return
      deleting.add(s.id)
      render()
      source
        .remove(s.id)
        .then(() => {
          deleting.delete(s.id)
          expanded.delete(s.id)
          listed = (listed ?? []).filter((l) => l.summary.id !== s.id)
          render()
        })
        .catch((err) => {
          console.error('[replay] could not delete session', s.id, err)
          deleting.delete(s.id)
          render()
          if (!disposed) flash(element, 'Could not delete that replay')
        })
    })
    remove.disabled = busy || resuming !== null
    remove.title = armed ? 'Press again to delete. This replay, its account and its trades are gone for good.' : 'Delete this replay'
    actions.appendChild(remove)
    const opening = resuming === s.id
    const resume = button('kc-button kc-button-primary wd-replay-session-resume', opening ? 'Opening…' : 'Resume', () => pressResume(s))
    resume.disabled = busy || resuming !== null || !resumable(s)
    resume.title = resumable(s) ? 'Reopen this replay where you left it: its clock, account, orders and watches' : 'This replay was saved by another version and cannot be reopened'
    actions.appendChild(resume)
    box.appendChild(actions)

    if (open && s.results) {
      const figures = new FigureList('wd-replay-results-figures')
      figures.update(resultRows(s.results))
      box.appendChild(figures.element)
    }
    return box
  }

  function muted(text: string): HTMLElement {
    const note = el('div', 'wd-replay-muted')
    note.textContent = text
    return note
  }

  source
    .load()
    .then((rows) => {
      listed = rows
      render()
    })
    .catch((err) => {
      console.error('[replay] could not list sessions', err)
      failed = true
      render()
    })
  render(false)
  return {
    element,
    scroller,
    get count() {
      return failed ? null : (listed?.length ?? null)
    },
    dispose(): void {
      disposed = true
      arming.disarm()
    }
  }
}

const localDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const localDateThisYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** When a session was last played, on the VIEWER's clock -- this is when you sat at it, not a
 * market instant: "Nov 14, 10:22", with the year once it is not this one. */
function formatLocal(ms: number, now = Date.now()): string {
  const year = (t: number): number => new Date(t).getFullYear()
  return (year(ms) === year(now) ? localDateThisYear : localDate).format(new Date(ms))
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

// -- small DOM helpers -------------------------------------------------------------------------

/** The mounted chart's theme class ('dark' or ''), for chrome mounted outside its root. */
export function chartTheme(): string {
  return document.querySelector('.klinecharts-pro.dark') ? 'dark' : ''
}

/** `EURUSD` of `oanda:EURUSD`. */
function tickerOf(symbol: string): string {
  return symbol.split(':').pop() ?? symbol
}

/** "No market hours for X" as it reads after a colon. */
function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
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
