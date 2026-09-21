import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { SignalCatalogueEntry } from '../plugins/types'
import type { AdvanceResult, ReplayController } from './session'

// THE REPLAY CONTROLS, rendered into a real DOM (happy-dom) and driven the way a user drives
// them: clicks, selects, typed values. The controller is a fake that records what it was asked
// to do, so these pin the controls' half of the contract -- what each button shows and when it
// is usable, which controller call each gesture makes, and what the status line says -- with
// no session, no chart and no network.
//
// The DOM is registered for this file only and removed after it, so every other suite keeps
// the bare environment it was written for.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { createReplayControls, openStartDialog } = await import('./controls')
const { SignalBook } = await import('./signals')
const { formatInstant } = await import('../trading/format')
const { validateBase, nominalMs } = await import('./timeframes')

const SYM = 'oanda:EURUSD'
const H = 3_600_000

const catalogue: SignalCatalogueEntry[] = [
  { plugin: 'arev', title: 'AREV', variant: 'arev21', available: true, id: 'long', label: 'Long', side: 'long', description: 'longs', ref: 'arev:arev21:long' },
  { plugin: 'krev', title: 'krev', variant: '', available: true, id: 'short', label: 'Short', side: 'short', description: '', ref: 'krev:short' },
  { plugin: 'mtf', title: 'MTF', variant: '', available: false, id: 'x', label: 'X', side: null, description: '', ref: 'mtf:x' }
] as SignalCatalogueEntry[]

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

interface Fake {
  controller: Mutable<ReplayController>
  calls: {
    step: number
    nextSignal: number
    cancel: number
    persist: number
    setAdvance: Array<{ interval: string; multiple: number }>
    setBase: string[]
    setPauseOnFill: boolean[]
  }
  /** What the controller's own change notification does: every listener re-renders. */
  emit(): void
  /** A walk's progress report: only `walkedTo` moved. */
  emitWalk(): void
  listeners: Set<(change?: 'walk') => void>
}

function result(over: Partial<AdvanceResult> = {}): AdvanceResult {
  return { from: 0, to: H, reason: 'target', signal: null, events: [], bars: [], walked: false, observed: [], ...over }
}

function fake(entries: SignalCatalogueEntry[] = catalogue): Fake {
  const listeners = new Set<(change?: 'walk') => void>()
  const calls: Fake['calls'] = { step: 0, nextSignal: 0, cancel: 0, persist: 0, setAdvance: [], setBase: [], setPauseOnFill: [] }
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
    lastStop: null,
    signals: new SignalBook(entries, { points: async () => [] }),
    armedStops: 0,
    storedIntervals: ['1m', '1h', '1D'],
    intervalsInUse: ['5m', '1h'],
    symbol: SYM,
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
    async nextSignal() {
      calls.nextSignal++
      return result({ reason: 'end' })
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
    }
  }
  return { controller, calls, emit, emitWalk, listeners }
}

interface Mounted extends Fake {
  root: HTMLElement
  stops: AdvanceResult[]
  exits: number
  account: { open: boolean; toggles: number }
  trade: { open: boolean; toggles: number }
  dispose(): void
  /** A button in the window by its visible label (badge excluded). */
  button(label: string): HTMLButtonElement
  maybeButton(label: string): HTMLButtonElement | null
  q<T extends Element = HTMLElement>(selector: string): T | null
}

let mounted: Mounted[] = []

function mount(f: Fake = fake(), opts: { account?: boolean } = {}): Mounted {
  const bounds = document.createElement('div')
  document.body.appendChild(bounds)
  const stops: AdvanceResult[] = []
  const state = { exits: 0 }
  const account = { open: false, toggles: 0 }
  const trade = { open: false, toggles: 0 }
  const controls = createReplayControls({
    controller: f.controller,
    intervalsInUse: () => [...f.controller.intervalsInUse],
    bounds,
    onExit: () => {
      state.exits++
    },
    onStop: (r) => stops.push(r),
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
    }
  })
  const root = controls.element
  const label = (b: Element): string => {
    const clone = b.cloneNode(true) as HTMLElement
    for (const badge of clone.querySelectorAll('.wd-replay-badge')) badge.remove()
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

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function change(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('change'))
}

function check(el: HTMLInputElement, on: boolean): void {
  el.checked = on
  el.dispatchEvent(new Event('change'))
}

describe('the title bar', () => {
  test('shows the cursor and a Step that advances by the current setting', async () => {
    const m = mount()
    const clock = m.q('.wd-replay-clock-value') as HTMLElement
    expect(clock.textContent).toBe(formatInstant(m.controller.cursor))
    expect(clock.title).toBe(new Date(m.controller.cursor).toISOString())

    const step = m.button('Step')
    expect(step.disabled).toBe(false)
    expect(step.title).toBe('Advance 1 × 5m')
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
    expect(stop.title).toBe('Stop at the next bar')
    // Leaving mid-advance is not offered.
    expect(m.button('Exit').disabled).toBe(true)

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
    expect(m.button('Exit').disabled).toBe(false)
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
    expect(clock().textContent).toBe(formatInstant(from))
    expect(clock().title).toBe(new Date(from).toISOString())
    expect(clock().textContent).not.toBe(formatInstant(walked))

    // Landed: the chart is at the cursor now, and so is the clock.
    m.controller.busy = false
    m.controller.cancelling = false
    m.controller.advanceFrom = null
    m.controller.walkedTo = null
    m.emit()
    expect(clock().textContent).toBe(formatInstant(walked))
  })

  test('Exit leaves', () => {
    const m = mount()
    m.button('Exit').click()
    expect(m.exits).toBe(1)
  })
})

describe('the advance row', () => {
  test('Next signal needs something to stop at: an armed signal or an armed watch', async () => {
    const m = mount()
    const next = (): HTMLButtonElement => m.button('Next signal')
    expect(next().disabled).toBe(true)
    expect(next().title).toBe('Arm a signal or place a price watch first')

    m.controller.armedStops = 1
    m.emit()
    expect(next().disabled).toBe(false)
    expect(next().title).toBe('Advance to the next armed signal or price watch')

    m.controller.armedStops = 0
    m.controller.signals.arm('arev:arev21:long', '1h')
    m.emit()
    expect(next().disabled).toBe(false)

    next().click()
    await flush()
    expect(m.calls.nextSignal).toBe(1)
    expect(m.stops.map((r) => r.reason)).toEqual(['end'])

    m.controller.busy = true
    m.emit()
    expect(next().disabled).toBe(true)
  })

  test('the timeframe picker offers the base, the stored ladder and the panes, shortest first', () => {
    const m = mount()
    const picker = m.q<HTMLSelectElement>('.wd-replay-row select') as HTMLSelectElement
    expect([...picker.options].map((o) => o.value)).toEqual(['1m', '5m', '1h', '1D'])
    expect(picker.value).toBe('5m')
    change(picker, '1h')
    expect(m.calls.setAdvance).toEqual([{ interval: '1h', multiple: 1 }])
  })

  test('the multiple is a whole number of at least one', () => {
    const m = mount()
    const cases: Array<[string, number]> = [
      ['12', 12],
      ['3.7', 3],
      ['0', 1],
      ['-4', 1],
      ['abc', 1]
    ]
    for (const [typed, expected] of cases) {
      // Every change re-renders the window, so the input is looked up fresh each time.
      change(m.q<HTMLInputElement>('.wd-replay-number') as HTMLInputElement, typed)
      expect(m.calls.setAdvance.at(-1)).toEqual({ interval: '5m', multiple: expected })
    }
  })

  test('busy, the picker and the multiple are disabled', () => {
    const m = mount()
    m.controller.busy = true
    m.emit()
    expect((m.q('.wd-replay-row select') as HTMLSelectElement).disabled).toBe(true)
    expect((m.q('.wd-replay-number') as HTMLInputElement).disabled).toBe(true)
  })
})

describe('the status line', () => {
  const reasons: Array<[string, Partial<AdvanceResult>, string]> = [
    ['a signal, named from the catalogue', { reason: 'signal', signal: { ref: 'arev:arev21:long', resolution: '1h', effective: 0, date: 0 } }, 'Stopped at AREV arev21 Long @1h'],
    ['a signal the catalogue no longer lists', { reason: 'signal', signal: { ref: 'gone:ref', resolution: '4h', effective: 0, date: 0 } }, 'Stopped at gone:ref @4h'],
    ['a fill pause', { reason: 'fill', events: [{ kind: 'fill' } as never] }, 'Paused on a fill'],
    ['a close pause', { reason: 'fill', events: [{ kind: 'close' } as never] }, 'Paused on a close'],
    ['a watch', { reason: 'watch', observed: [{ label: 'EURUSD 1.10000' }] }, 'Stopped at watch EURUSD 1.10000'],
    ['several watches on one bar', { reason: 'watch', observed: [{ label: 'EURUSD 1.10000' }, { label: 'b' }, { label: 'c' }] }, 'Stopped at watch EURUSD 1.10000 +2'],
    ['a cancel after walking', { reason: 'cancel', walked: true, bars: [{}, {}, {}] as never }, 'Stopped by you after 3 bars'],
    ['a cancel after one bar', { reason: 'cancel', walked: true, bars: [{}] as never }, 'Stopped by you after 1 bar'],
    ['a cancel before any bar', { reason: 'cancel', walked: false, bars: [] }, 'Stopped by you before the first bar'],
    ['the end of the data', { reason: 'end' }, 'End of data'],
    ['a walked target', { reason: 'target', walked: true, bars: [{}, {}] as never }, 'Advanced 2 bars'],
    ['a walked target of one bar', { reason: 'target', walked: true, bars: [{}] as never }, 'Advanced 1 bar'],
    ['a seek', { reason: 'target', walked: false }, 'Jumped — nothing working']
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
    expect((m.q('.wd-replay-stop-reason') as HTMLElement).textContent).toBe('Advanced 1 bar')

    // The first report: there is no line to patch yet, so the window renders it.
    const first = from + 26 * H
    m.controller.walkedTo = first
    m.emitWalk()
    const line = m.q('.wd-replay-walk') as HTMLElement
    expect(line.textContent).toBe(`Walking… reached ${formatInstant(first)}`)
    expect(line.title).toContain(new Date(first).toISOString())
    expect(line.title).toContain('The chart and the clock move when it stops')
    // The stale reason is gone, and the clock still reads the start.
    expect(m.q('.wd-replay-stop-reason')).toBeNull()
    expect((m.q('.wd-replay-clock-value') as HTMLElement).textContent).toBe(formatInstant(from))

    // Later reports patch the one line: the Stop button is the SAME element, so a press on it
    // is not released onto a replacement (which would be no click at all).
    const stop = m.button('Stop')
    const later = from + 9 * 24 * H
    m.controller.walkedTo = later
    m.emitWalk()
    expect(m.q('.wd-replay-walk')).toBe(line)
    expect(line.textContent).toBe(`Walking… reached ${formatInstant(later)}`)
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
      // The class is the reason itself: the stylesheet colours signal, fill and watch stops.
      expect(line.classList.contains(`is-${stop.reason}`)).toBe(true)
      expect(line.title).toBe(text)
    })
  }
})

describe('the panels', () => {
  test('one at a time: Signals, then Base replaces it, and a second press closes', () => {
    const m = mount()
    expect(m.q('.wd-replay-panel')).toBeNull()
    m.button('Signals').click()
    expect(m.q('.wd-replay-signal-list')).not.toBeNull()
    expect(m.button('Signals').getAttribute('aria-pressed')).toBe('true')

    m.button('Base 1m').click()
    expect(m.q('.wd-replay-signal-list')).toBeNull()
    expect(m.root.querySelectorAll('.wd-replay-panel').length).toBe(1)
    expect(m.button('Base 1m').classList.contains('is-on')).toBe(true)

    m.button('Base 1m').click()
    expect(m.q('.wd-replay-panel')).toBeNull()
  })

  test('an open panel survives a re-render from the controller', () => {
    const m = mount()
    m.button('Signals').click()
    m.emit()
    expect(m.q('.wd-replay-signal-list')).not.toBeNull()
  })

  test('Signals is disabled when nothing on the wall publishes one, and badges the armed count', () => {
    const none = mount(fake([]))
    expect(none.button('Signals').disabled).toBe(true)
    expect(none.button('Signals').title).toBe('No signal plugin publishes on this wall')

    const m = mount()
    expect(m.q('.wd-replay-badge')).toBeNull()
    m.controller.signals.arm('arev:arev21:long', '1h')
    m.controller.signals.arm('arev:arev21:long', '5m')
    m.emit()
    expect((m.q('.wd-replay-badge') as HTMLElement).textContent).toBe('2')
    // Only the AVAILABLE entries count as published.
    expect(m.button('Signals').title).toBe('2 available, 2 armed')
  })

  test('the signal list: available only, starred first; star and arm persist', () => {
    const m = mount()
    m.button('Signals').click()
    const names = (): string[] => [...m.root.querySelectorAll('.wd-replay-signal-name')].map((n) => n.textContent ?? '')
    expect(names()).toEqual(['AREV arev21 · Long', 'krev · Short'])
    expect(m.q('.wd-replay-arm')).toBeNull()

    // Star the second: it moves to the top and grows one arm button per pane interval.
    const stars = [...m.root.querySelectorAll('.wd-replay-star')] as HTMLButtonElement[]
    stars[1].click()
    expect(m.controller.signals.isStarred('krev:short')).toBe(true)
    expect(m.calls.persist).toBe(1)
    expect(names()).toEqual(['krev · Short', 'AREV arev21 · Long'])
    const arms = [...m.root.querySelectorAll('.wd-replay-arm')] as HTMLButtonElement[]
    expect(arms.map((a) => a.textContent)).toEqual(['5m', '1h'])
    expect(arms[1].title).toBe('Arm as a pause point on 1h')

    arms[1].click()
    expect(m.controller.signals.isArmed('krev:short', '1h')).toBe(true)
    expect(m.calls.persist).toBe(2)
    const armed = m.root.querySelectorAll('.wd-replay-arm')[1] as HTMLButtonElement
    expect(armed.classList.contains('is-on')).toBe(true)
    expect(armed.title).toBe('Armed on 1h: click to disarm')

    // Unstarring disarms it too (the book's rule), and persists.
    ;(m.root.querySelectorAll('.wd-replay-star')[0] as HTMLButtonElement).click()
    expect(m.controller.signals.isArmed('krev:short')).toBe(false)
    expect(m.calls.persist).toBe(3)
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

describe('lifetime', () => {
  test('refresh re-renders from the controller; dispose stops listening and removes the window', () => {
    const f = fake()
    const bounds = document.createElement('div')
    document.body.appendChild(bounds)
    const controls = createReplayControls({ controller: f.controller, intervalsInUse: () => ['5m'], bounds, onExit: () => {} })
    expect(f.listeners.size).toBe(1)
    f.controller.cursor += H
    controls.refresh()
    expect((controls.element.querySelector('.wd-replay-clock-value') as HTMLElement).textContent).toBe(formatInstant(f.controller.cursor))

    controls.dispose()
    expect(f.listeners.size).toBe(0)
    expect(document.body.contains(controls.element)).toBe(false)
  })
})

describe('the start dialog', () => {
  // A Monday evening in July (EDT, UTC-4) and one in January (EST, UTC-5).
  const JULY = Date.UTC(2024, 6, 15, 20, 0)
  const JANUARY = Date.UTC(2024, 0, 15, 21, 0)

  function open(latest = JULY, over: { intervalsInUse?: string[]; stored?: string[] } = {}) {
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    const starts: Array<{ startAt: number; balance: number; base: string }> = []
    const dialog = openStartDialog({
      anchor,
      symbol: SYM,
      intervalsInUse: over.intervalsInUse ?? ['5m', '1h'],
      stored: over.stored ?? ['1m', '1h', '1D'],
      latest,
      onStart: (choice) => starts.push(choice)
    })
    const root = document.querySelector('.wd-replay-dialog') as HTMLElement
    const inputs = (type: string): HTMLInputElement[] => [...root.querySelectorAll(`input[type="${type}"]`)] as HTMLInputElement[]
    const byText = (text: string): HTMLButtonElement => [...root.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement
    return {
      dialog,
      root,
      starts,
      start: inputs('datetime-local')[0],
      range: inputs('date'),
      rangeToggle: inputs('checkbox')[0],
      balance: root.querySelector('.wd-replay-number') as HTMLInputElement,
      base: root.querySelector('select') as HTMLSelectElement,
      error: (): string => [...root.querySelectorAll('.wd-replay-dialog-error')].map((e) => e.textContent).join(''),
      byText,
      isOpen: (): boolean => document.querySelector('.wd-replay-dialog') !== null
    }
  }

  test('says what it will replay, and defaults to a week before the newest bar, on the New York clock', () => {
    const d = open(JULY)
    expect((d.root.querySelector('.wd-replay-dialog-info') as HTMLElement).textContent).toBe('EURUSD · panes: 5m, 1h')
    // 15 Jul 20:00Z less seven days is 8 Jul 20:00Z, which is 16:00 in New York in summer...
    expect(d.start.value).toBe('2024-07-08T16:00')
    expect(d.start.max).toBe('2024-07-15T16:00')
    d.dialog.close()

    // ...and 16:00 again in winter, from an instant an hour later in UTC.
    const w = open(JANUARY)
    expect(w.start.value).toBe('2024-01-08T16:00')
  })

  test('Start hands over the instant, the balance and the base, and closes', () => {
    const d = open(JULY)
    // The suggested base is the finest stored interval dividing every pane, and says so.
    expect(d.base.value).toBe('1m')
    expect(d.base.options[0].textContent).toBe('1m (highest common denominator)')
    change(d.start, '2024-03-11T09:30')
    d.balance.value = '25000'
    d.byText('Start').click()
    // 09:30 New York on the first Monday after the spring change is 13:30Z (EDT).
    expect(d.starts).toEqual([{ startAt: Date.UTC(2024, 2, 11, 13, 30), balance: 25000, base: '1m' }])
    expect(d.isOpen()).toBe(false)
  })

  test('a start after the newest bar is pulled back to it', () => {
    const d = open(JULY)
    d.start.value = '2024-08-01T09:00'
    d.byText('Start').click()
    expect(d.starts[0].startAt).toBe(JULY)
  })

  test('a base that does not divide every pane disables Start and says why', () => {
    const d = open(JULY)
    change(d.base, '1h')
    expect(d.byText('Start').disabled).toBe(true)
    expect(d.error()).toContain('5m')
    change(d.base, '1m')
    expect(d.byText('Start').disabled).toBe(false)
    expect(d.error()).toBe('')
  })

  test('a missing date or a balance that is not positive is refused, and nothing starts', () => {
    const d = open(JULY)
    d.balance.value = '0'
    d.byText('Start').click()
    expect(d.error()).toBe('Balance must be positive')
    d.balance.value = '1000'
    d.start.value = ''
    d.byText('Start').click()
    expect(d.error()).toBe('Enter a start date and time')
    expect(d.starts).toEqual([])
    expect(d.isOpen()).toBe(true)
  })

  test('Random draws a candle open inside the chosen day range', () => {
    const d = open(JULY)
    const [from, to] = d.range
    const rangeBody = from.closest('.wd-replay-dialog-range') as HTMLElement
    expect(rangeBody.hidden).toBe(true)
    check(d.rangeToggle, true)
    expect(rangeBody.hidden).toBe(false)
    from.value = '2024-02-05'
    to.value = '2024-02-09'
    const lo = Date.UTC(2024, 1, 5, 5, 0) - nominalMs('1m')
    const hi = Date.UTC(2024, 1, 10, 4, 59)
    for (let i = 0; i < 25; i++) {
      d.byText('Random').click()
      const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(d.start.value)
      expect(m).not.toBeNull()
      // February is EST: New York wall time + 5h is UTC.
      const [y, mo, day, h, mi] = (m as RegExpExecArray).slice(1).map(Number)
      const at = Date.UTC(y, mo - 1, day, h + 5, mi)
      expect(at).toBeGreaterThanOrEqual(lo)
      expect(at).toBeLessThanOrEqual(hi)
    }
    expect(d.error()).toBe('')
  })

  test('Random refuses a range that ends before it starts, or is missing a day', () => {
    const d = open(JULY)
    check(d.rangeToggle, true)
    const before = d.start.value
    d.range[0].value = '2024-02-09'
    d.range[1].value = '2024-02-05'
    d.byText('Random').click()
    expect(d.error()).toBe('The range ends before it starts')
    d.range[1].value = ''
    d.byText('Random').click()
    expect(d.error()).toBe('Enter both range dates')
    expect(d.start.value).toBe(before)
  })

  test('Cancel, Escape and a click on the backdrop each close it without starting', () => {
    const a = open()
    a.byText('Cancel').click()
    expect(a.isOpen()).toBe(false)

    const b = open()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(b.isOpen()).toBe(false)

    const c = open()
    const backdrop = document.querySelector('.wd-replay-dialog-backdrop') as HTMLElement
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(c.isOpen()).toBe(false)

    // A click INSIDE the card is not a click on the backdrop.
    const d = open()
    d.root.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(d.isOpen()).toBe(true)
    expect([...a.starts, ...b.starts, ...c.starts, ...d.starts]).toEqual([])
  })
})
