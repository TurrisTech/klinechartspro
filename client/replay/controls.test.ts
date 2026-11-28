import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { SimSnapshot, SimTrade } from '../trading/api'
import type { SessionListener } from '../trading/session'
import type { AdvanceResult, ReplayController } from './session'

// THE REPLAY CONTROLS (the window), rendered into a real DOM (happy-dom) and driven the way a
// user drives them: clicks, selects, typed values. The controller is a fake that records what it
// was asked to do, so these pin the controls' half of the contract -- what each button shows and
// when it is usable, which controller call each gesture makes, and what the status line says --
// with no session, no chart and no network. The start dialog is startdialog.test.ts.
//
// The DOM is registered for this file only and removed after it, so every other suite keeps
// the bare environment it was written for.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { createReplayControls } = await import('./controls')
const { formatClock } = await import('../time/format')
const { FX_GRID, CONTINUOUS_DAY, gridOf } = await import('../time/timeframes')
const { validateBase } = await import('../time/intervals')
const { change, check, flush, listed, stored } = await import('./testing')

const SYM = 'oanda:EURUSD'
const NY_TZ = 'America/New_York'
const H = 3_600_000

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

interface Fake {
  controller: Mutable<ReplayController>
  calls: {
    step: number
    nextAlert: number
    goTo: number[]
    runToWatch: number
    cancel: number
    persist: number
    setAdvance: Array<{ interval: string; multiple: number }>
    setBase: string[]
    setPauseOnFill: boolean[]
    follow: number
    dismissFollow: number
  }
  /** What the controller's own change notification does: every listener re-renders. */
  emit(): void
  /** A walk's progress report: only `walkedTo` moved. */
  emitWalk(): void
  listeners: Set<(change?: 'walk') => void>
  /** The account changed (a trade placed or closed between advances). */
  emitSnapshot(): void
}

function snapshotOf(trades: SimTrade[] = [], account: Partial<SimSnapshot['account']> = {}): SimSnapshot {
  return {
    id: 's1',
    mode: 'replay',
    name: 'Replay',
    createdAt: 0,
    rev: 0,
    account: { currency: 'USD', initialBalance: 10_000, balance: 10_000, unrealizedPnl: 0, equity: 10_000, ...account },
    quotes: {},
    orders: [],
    trades,
    symbols: [SYM]
  }
}

function closedTrade(id: string, pnl: number, closedAt: number): SimTrade {
  return {
    id,
    symbol: SYM,
    side: 'buy',
    units: 10_000,
    entryPrice: 1.1,
    openedAt: closedAt - H,
    orderId: `o${id}`,
    stopLoss: null,
    takeProfit: null,
    closedAt,
    closePrice: 1.1,
    closeReason: 'manual',
    realizedPnl: pnl,
    label: null
  }
}

function result(over: Partial<AdvanceResult> = {}): AdvanceResult {
  return { from: 0, to: H, request: { interval: '5m', multiple: 1 }, reason: 'target', alert: null, events: [], bars: [], walked: false, observed: [], seeking: null, ...over }
}

function fake(): Fake {
  const listeners = new Set<(change?: 'walk') => void>()
  const snapshotListeners = new Set<SessionListener>()
  const calls: Fake['calls'] = { step: 0, nextAlert: 0, goTo: [], runToWatch: 0, cancel: 0, persist: 0, setAdvance: [], setBase: [], setPauseOnFill: [], follow: 0, dismissFollow: 0 }
  const emit = (): void => {
    for (const l of [...listeners]) l()
  }
  const emitWalk = (): void => {
    for (const l of [...listeners]) l('walk')
  }
  const controller: Mutable<ReplayController> = {
    cursor: Date.UTC(2024, 2, 4, 14, 0),
    base: '1m',
    advance: { interval: '5m', multiple: 1 },
    pauseOnFill: false,
    busy: false,
    cancelling: false,
    advanceFrom: null,
    walkedTo: null,
    searchedTo: null,
    lastStop: null,
    alertCount: 0,
    armedStops: 0,
    workingStops: 0,
    storedIntervals: ['1m', '1h', '1D'],
    intervalsInUse: ['5m', '1h'],
    symbol: SYM,
    grid: FX_GRID,
    startedAt: Date.UTC(2024, 2, 4, 14, 0),
    snapshot: snapshotOf(),
    subscribe(listener) {
      snapshotListeners.add(listener)
      return () => {
        snapshotListeners.delete(listener)
      }
    },
    setBase(base) {
      calls.setBase.push(base)
      const check = validateBase(base, controller.intervalsInUse, controller.storedIntervals)
      if (check.ok) controller.base = base
      return check
    },
    setAdvance(setting) {
      calls.setAdvance.push(setting)
      controller.advance = setting
    },
    setPauseOnFill(on) {
      calls.setPauseOnFill.push(on)
      controller.pauseOnFill = on
    },
    async step() {
      calls.step++
      return result({ reason: 'target' })
    },
    async advanceBy() {
      return null
    },
    async nextAlert() {
      calls.nextAlert++
      return result({ reason: 'none' })
    },
    async goTo(at) {
      calls.goTo.push(at)
      return result({ reason: 'target', request: { to: at }, to: at })
    },
    async runToWatch() {
      calls.runToWatch++
      return result({ reason: 'none', seeking: 'watches', request: { toEnd: true, end: 0 } })
    },
    cancel() {
      calls.cancel++
      controller.cancelling = true
      emit()
    },
    onControlChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    persist() {
      calls.persist++
    },
    followNotice: null,
    followBlockers: { trades: 0, orders: 0, watches: 0 },
    async follow() {
      calls.follow++
      return 'followed'
    },
    dismissFollow() {
      calls.dismissFollow++
      controller.followNotice = null
      emit()
    }
  }
  const emitSnapshot = (): void => {
    for (const l of [...snapshotListeners]) l(controller.snapshot, [])
  }
  return { controller, calls, emit, emitWalk, listeners, emitSnapshot }
}

interface Mounted extends Fake {
  root: HTMLElement
  stops: AdvanceResult[]
  exits: number
  account: { open: boolean; toggles: number }
  trade: { open: boolean; toggles: number }
  alerts: { open: boolean; toggles: number }
  /** The stop price the Go to panel sets, as a stub of the watch it is. */
  priceStop: { price: number | null; sets: number[]; clears: number }
  dispose(): void
  /** A button in the window by its visible label (badge excluded). */
  button(label: string): HTMLButtonElement
  maybeButton(label: string): HTMLButtonElement | null
  q<T extends Element = HTMLElement>(selector: string): T | null
}

let mounted: Mounted[] = []

function mount(
  f: Fake = fake(),
  opts: {
    account?: boolean
    alerts?: boolean
    sleep?: (ms: number) => Promise<void>
    settled?: () => Promise<void>
    busyRevealMs?: number
    sessions?: import('./sessionlist').SessionsSource
    quiet?: import('./controls').QuietHoursControl
  } = {}
): Mounted {
  const bounds = document.createElement('div')
  document.body.appendChild(bounds)
  const stops: AdvanceResult[] = []
  const state = { exits: 0 }
  const account = { open: false, toggles: 0 }
  const trade = { open: false, toggles: 0 }
  const alerts = { open: false, toggles: 0 }
  const priceStop = { price: null as number | null, sets: [] as number[], clears: 0 }
  const controls = createReplayControls({
    priceStop: {
      get: () => priceStop.price,
      set: async (price) => {
        priceStop.sets.push(price)
        priceStop.price = price
      },
      clear: async () => {
        priceStop.clears++
        priceStop.price = null
      }
    },
    controller: f.controller,
    intervalsInUse: () => [...f.controller.intervalsInUse],
    bounds,
    onExit: () => {
      state.exits++
    },
    onStop: (r) => stops.push(r),
    sleep: opts.sleep,
    settled: opts.settled,
    sessions: opts.sessions,
    quiet: opts.quiet,
    // Shown at once unless a test is about the delay itself.
    busyRevealMs: opts.busyRevealMs ?? 0,
    account:
      opts.account === false
        ? undefined
        : {
            isOpen: () => account.open,
            toggle: () => {
              account.toggles++
              account.open = !account.open
              return account.open
            }
          },
    trade: {
      isOpen: () => trade.open,
      toggle: () => {
        trade.toggles++
        trade.open = !trade.open
        return trade.open
      }
    },
    alerts:
      opts.alerts === false
        ? undefined
        : {
            isOpen: () => alerts.open,
            toggle: () => {
              alerts.toggles++
              alerts.open = !alerts.open
            }
          }
  })
  const root = controls.element
  const label = (b: Element): string => {
    const clone = b.cloneNode(true) as HTMLElement
    for (const badge of clone.querySelectorAll('.wd-replay-badge, .wd-replay-key')) badge.remove()
    return (clone.textContent ?? '').trim()
  }
  const maybeButton = (text: string): HTMLButtonElement | null =>
    ([...root.querySelectorAll('button')].find((b) => label(b) === text) as HTMLButtonElement | undefined) ?? null
  const m: Mounted = {
    ...f,
    root,
    stops,
    get exits() {
      return state.exits
    },
    account,
    trade,
    alerts,
    priceStop,
    dispose: () => controls.dispose(),
    maybeButton,
    button(text) {
      const found = maybeButton(text)
      if (!found) throw new Error(`no button "${text}"; have: ${[...root.querySelectorAll('button')].map(label).join(' | ')}`)
      return found
    },
    q: (selector) => root.querySelector(selector)
  }
  mounted.push(m)
  return m
}

afterEach(() => {
  for (const m of mounted) m.dispose()
  mounted = []
  document.body.innerHTML = ''
  window.localStorage.clear()
})

describe('the title bar and the transport', () => {
  test('the title bar names the instrument and the clock; Play, Step and Exit are in the body', () => {
    const m = mount()
    const header = m.q('.wd-window-header') as HTMLElement
    expect((header.querySelector('.wd-replay-symbol') as HTMLElement).textContent).toBe('EURUSD')
    expect(header.querySelector('.wd-replay-clock-value')).not.toBeNull()
    // Nothing in the drag handle acts on the replay: only the window's own controls remain.
    expect(header.querySelector('.wd-replay-play, .wd-replay-step, .wd-replay-exit')).toBeNull()
    const body = m.q('.wd-window-body') as HTMLElement
    const transport = body.querySelector('.wd-replay-transport') as HTMLElement
    expect(transport.querySelector('.wd-replay-play')).not.toBeNull()
    expect(transport.querySelector('.wd-replay-step')?.textContent).toBe('Step')
    // Exit ends the footer, away from the transport.
    const footer = body.querySelector('.wd-replay-toggles') as HTMLElement
    expect((footer.lastElementChild as HTMLElement).textContent).toBe('Exit replay')
  })

  test('shows the cursor and a Step that advances by the current setting', async () => {
    const m = mount()
    const clock = m.q('.wd-replay-clock-value') as HTMLElement
    // With the weekday: a cursor in the weekend has to read as one.
    expect(clock.textContent).toBe('Mon, Mar 04, 09:00:00')
    expect(clock.textContent).toBe(formatClock(m.controller.cursor, NY_TZ))
    expect(clock.title).toStartWith(new Date(m.controller.cursor).toISOString())

    const step = m.button('Step')
    expect(step.disabled).toBe(false)
    expect(step.title).toBe('Advance 5m (Shift+→)')
    step.click()
    await flush()
    expect(m.calls.step).toBe(1)
    // The result reaches the caller, which is what opens the dock on a fill.
    expect(m.stops.map((r) => r.reason)).toEqual(['target'])
  })

  test('while an advance runs, Step becomes Stop, and Stop cancels rather than steps', () => {
    const m = mount()
    m.controller.busy = true
    m.emit()
    const stop = m.button('Stop')
    expect(stop.classList.contains('is-stop')).toBe(true)
    expect(stop.disabled).toBe(false)
    expect(stop.title).toBe('Stop at the next bar (Shift+→)')
    // Leaving mid-advance is not offered.
    expect(m.button('Exit replay').disabled).toBe(true)

    stop.click()
    expect(m.calls.cancel).toBe(1)
    expect(m.calls.step).toBe(0)
    // Asked once: the button says so and cannot be pressed again.
    const stopping = m.button('Stopping…')
    expect(stopping.disabled).toBe(true)

    m.controller.busy = false
    m.controller.cancelling = false
    m.emit()
    expect(m.button('Step').classList.contains('is-stop')).toBe(false)
    expect(m.button('Exit replay').disabled).toBe(false)
  })

  test('while an advance runs, the clock shows where it started, never where the walk has got', () => {
    const m = mount()
    const clock = (): HTMLElement => m.q('.wd-replay-clock-value') as HTMLElement
    const from = m.controller.cursor
    m.controller.busy = true
    m.controller.advanceFrom = from
    m.emit()
    // Mid-walk the session has moved the cursor days ahead of anything drawn; the title bar
    // re-renders (here: Stop pressed) and must still read the chart's position.
    const walked = from + 5 * 24 * H
    m.controller.cursor = walked
    m.controller.walkedTo = walked
    m.button('Stop').click()
    expect(clock().textContent).toBe(formatClock(from, NY_TZ))
    expect(clock().title).toStartWith(new Date(from).toISOString())
    expect(clock().textContent).not.toBe(formatClock(walked, NY_TZ))

    // Landed: the chart is at the cursor now, and so is the clock.
    m.controller.busy = false
    m.controller.cancelling = false
    m.controller.advanceFrom = null
    m.controller.walkedTo = null
    m.emit()
    expect(clock().textContent).toBe(formatClock(walked, NY_TZ))
  })

  test('a quick advance never shows: no red Stop, nothing greyed, and a second click is not a cancel', async () => {
    const m = mount(fake(), { busyRevealMs: 40 })
    m.controller.busy = true
    m.emit()
    const step = m.button('Step')
    expect(step.classList.contains('is-stop')).toBe(false)
    expect(m.button('Exit replay').disabled).toBe(false)
    expect((m.q('.wd-replay-transport select') as HTMLSelectElement).disabled).toBe(false)
    // A double click: the second press lands mid-step and must not cancel it.
    step.click()
    expect(m.calls.cancel).toBe(0)
    expect(m.calls.step).toBe(0)
    // Landed inside the window: it never showed at all.
    m.controller.busy = false
    m.emit()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(m.maybeButton('Stop')).toBeNull()
  })

  test('an advance still running after the delay shows Stop; a walk report or a cancel shows it at once', async () => {
    const m = mount(fake(), { busyRevealMs: 40 })
    m.controller.busy = true
    m.emit()
    expect(m.maybeButton('Stop')).toBeNull()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(m.button('Stop').classList.contains('is-stop')).toBe(true)
    expect(m.button('Exit replay').disabled).toBe(true)

    const w = mount(fake(), { busyRevealMs: 10_000 })
    w.controller.busy = true
    w.emit()
    w.controller.walkedTo = w.controller.cursor + H
    w.emitWalk()
    expect(w.button('Stop')).not.toBeNull()
  })

  test('the clock reads on the instrument\'s own zone: a coinbase replay in UTC', () => {
    const f = fake()
    f.controller.grid = gridOf({ timezone: 'UTC', day: CONTINUOUS_DAY })
    const m = mount(f)
    const clock = m.q('.wd-replay-clock-value') as HTMLElement
    // 14:00 UTC, which New York would have shown as 09:00.
    expect(clock.textContent).toBe('Mon, Mar 04, 14:00:00')
    expect(clock.title).toContain('UTC')
  })

  test('Exit is one press: the replay is kept, and the Sessions tab resumes it', () => {
    const m = mount()
    const exit = m.button('Exit replay')
    expect(exit.title).toContain('Sessions resumes it')
    exit.click()
    expect(m.exits).toBe(1)
    expect(exit.classList.contains('is-armed')).toBe(false)
  })
})

describe('the advance row', () => {
  test('Next alert needs something to stop at: an alert, an armed watch, or an order or stop that can fill', async () => {
    const m = mount()
    const next = (): HTMLButtonElement => m.button('Next alert')
    expect(next().disabled).toBe(true)
    expect(next().title).toBe('Enable an alert (Alerts), place a price watch, or rest an order or a stop first')

    m.controller.armedStops = 1
    m.emit()
    expect(next().disabled).toBe(false)
    expect(next().title).toBe('Advance to where the next of 0 alerts triggers, or a price watch fires (Shift+↑)')

    m.controller.armedStops = 0
    m.controller.workingStops = 1
    m.emit()
    expect(next().disabled).toBe(false)
    expect(next().title).toBe('Advance to where the next of 0 alerts triggers, or an order, stop loss or take profit fills (Shift+↑)')

    m.controller.workingStops = 0
    m.controller.alertCount = 2
    m.emit()
    expect(next().disabled).toBe(false)
    expect(next().title).toBe('Advance to where the next of 2 alerts triggers (Shift+↑)')

    next().click()
    await flush()
    expect(m.calls.nextAlert).toBe(1)
    expect(m.stops.map((r) => r.reason)).toEqual(['none'])

    m.controller.busy = true
    m.emit()
    expect(next().disabled).toBe(true)
  })

  test('Next alert leads the window, is the primary button, and carries its key', () => {
    const m = mount()
    const rows = [...m.root.querySelectorAll('.wd-window-body > .wd-replay-row')]
    expect(rows[0]?.classList.contains('wd-replay-next-row')).toBe(true)
    const next = m.button('Next alert')
    expect(next.classList.contains('kc-button-primary')).toBe(true)
    expect(m.button('Step').classList.contains('kc-button-primary')).toBe(false)
    expect(next.querySelector('.wd-replay-key')?.textContent).toBe('⇧↑')
  })

  test('while its own run shows, Next alert is the Stop', async () => {
    const m = mount()
    m.controller.alertCount = 1
    let finish: (r: AdvanceResult | null) => void = () => {}
    m.controller.nextAlert = () => {
      m.calls.nextAlert++
      m.controller.busy = true
      m.emit()
      return new Promise((resolve) => {
        finish = resolve
      })
    }
    m.emit()
    m.button('Next alert').click()
    const next = () => m.q<HTMLButtonElement>('.wd-replay-next') as HTMLButtonElement
    expect(next().textContent).toBe('Stop')
    expect(next().classList.contains('is-stop')).toBe(true)
    expect(next().disabled).toBe(false)
    next().click()
    expect(m.calls.cancel).toBe(1)
    expect(next().textContent).toBe('Stopping…')
    m.controller.busy = false
    m.controller.cancelling = false
    finish(null)
    await flush()
    expect(m.maybeButton('Next alert')).not.toBeNull()
    // A Step's run is stopped from Step: Next alert is only disabled meanwhile.
    m.controller.busy = true
    m.emit()
    expect(m.button('Next alert').disabled).toBe(true)
  })

  test('there is no Next signal any more', () => {
    expect(mount().maybeButton('Next signal')).toBeNull()
  })

  const picker = (m: Mounted): HTMLSelectElement => m.q<HTMLSelectElement>('.wd-replay-step-size') as HTMLSelectElement
  const field = (m: Mounted): HTMLInputElement | null => m.q<HTMLInputElement>('.wd-replay-step-custom')
  const type = (m: Mounted, text: string, key = 'Enter'): void => {
    const input = field(m) as HTMLInputElement
    input.value = text
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  }

  test('the step picker offers the base, the stored ladder and the panes, shortest first, then a step of your own', () => {
    const m = mount()
    expect([...picker(m).options].map((o) => o.textContent)).toEqual(['1m', '5m', '1h', '1D', 'Custom step…'])
    expect(picker(m).value).toBe('1*5m')
    change(picker(m), '1*1h')
    expect(m.calls.setAdvance).toEqual([{ interval: '1h', multiple: 1 }])
    // No separate multiple any more: a step of several candles is typed ("3 × 4h", "15h").
    expect(m.q('.wd-replay-number')).toBeNull()
  })

  test('Custom step… takes any amount, applies it on Enter and offers it again', () => {
    const m = mount()
    change(picker(m), 'custom')
    expect(field(m)).not.toBeNull()
    type(m, '15h')
    expect(m.calls.setAdvance.at(-1)).toEqual({ interval: '1h', multiple: 15 })
    expect(field(m)).toBeNull()
    change(picker(m), 'custom')
    type(m, '30h')
    expect(m.calls.setAdvance.at(-1)).toEqual({ interval: '1h', multiple: 30 })
    // Both are on the list now, most recent first after the timeframes, in this browser.
    expect([...picker(m).options].map((o) => o.textContent)).toEqual(['1m', '5m', '1h', '1D', '30h', '15h', 'Custom step…'])
    expect(JSON.parse(window.localStorage.getItem('wd.replay.steps') ?? '[]')).toEqual(['30h', '15h'])
    // A listed timeframe typed is that timeframe, and is not listed twice.
    change(picker(m), 'custom')
    type(m, '1h')
    expect(m.calls.setAdvance.at(-1)).toEqual({ interval: '1h', multiple: 1 })
    expect(JSON.parse(window.localStorage.getItem('wd.replay.steps') ?? '[]')).toEqual(['30h', '15h'])
  })

  test('a step that is not one is refused with the reason, and Escape gives the picker back', () => {
    const m = mount()
    change(picker(m), 'custom')
    type(m, 'soon')
    expect(m.calls.setAdvance).toEqual([])
    expect(m.root.querySelector('.wd-replay-flash')?.textContent).toContain('not a step')
    expect(field(m)).not.toBeNull()
    type(m, '', 'Escape')
    expect(field(m)).toBeNull()
    expect(m.calls.setAdvance).toEqual([])
  })

  test('a remembered step the replay is on can be taken off the list', () => {
    window.localStorage.setItem('wd.replay.steps', JSON.stringify(['15h']))
    const m = mount()
    m.controller.advance = { interval: '1h', multiple: 15 }
    m.emit()
    expect(picker(m).value).toBe('15*1h')
    m.button('×').click()
    expect(JSON.parse(window.localStorage.getItem('wd.replay.steps') ?? '[]')).toEqual([])
    // Still the step: only the list forgot it.
    expect(picker(m).value).toBe('15*1h')
    expect([...picker(m).options].map((o) => o.textContent)).toContain('15h')
  })

  test('busy, the step picker is disabled', () => {
    const m = mount()
    m.controller.busy = true
    m.emit()
    expect(picker(m).disabled).toBe(true)
  })
})

describe('the status line', () => {
  const reasons: Array<[string, Partial<AdvanceResult>, string]> = [
    ['an alert, by its name', { reason: 'alert', alert: { alertId: 'a1', name: 'RSI oversold', symbol: 'oanda:EURUSD', effective: 0, readings: '' } }, 'Alert: RSI oversold'],
    ['nothing ahead', { reason: 'none' }, 'No alert triggers before the end of the data'],
    ['a fill', { reason: 'fill', events: [{ kind: 'fill' } as never] }, 'Order filled'],
    ['a stop loss', { reason: 'fill', events: [{ kind: 'fill' }, { kind: 'close', reason: 'stop_loss' }] as never }, 'Stop loss hit'],
    ['a take profit', { reason: 'fill', events: [{ kind: 'close', reason: 'take_profit' } as never] }, 'Take profit hit'],
    ['a close', { reason: 'fill', events: [{ kind: 'close', reason: 'manual' } as never] }, 'Closed by hand'],
    ['a watch', { reason: 'watch', observed: [{ label: 'EURUSD 1.10000' }] }, 'Stopped at watch EURUSD 1.10000'],
    ['several watches on one bar', { reason: 'watch', observed: [{ label: 'EURUSD 1.10000' }, { label: 'b' }, { label: 'c' }] }, 'Stopped at watch EURUSD 1.10000 +2'],
    ['a cancel after walking', { reason: 'cancel', walked: true, bars: [{}, {}, {}] as never }, 'Stopped by you after 3 bars'],
    ['a cancel after one bar', { reason: 'cancel', walked: true, bars: [{}] as never }, 'Stopped by you after 1 bar'],
    ['a cancel before any bar', { reason: 'cancel', walked: false, bars: [] }, 'Stopped by you before the first bar'],
    ['the end of the data', { reason: 'end' }, 'End of data'],
    // What was asked for -- never "0 bars" or "nothing working" for a step that seeked.
    ['a walked step', { reason: 'target', walked: true, bars: [{}, {}] as never }, 'Stepped 5m'],
    ['a seeked step', { reason: 'target', walked: false }, 'Stepped 5m'],
    ['a step of several candles', { reason: 'target', request: { interval: '15m', multiple: 3 } }, 'Stepped 3 × 15m'],
    // As the step picker words it: 5m is a timeframe here (a pane shows it), so five 1m candles
    // are not "5m"; 15m is not, so fifteen read as the span.
    ['five 1m candles where 5m is a timeframe', { reason: 'target', request: { interval: '1m', multiple: 5 } }, 'Stepped 5 × 1m'],
    ['fifteen 1m candles where 15m is not', { reason: 'target', request: { interval: '1m', multiple: 15 } }, 'Stepped 15m']
  ]

  test('is absent until an advance has stopped', () => {
    const m = mount()
    expect(m.q('.wd-replay-stop-reason')).toBeNull()
    expect(m.q('.wd-replay-walk')).toBeNull()
  })

  test('while a walk runs, says how far it has got -- in place of the last stop, patched per report', () => {
    const m = mount()
    const from = m.controller.cursor
    m.controller.lastStop = result({ reason: 'target', walked: true, bars: [{}] as never })
    m.emit()
    m.controller.busy = true
    m.controller.advanceFrom = from
    m.emit()
    // Busy but not walking yet (still planning, or a seek): the last stop stays.
    expect(m.q('.wd-replay-walk')).toBeNull()
    expect((m.q('.wd-replay-stop-reason') as HTMLElement).textContent).toBe('Stepped 5m')

    // The first report: there is no line to patch yet, so the window renders it.
    const first = from + 26 * H
    m.controller.walkedTo = first
    m.emitWalk()
    const line = m.q('.wd-replay-walk') as HTMLElement
    expect(line.textContent).toBe(`Walking… reached ${formatClock(first, NY_TZ)}`)
    expect(line.title).toContain(new Date(first).toISOString())
    expect(line.title).toContain('The chart and the clock move when it stops')
    // The stale reason is gone, and the clock still reads the start.
    expect(m.q('.wd-replay-stop-reason')).toBeNull()
    expect((m.q('.wd-replay-clock-value') as HTMLElement).textContent).toBe(formatClock(from, NY_TZ))

    // Later reports patch the one line: the Stop button is the SAME element, so a press on it
    // is not released onto a replacement (which would be no click at all).
    const stop = m.button('Stop')
    const later = from + 9 * 24 * H
    m.controller.walkedTo = later
    m.emitWalk()
    expect(m.q('.wd-replay-walk')).toBe(line)
    expect(line.textContent).toBe(`Walking… reached ${formatClock(later, NY_TZ)}`)
    expect(m.button('Stop')).toBe(stop)

    // Ended: the reach goes and why it stopped comes back.
    m.controller.busy = false
    m.controller.advanceFrom = null
    m.controller.walkedTo = null
    m.controller.lastStop = result({ reason: 'cancel', walked: true, bars: [{}, {}] as never })
    m.emit()
    expect(m.q('.wd-replay-walk')).toBeNull()
    expect((m.q('.wd-replay-stop-reason') as HTMLElement).textContent).toBe('Stopped by you after 2 bars')
  })

  for (const [name, stop, text] of reasons) {
    test(`says why: ${name}`, () => {
      const m = mount()
      m.controller.lastStop = result(stop)
      m.emit()
      const line = m.q('.wd-replay-stop-reason') as HTMLElement
      expect(line.textContent).toBe(text)
      // The class is the reason itself: the stylesheet colours alert, fill and watch stops.
      expect(line.classList.contains(`is-${stop.reason}`)).toBe(true)
      expect(line.title).toBe(text)
    })
  }

  test('an alert stop carries what the rule read, on hover', () => {
    const m = mount()
    m.controller.lastStop = result({ reason: 'alert', alert: { alertId: 'a1', name: 'oversold', symbol: 'oanda:EURUSD', effective: 0, readings: 'RSI(14) 1h 28.1' } })
    m.emit()
    expect((m.q('.wd-replay-stop-reason') as HTMLElement).title).toBe('Alert: oversold — RSI(14) 1h 28.1')
  })

  test('while Next alert searches, says how far ahead it has looked -- and then how far it has walked', () => {
    const m = mount()
    const from = m.controller.cursor
    m.controller.busy = true
    m.controller.advanceFrom = from
    m.controller.searchedTo = from + 30 * 24 * H
    m.emitWalk()
    const line = m.q('.wd-replay-walk') as HTMLElement
    expect(line.textContent).toBe(`Looking for the next alert… reached ${formatClock(from + 30 * 24 * H, NY_TZ)}`)
    expect(line.title).toContain('Nothing moves until one triggers')
    // The Stop button is up during the search: it is how a long look is abandoned.
    const stop = m.button('Stop')
    m.controller.searchedTo = null
    m.controller.walkedTo = from + 2 * H
    m.emitWalk()
    expect(m.q('.wd-replay-walk')).toBe(line)
    expect(line.textContent).toBe(`Walking… reached ${formatClock(from + 2 * H, NY_TZ)}`)
    expect(m.button('Stop')).toBe(stop)
  })
})

describe('the panels', () => {
  test('Base opens its panel and a second press closes it', () => {
    const m = mount()
    expect(m.q('.wd-replay-panel')).toBeNull()
    m.button('Base 1m').click()
    expect(m.root.querySelectorAll('.wd-replay-panel').length).toBe(1)
    expect(m.button('Base 1m').classList.contains('is-on')).toBe(true)
    m.button('Base 1m').click()
    expect(m.q('.wd-replay-panel')).toBeNull()
  })

  test('an open panel survives a re-render from the controller', () => {
    const m = mount()
    m.button('Base 1m').click()
    m.emit()
    expect(m.q('.wd-replay-panel')).not.toBeNull()
  })

  test('Alerts opens the alert manager and badges the alerts Next alert can stop at', () => {
    const m = mount()
    expect(m.q('.wd-replay-badge')).toBeNull()
    expect(m.button('Alerts').title).toBe('The alert manager: 0 enabled, which is where Next alert stops')
    m.controller.alertCount = 3
    m.emit()
    expect((m.q('.wd-replay-badge') as HTMLElement).textContent).toBe('3')
    m.button('Alerts').click()
    expect(m.alerts.toggles).toBe(1)
    expect(m.button('Alerts').getAttribute('aria-pressed')).toBe('true')
    // No panel of its own: the manager is a window.
    expect(m.q('.wd-replay-panel')).toBeNull()
    // Without a manager there is no toggle.
    expect(mount(fake(), { alerts: false }).maybeButton('Alerts')).toBeNull()
  })

  test('settings: the base picker writes through the controller and a refusal is shown', () => {
    const m = mount()
    m.button('Base 1m').click()
    const picker = (): HTMLSelectElement => m.q('.wd-replay-panel select') as HTMLSelectElement
    expect([...picker().options].map((o) => o.value)).toEqual(['1m', '1h', '1D'])

    // 1h does not divide the 5m pane: refused, and the reason flashed on the window.
    change(picker(), '1h')
    expect(m.calls.setBase).toEqual(['1h'])
    expect(m.controller.base).toBe('1m')
    expect((m.q('.wd-replay-flash') as HTMLElement).textContent).toContain('5m')
  })

  test('settings: a base that no longer fits the wall is flagged on the toggle and in the panel', () => {
    const f = fake()
    f.controller.base = '1h'
    const m = mount(f)
    const toggle = m.button('Base 1h')
    expect(toggle.classList.contains('is-invalid')).toBe(true)
    expect(toggle.title).toContain('5m')
    toggle.click()
    expect((m.q('.wd-replay-warning') as HTMLElement).textContent).toContain('5m')
    expect((m.q('.wd-replay-panel select') as HTMLSelectElement).classList.contains('is-invalid')).toBe(true)
  })

  test('Results: an empty session says how to start scoring', () => {
    const m = mount()
    m.button('Results').click()
    const panel = m.q('.wd-replay-results') as HTMLElement
    expect((panel.querySelector('.wd-replay-results-net') as HTMLElement).textContent).toBe('0.00 USD · 0.00%')
    expect(panel.textContent).toContain('No trades yet')
    expect(panel.querySelector('.wd-tk-figs')).toBeNull()
  })

  test('Results: the score, and it follows a trade closed between advances', () => {
    const f = fake()
    f.controller.snapshot = snapshotOf([closedTrade('1', 120, f.controller.cursor - 3 * H)], { balance: 10_120, equity: 10_120 })
    const m = mount(f)
    m.button('Results').click()
    const net = (): HTMLElement => m.q('.wd-replay-results-net') as HTMLElement
    const figure = (label: string): string =>
      ([...m.root.querySelectorAll('.wd-tk-fig')].find((n) => n.querySelector('dt')?.textContent === label)?.querySelector('dd')?.textContent ?? '') as string
    expect(net().textContent).toBe('+120.00 USD · +1.20%')
    expect(net().classList.contains('is-up')).toBe(true)
    expect(figure('Win rate')).toBe('100% · 1W 0L')
    expect(figure('Profit factor')).toBe('∞')

    // A losing close arrives with no control change: the panel follows the account.
    f.controller.snapshot = snapshotOf([closedTrade('1', 120, f.controller.cursor - 3 * H), closedTrade('2', -200, f.controller.cursor - H)], { balance: 9_920, equity: 9_920 })
    f.emitSnapshot()
    expect(net().textContent).toBe('−80.00 USD · −0.80%')
    expect(figure('Win rate')).toBe('50% · 1W 1L')
    expect(figure('Profit factor')).toBe('0.60')
    expect(figure('Max drawdown')).toBe('−200.00 · 1.98%')
  })

  test('settings: pause on fill', () => {
    const m = mount()
    m.button('Base 1m').click()
    const box = m.q('.wd-replay-check input') as HTMLInputElement
    expect(box.checked).toBe(false)
    check(box, true)
    expect(m.calls.setPauseOnFill).toEqual([true])
  })

  test('Account mirrors the dock and toggles it', () => {
    const m = mount()
    expect(m.button('Account').getAttribute('aria-pressed')).toBe('false')
    expect(m.button('Account').title).toBe('Show the account and tables')
    m.button('Account').click()
    expect(m.account.toggles).toBe(1)
    expect(m.button('Account').getAttribute('aria-pressed')).toBe('true')
    expect(m.button('Account').title).toBe('Hide the account and tables')

    // Without an account to show there is no toggle at all.
    const bare = mount(fake(), { account: false })
    expect(bare.maybeButton('Account')).toBeNull()
  })

  test('Trade mirrors the trade box and toggles it, apart from the account', () => {
    const m = mount()
    expect(m.button('Trade').getAttribute('aria-pressed')).toBe('false')
    m.button('Trade').click()
    expect(m.trade.toggles).toBe(1)
    expect(m.account.toggles).toBe(0)
    expect(m.button('Trade').getAttribute('aria-pressed')).toBe('true')
    expect(m.button('Trade').title).toBe('Hide the order ticket')
  })
})

describe('the Go to panel', () => {
  // The fake's cursor: Monday 2024-03-04 14:00Z, 09:00 New York.
  const typeInto = (input: HTMLInputElement, value: string, event = 'change'): void => {
    input.value = value
    input.dispatchEvent(new Event(event))
  }

  test('goes to 06:00 on the next trading day by default, saying where before it goes', async () => {
    const m = mount()
    m.button('Go to').click()
    const time = m.q<HTMLInputElement>('.wd-replay-goto-time') as HTMLInputElement
    expect(time.value).toBe('06:00')
    // Tuesday 06:00 New York (EST in early March): 11:00Z.
    expect(m.q('.wd-replay-goto-target')?.textContent).toContain('06:00')
    m.button('Go').click()
    await flush()
    expect(m.calls.goTo).toEqual([Date.UTC(2024, 2, 5, 11, 0)])
    expect(m.stops.at(-1)?.reason).toBe('target')
  })

  test('the next time today, a time typed in, and Enter goes', async () => {
    const m = mount()
    m.button('Go to').click()
    const mode = m.q<HTMLSelectElement>('.wd-replay-goto select') as HTMLSelectElement
    mode.value = 'next'
    mode.dispatchEvent(new Event('change'))
    const time = m.q<HTMLInputElement>('.wd-replay-goto-time') as HTMLInputElement
    typeInto(time, '10:30')
    ;(m.q<HTMLInputElement>('.wd-replay-goto-time') as HTMLInputElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flush()
    // 10:30 New York the same Monday.
    expect(m.calls.goTo).toEqual([Date.UTC(2024, 2, 4, 15, 30)])
    // The time and the day are remembered; a re-mount opens on them.
    m.dispose()
    const again = mount()
    again.button('Go to').click()
    expect((again.q<HTMLInputElement>('.wd-replay-goto-time') as HTMLInputElement).value).toBe('10:30')
    expect((again.q<HTMLSelectElement>('.wd-replay-goto select') as HTMLSelectElement).value).toBe('next')
  })

  test('on a date: a date before the clock cannot be gone to', async () => {
    const m = mount()
    m.button('Go to').click()
    const mode = m.q<HTMLSelectElement>('.wd-replay-goto select') as HTMLSelectElement
    mode.value = 'date'
    mode.dispatchEvent(new Event('change'))
    const day = m.q<HTMLInputElement>('.wd-replay-goto-day') as HTMLInputElement
    typeInto(day, '2024-03-01')
    expect(m.button('Go').disabled).toBe(true)
    typeInto(m.q<HTMLInputElement>('.wd-replay-goto-day') as HTMLInputElement, '2024-03-07')
    m.button('Go').click()
    await flush()
    expect(m.calls.goTo).toEqual([Date.UTC(2024, 2, 7, 11, 0)])
  })

  test('a stop price is set from the panel, shown, run to and removed', async () => {
    const m = mount()
    m.button('Go to').click()
    // Run needs something to run to.
    expect(m.button('Run').disabled).toBe(true)
    const price = m.q<HTMLInputElement>('.wd-replay-price') as HTMLInputElement
    typeInto(price, '1.08500', 'input')
    m.button('Stop here').click()
    await flush()
    expect(m.priceStop.sets).toEqual([1.085])
    expect(m.q('.wd-replay-price-current')?.textContent).toBe('stops at 1.085')
    // The watch it is counts as an armed stop, which is what Run (and Next alert) need.
    m.controller.armedStops = 1
    m.emit()
    m.button('Run').click()
    await flush()
    expect(m.calls.runToWatch).toBe(1)
    // The controller keeps the stop; the status line says what a run that found nothing means.
    m.controller.lastStop = m.stops.at(-1) ?? null
    m.emit()
    expect(m.q('.wd-replay-stop-reason')?.textContent).toBe('The price is not reached before the end of the data')
    m.button('×').click()
    await flush()
    expect(m.priceStop.clears).toBe(1)
    expect(m.q('.wd-replay-price-current')).toBeNull()
  })

  test('a price that is not one is refused, and nothing is set', async () => {
    const m = mount()
    m.button('Go to').click()
    typeInto(m.q<HTMLInputElement>('.wd-replay-price') as HTMLInputElement, 'abc', 'input')
    m.button('Stop here').click()
    await flush()
    expect(m.priceStop.sets).toEqual([])
    expect(m.root.textContent).toContain('Type the price to stop at')
  })

  test('a Go to stop says where it went', async () => {
    const m = mount()
    m.controller.lastStop = result({ reason: 'target', request: { to: Date.UTC(2024, 2, 5, 11) }, to: Date.UTC(2024, 2, 5, 11) })
    m.emit()
    expect(m.q('.wd-replay-stop-reason')?.textContent).toContain('Went to')
    expect(m.q('.wd-replay-stop-reason')?.textContent).toContain('06:00')
  })
})

describe('play', () => {
  /** A sleep the test releases by hand, so a played step happens exactly when it says. */
  function manualSleep(): { sleep: (ms: number) => Promise<void>; waits: number[]; release(): Promise<void> } {
    const pending: Array<() => void> = []
    const waits: number[] = []
    return {
      waits,
      sleep: (ms) => {
        waits.push(ms)
        return new Promise((resolve) => pending.push(resolve))
      },
      async release() {
        for (const r of pending.splice(0)) r()
        await flush()
      }
    }
  }

  const play = (m: Mounted): HTMLButtonElement => m.q('.wd-replay-play') as HTMLButtonElement

  test('Play steps again and again at the chosen pace, and Pause stops it', async () => {
    const clock = manualSleep()
    const m = mount(fake(), { sleep: clock.sleep })
    expect(play(m).getAttribute('aria-label')).toBe('Play')
    expect(play(m).title).toContain('every 1 s')
    play(m).click()
    await flush()
    expect(m.calls.step).toBe(1)
    expect(play(m).getAttribute('aria-label')).toBe('Pause')
    expect(play(m).classList.contains('is-on')).toBe(true)
    expect(clock.waits).toEqual([1000])
    await clock.release()
    expect(m.calls.step).toBe(2)
    // Every played step is handed on, as a clicked one is (the dock opens on a fill).
    expect(m.stops.length).toBe(2)

    play(m).click()
    expect(play(m).getAttribute('aria-label')).toBe('Play')
    await clock.release()
    expect(m.calls.step).toBe(2)
  })

  test('while playing the status says so, and gives way to why the play stopped', async () => {
    const clock = manualSleep()
    const f = fake()
    let n = 0
    f.controller.step = async () => {
      n++
      const r = result({ reason: n === 2 ? 'end' : 'target' })
      f.controller.lastStop = r
      return r
    }
    const m = mount(f, { sleep: clock.sleep })
    play(m).click()
    await flush()
    const chip = (): HTMLElement => m.q('.wd-replay-stop-reason') as HTMLElement
    expect(chip().textContent).toBe('Playing every 1 s')
    expect(chip().classList.contains('is-playing')).toBe(true)
    await clock.release()
    expect(chip().textContent).toBe('End of data')
  })

  test('the pace is chosen beside the step and remembered per browser', async () => {
    const clock = manualSleep()
    const m = mount(fake(), { sleep: clock.sleep })
    const pace = m.q('.wd-replay-pace') as HTMLSelectElement
    expect([...pace.options].map((o) => o.textContent)).toEqual(['¼ s', '½ s', '1 s', '2 s', '5 s'])
    expect(pace.value).toBe('1000')
    change(pace, '250')
    expect(window.localStorage.getItem('wd.replay.playDelay')).toBe('250')
    play(m).click()
    await flush()
    expect(clock.waits).toEqual([250])
    m.dispose()

    const again = mount(fake(), { sleep: clock.sleep })
    expect((again.q('.wd-replay-pace') as HTMLSelectElement).value).toBe('250')
  })

  test('play stops by itself on anything but reaching the target: the stop is the point', async () => {
    for (const reason of ['fill', 'alert', 'watch', 'end', 'cancel', 'none'] as const) {
      const clock = manualSleep()
      const f = fake()
      let n = 0
      f.controller.step = async () => {
        f.calls.step++
        n++
        return result({ reason: n === 2 ? reason : 'target' })
      }
      const m = mount(f, { sleep: clock.sleep })
      play(m).click()
      await flush()
      await clock.release()
      expect(f.calls.step).toBe(2)
      expect(play(m).getAttribute('aria-label')).toBe('Play')
      await clock.release()
      expect(f.calls.step).toBe(2)
      m.dispose()
    }
  })

  test('the next step waits for the wall to load as well as for the pace', async () => {
    const clock = manualSleep()
    let settle: () => void = () => {}
    const settled = (): Promise<void> => new Promise((resolve) => (settle = resolve))
    const m = mount(fake(), { sleep: clock.sleep, settled })
    play(m).click()
    await flush()
    await clock.release()
    expect(m.calls.step).toBe(1)
    settle()
    await flush()
    expect(m.calls.step).toBe(2)
  })

  test('a Step, Next alert or Exit pressed while playing ends the play', async () => {
    const clock = manualSleep()
    const m = mount(fake(), { sleep: clock.sleep })
    play(m).click()
    await flush()
    m.button('Step').click()
    await flush()
    expect(play(m).getAttribute('aria-label')).toBe('Play')
    expect(m.calls.step).toBe(2)
    await clock.release()
    expect(m.calls.step).toBe(2)

    m.controller.armedStops = 1
    m.emit()
    play(m).click()
    await flush()
    m.button('Next alert').click()
    await flush()
    expect(play(m).getAttribute('aria-label')).toBe('Play')
    expect(m.calls.nextAlert).toBe(1)
  })

  test('busy with an advance it did not start, Play waits; started by it, it is the Pause', () => {
    const m = mount()
    m.controller.busy = true
    m.emit()
    expect(play(m).disabled).toBe(true)
  })
})

describe('keys', () => {
  function key(init: KeyboardEventInit, target: EventTarget = document.body): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }

  test('Shift+→ is Step, and is kept from the chart (whose own Shift+→ scrolls)', async () => {
    const m = mount()
    const seen: string[] = []
    const chartListener = (e: Event): void => {
      seen.push((e as KeyboardEvent).key)
    }
    document.addEventListener('keydown', chartListener)
    const event = key({ key: 'ArrowRight', shiftKey: true })
    await flush()
    expect(m.calls.step).toBe(1)
    expect(event.defaultPrevented).toBe(true)
    expect(seen).toEqual([])
    // Without Shift, or with another modifier, it is somebody else's key.
    key({ key: 'ArrowRight' })
    key({ key: 'ArrowRight', shiftKey: true, ctrlKey: true })
    await flush()
    expect(m.calls.step).toBe(1)
    expect(seen).toEqual(['ArrowRight', 'ArrowRight'])
    document.removeEventListener('keydown', chartListener)
  })

  test('Shift+↑ is Next alert, and only when there is something to stop at', async () => {
    const m = mount()
    const event = key({ key: 'ArrowUp', shiftKey: true })
    await flush()
    expect(event.defaultPrevented).toBe(true)
    expect(m.calls.nextAlert).toBe(0)
    m.controller.alertCount = 1
    m.emit()
    key({ key: 'ArrowUp', shiftKey: true })
    await flush()
    expect(m.calls.nextAlert).toBe(1)
    key({ key: 'ArrowUp' })
    await flush()
    expect(m.calls.nextAlert).toBe(1)
  })

  test('Shift+→ while an advance runs is Stop -- but a held key repeating never cancels', () => {
    const m = mount()
    m.controller.busy = true
    m.emit()
    key({ key: 'ArrowRight', shiftKey: true, repeat: true })
    expect(m.calls.cancel).toBe(0)
    key({ key: 'ArrowRight', shiftKey: true })
    expect(m.calls.cancel).toBe(1)
  })

  test('Shift+↓ is Play/Pause', async () => {
    const m = mount(fake(), { sleep: () => new Promise(() => {}) })
    key({ key: 'ArrowDown', shiftKey: true })
    await flush()
    expect((m.q('.wd-replay-play') as HTMLButtonElement).getAttribute('aria-label')).toBe('Pause')
    key({ key: 'ArrowDown', shiftKey: true })
    expect((m.q('.wd-replay-play') as HTMLButtonElement).getAttribute('aria-label')).toBe('Play')
  })

  test('a key typed into a field is the field\'s, and a disposed window hears nothing', async () => {
    const m = mount()
    change(m.q('.wd-replay-step-size') as HTMLSelectElement, 'custom')
    const input = m.q('.wd-replay-step-custom') as HTMLInputElement
    key({ key: 'ArrowRight', shiftKey: true }, input)
    // A pane grip moves its pane with the arrows, Shift or not.
    const grip = document.createElement('button')
    grip.className = 'klinecharts-pro-pane-grip'
    document.body.appendChild(grip)
    key({ key: 'ArrowRight', shiftKey: true }, grip)
    await flush()
    expect(m.calls.step).toBe(0)
    m.dispose()
    key({ key: 'ArrowRight', shiftKey: true })
    await flush()
    expect(m.calls.step).toBe(0)
  })
})

describe('the follow notice', () => {
  const notice = (m: Mounted): HTMLElement | null => m.q('.wd-replay-notice')

  test('absent while the chart and the replay agree', () => {
    const m = mount()
    expect(notice(m)).toBeNull()
  })

  test('kept by something open: which instrument it walks, why it stayed, what to do', () => {
    const f = fake()
    f.controller.followNotice = { symbol: 'oanda:GBPUSD', ticker: 'GBPUSD', problem: null, moving: false }
    f.controller.followBlockers = { trades: 1, orders: 0, watches: 1 }
    const m = mount(f)
    const box = notice(m) as HTMLElement
    expect(box.getAttribute('role')).toBe('status')
    expect(box.textContent).toContain('The replay walks EURUSD, not GBPUSD: EURUSD has 1 open trade and 1 armed price watch. Close or remove them to follow GBPUSD, or exit the replay.')
    // Below the transport and Next alert, above the footer.
    const body = m.q('.wd-window-body') as HTMLElement
    expect([...body.children].indexOf(box)).toBe([...body.children].indexOf(m.q('.wd-replay-toggles') as HTMLElement) - 1)
    // Follow is offered, and refused until they are gone.
    const follow = m.button('Follow GBPUSD')
    expect(follow.disabled).toBe(true)
    expect(follow.title).toContain('Close or remove them first')

    // The trade closed and the watch removed: the same notice now offers the follow.
    f.controller.followBlockers = { trades: 0, orders: 0, watches: 0 }
    f.emit()
    expect((notice(m) as HTMLElement).textContent).toContain('Nothing is open on it any more, so it can follow the chart to GBPUSD from here.')
    expect(m.button('Follow GBPUSD').disabled).toBe(false)
    m.button('Follow GBPUSD').click()
    expect(f.calls.follow).toBe(1)
  })

  test('× keeps walking the instrument walked, and the notice goes', () => {
    const f = fake()
    f.controller.followNotice = { symbol: 'oanda:GBPUSD', ticker: 'GBPUSD', problem: null, moving: false }
    f.controller.followBlockers = { trades: 0, orders: 2, watches: 0 }
    const m = mount(f)
    const keep = m.q('.wd-replay-notice-close') as HTMLButtonElement
    expect(keep.getAttribute('aria-label')).toBe('Keep walking EURUSD')
    keep.click()
    expect(f.calls.dismissFollow).toBe(1)
    expect(notice(m)).toBeNull()
  })

  test('an instrument that cannot be walked: its reason, and Follow to try again', () => {
    const f = fake()
    f.controller.followNotice = { symbol: 'oanda:GBPUSD', ticker: 'GBPUSD', problem: 'No stored bars for GBPUSD at the replay’s clock', moving: false }
    const m = mount(f)
    expect((notice(m) as HTMLElement).textContent).toContain('The replay walks EURUSD, not GBPUSD: no stored bars for GBPUSD at the replay’s clock.')
    expect(m.button('Follow GBPUSD').disabled).toBe(false)
  })

  test('being made: it says so and offers nothing', () => {
    const f = fake()
    f.controller.followNotice = { symbol: 'oanda:GBPUSD', ticker: 'GBPUSD', problem: null, moving: true }
    const m = mount(f)
    expect((notice(m) as HTMLElement).textContent).toBe('Following GBPUSD…')
    expect(m.maybeButton('Follow GBPUSD')).toBeNull()
  })
})

describe('lifetime', () => {
  test('refresh re-renders from the controller; dispose stops listening and removes the window', () => {
    const f = fake()
    const bounds = document.createElement('div')
    document.body.appendChild(bounds)
    const controls = createReplayControls({ controller: f.controller, intervalsInUse: () => ['5m'], bounds, onExit: () => {} })
    expect(f.listeners.size).toBe(1)
    f.controller.cursor += H
    controls.refresh()
    expect((controls.element.querySelector('.wd-replay-clock-value') as HTMLElement).textContent).toBe(formatClock(f.controller.cursor, NY_TZ))

    controls.dispose()
    expect(f.listeners.size).toBe(0)
    expect(document.body.contains(controls.element)).toBe(false)
  })
})

type Listed = import('./sessionlist').ListedSession
type Summary = import('./sessions').ReplaySessionSummary

describe('the Sessions panel: switching replays from the replay window', () => {
  type Source = import('./sessionlist').SessionsSource

  function source(rows: Listed[]) {
    const resumed: Summary[] = []
    const removed: string[] = []
    const state = { loads: 0, failResume: false }
    const src: Source = {
      load: () => {
        state.loads++
        return Promise.resolve(rows)
      },
      // Resolves without the wall rebuilding: in the app the rebuild disposes the window first.
      resume: async (s) => {
        if (state.failResume) throw new Error('nope')
        resumed.push(s)
      },
      remove: async (id) => {
        removed.push(id)
      }
    }
    return { src, resumed, removed, state }
  }

  const cards = (m: Mounted): HTMLElement[] => [...m.root.querySelectorAll('.wd-replay-session')] as HTMLElement[]
  const inCard = (card: HTMLElement, text: string): HTMLButtonElement =>
    [...card.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement
  const panel = (m: Mounted): HTMLElement | null => m.q('.wd-replay-sessions-panel')

  test('without a list to show there is no Sessions toggle', () => {
    expect(mount().maybeButton('Sessions')).toBeNull()
  })

  test('Sessions opens the list as one of the panels, and loads it afresh each time it opens', async () => {
    const s = source(listed([stored('a'), stored('b', { ticker: 'GBPUSD' })]))
    const m = mount(fake(), { sessions: s.src })
    m.button('Sessions').click()
    expect(m.button('Sessions').getAttribute('aria-pressed')).toBe('true')
    expect(panel(m)?.textContent).toBe('Loading your replays…')
    await flush()
    expect(cards(m).map((c) => c.dataset.session)).toEqual(['a', 'b'])
    expect(cards(m)[1].textContent).toContain('GBPUSD')
    // One panel at a time: Results takes its place.
    m.button('Results').click()
    expect(panel(m)).toBeNull()
    expect(m.q('.wd-replay-results')).not.toBeNull()
    m.button('Sessions').click()
    await flush()
    expect(s.state.loads).toBe(2)
    expect(cards(m).length).toBe(2)
    // A second press closes it.
    m.button('Sessions').click()
    expect(panel(m)).toBeNull()
  })

  test('a re-render keeps the list it has: not loaded again, not rebuilt', async () => {
    const s = source(listed([stored('a'), stored('b')]))
    const m = mount(fake(), { sessions: s.src })
    m.button('Sessions').click()
    await flush()
    const list = m.q('.wd-replay-session-list')
    inCard(cards(m)[0], 'Stats').click()
    // Every step re-renders the window, twice a second while playing.
    m.emit()
    m.emit()
    expect(s.state.loads).toBe(1)
    expect(m.q('.wd-replay-session-list')).toBe(list)
    expect(inCard(cards(m)[0], 'Hide stats')).toBeDefined()
  })

  test('nothing else to switch to: it says so', async () => {
    const m = mount(fake(), { sessions: source([]).src })
    m.button('Sessions').click()
    await flush()
    expect(panel(m)?.textContent).toBe('No other replays. A replay you start from the live wall is kept here to switch to.')
  })

  test('Resume ends a play and hands the session over; the row says Opening… until the wall is rebuilt', async () => {
    const s = source(listed([stored('a'), stored('b')]))
    // A play whose pause between steps never ends: it is playing until something stops it.
    const m = mount(fake(), { sessions: s.src, sleep: () => new Promise(() => {}) })
    m.button('Sessions').click()
    await flush()
    ;(m.q('.wd-replay-play') as HTMLButtonElement).click()
    await flush()
    expect(m.q('.wd-replay-play')?.getAttribute('aria-pressed')).toBe('true')

    inCard(cards(m)[1], 'Resume').click()
    expect(s.resumed.map((r) => r.id)).toEqual(['b'])
    expect(m.q('.wd-replay-play')?.getAttribute('aria-pressed')).toBe('false')
    await flush()
    expect(inCard(cards(m)[1], 'Opening…').disabled).toBe(true)
    // One switch at a time.
    expect(inCard(cards(m)[0], 'Resume').disabled).toBe(true)
    expect(inCard(cards(m)[0], 'Delete').disabled).toBe(true)
  })

  test('a switch that fails says so, and the list can be used again', async () => {
    const s = source(listed([stored('a')]))
    s.state.failResume = true
    const m = mount(fake(), { sessions: s.src })
    m.button('Sessions').click()
    await flush()
    inCard(cards(m)[0], 'Resume').click()
    await flush()
    expect(m.q('.wd-replay-flash')?.textContent).toBe('Could not open that replay')
    expect(inCard(cards(m)[0], 'Resume').disabled).toBe(false)
  })

  test('while an advance shows its Stop, Resume is refused and says why', async () => {
    const s = source(listed([stored('a')]))
    const m = mount(fake(), { sessions: s.src })
    m.button('Sessions').click()
    await flush()
    m.controller.busy = true
    m.emit()
    inCard(cards(m)[0], 'Resume').click()
    await flush()
    expect(s.resumed).toEqual([])
    expect(m.q('.wd-replay-flash')?.textContent).toBe('Stop the advance first')
  })

  test('a step already landing (too quick to show) is waited for, then the switch goes ahead', async () => {
    const s = source(listed([stored('a')]))
    const m = mount(fake(), { sessions: s.src, busyRevealMs: 60_000 })
    m.button('Sessions').click()
    await flush()
    m.controller.busy = true
    inCard(cards(m)[0], 'Resume').click()
    await flush()
    expect(s.resumed).toEqual([])
    m.controller.busy = false
    m.emit()
    await flush()
    expect(s.resumed.map((r) => r.id)).toEqual(['a'])
  })

  test('Delete takes two presses here too, and the row goes', async () => {
    const s = source(listed([stored('a'), stored('b')]))
    const m = mount(fake(), { sessions: s.src })
    m.button('Sessions').click()
    await flush()
    inCard(cards(m)[0], 'Delete').click()
    expect(s.removed).toEqual([])
    inCard(cards(m)[0], 'Confirm delete').click()
    await flush()
    expect(s.removed).toEqual(['a'])
    expect(cards(m).map((c) => c.dataset.session)).toEqual(['b'])
  })
})

describe('quiet hours', () => {
  const stub = (on = false) => {
    const sets: import('./quiet').QuietSetting[] = []
    const holder = {
      value: { on, from: 22 * 60, to: 6 * 60, zone: 'replay' as const } as import('./quiet').QuietSetting,
      set(next: import('./quiet').QuietSetting) {
        sets.push(next)
        holder.value = next
      }
    }
    return { holder, sets }
  }

  test('the moon beside Next alert opens them, and reads the hours while they are on', () => {
    const { holder } = stub()
    const m = mount(fake(), { quiet: holder })
    const moon = () => m.q<HTMLButtonElement>('.wd-replay-quiet-toggle') as HTMLButtonElement
    expect(moon().closest('.wd-replay-next-row')).not.toBeNull()
    expect(moon().classList.contains('is-on')).toBe(false)
    moon().click()
    expect(m.q('.wd-replay-quiet')).not.toBeNull()
    holder.value = { ...holder.value, on: true }
    m.emit()
    expect(moon().classList.contains('is-on')).toBe(true)
    expect(moon().textContent).toBe('22:00–06:00')
    moon().click()
    expect(m.q('.wd-replay-quiet')).toBeNull()
  })

  test('the panel switches them on and sets the hours', () => {
    const { holder, sets } = stub()
    const m = mount(fake(), { quiet: holder })
    ;(m.q('.wd-replay-quiet-toggle') as HTMLButtonElement).click()
    check(m.q<HTMLInputElement>('.wd-replay-quiet-on input') as HTMLInputElement, true)
    expect(sets.at(-1)).toEqual({ on: true, from: 22 * 60, to: 6 * 60, zone: 'replay' })
    m.emit()
    const [from, to] = [...m.root.querySelectorAll<HTMLInputElement>('.wd-replay-quiet-time')]
    expect([from.value, to.value]).toEqual(['22:00', '06:00'])
    change(from, '21:30')
    expect(sets.at(-1)).toEqual({ on: true, from: 21 * 60 + 30, to: 6 * 60, zone: 'replay' })
    m.emit()
    change(m.root.querySelectorAll<HTMLInputElement>('.wd-replay-quiet-time')[1], '07:00')
    expect(sets.at(-1)).toEqual({ on: true, from: 21 * 60 + 30, to: 7 * 60, zone: 'replay' })
    // Next alert says it now runs past them.
    m.controller.alertCount = 1
    m.emit()
    expect(m.button('Next alert').title).toBe('Advance to where the next of 1 alert triggers, outside quiet hours (21:30–07:00) (Shift+↑)')
    // They silence the price watches and a trade's "Notify at" too, but never a fill.
    m.controller.armedStops = 1
    m.controller.workingStops = 1
    m.controller.pendingMilestones = 1
    m.emit()
    expect(m.button('Next alert').title).toBe(
      'Advance to where the next of 1 alert triggers, or a price watch fires, or a trade reaches a "Notify at", outside quiet hours (21:30–07:00), or an order, stop loss or take profit fills (Shift+↑)'
    )
  })

  test('without quiet hours wired there is no moon', () => {
    expect(mount().q('.wd-replay-quiet-toggle')).toBeNull()
  })
})
