import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// THE START DIALOG, rendered into a real DOM (happy-dom) and driven the way a user drives it:
// its New replay form (the default start on the instrument's clock, On chart, Random's range,
// Enter, its refusals), the past replays its Sessions tab lists, and the dialog a replay that
// cannot start opens. The replay window is controls.test.ts.
//
// The DOM is registered for this file only and removed after it, so every other suite keeps
// the bare environment it was written for.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { defaultStartAt, openStartDialog } = await import('./startdialog')
const { formatClock } = await import('../time/format')
const { FX_GRID, CONTINUOUS_DAY, gridOf } = await import('../time/timeframes')
const { setFocusSource } = await import('../chrome/focus')
const { nominalMs } = await import('../time/intervals')
const { CURSOR, change, check, flush, listed, stored } = await import('./testing')

const SYM = 'oanda:EURUSD'
const NY_TZ = 'America/New_York'

type Listed = import('./sessionlist').ListedSession
type Summary = import('./sessions').ReplaySessionSummary

afterEach(() => {
  document.body.innerHTML = ''
  window.localStorage.clear()
})

describe('the start dialog', () => {
  // A Monday evening in July (EDT, UTC-4) and one in January (EST, UTC-5).
  const JULY = Date.UTC(2024, 6, 15, 20, 0)
  const JANUARY = Date.UTC(2024, 0, 15, 21, 0)

  function open(
    latest = JULY,
    over: { intervalsInUse?: string[]; stored?: string[]; pickOnChart?: (done: (startAt: number | null) => void) => void; grid?: ReturnType<typeof gridOf> } = {}
  ) {
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    const starts: Array<{ startAt: number; balance: number; base: string }> = []
    const dialog = openStartDialog({
      anchor,
      symbol: SYM,
      intervalsInUse: over.intervalsInUse ?? ['5m', '1h'],
      stored: over.stored ?? ['1m', '1h', '1D'],
      latest,
      grid: over.grid ?? FX_GRID,
      pickOnChart: over.pickOnChart,
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

  test('a week before a weekend is a weekend: the default backs off to the last candle that traded', () => {
    // Saturday 20 Jul 2024, 14:00 New York: a week earlier is Saturday the 13th, market closed.
    const saturday = Date.UTC(2024, 6, 20, 18, 0)
    const d = open(saturday)
    expect(d.start.value).toBe('2024-07-12T16:00')
    // On whatever base the dialog suggests (here 1h, for 1h + 4h panes)...
    for (const base of ['1m', '1h', '4h']) expect(formatClock(defaultStartAt(base, saturday, FX_GRID), NY_TZ).startsWith('Fri, Jul 12')).toBe(true)
    // ...and the daily base's own session floor already lands on a trading day.
    expect(formatClock(defaultStartAt('1D', saturday, FX_GRID), NY_TZ)).toBe('Thu, Jul 11, 17:00:00')
  })

  test('a coinbase replay is chosen on its own clock: UTC, named so, and its weekend is a market', () => {
    const crypto = gridOf({ timezone: 'UTC', day: CONTINUOUS_DAY })
    // Saturday 20 Jul 2024 18:00 UTC. A week earlier is Saturday the 13th -- closed for forex,
    // an ordinary trading day for crypto, so the default stays there rather than backing off.
    const saturday = Date.UTC(2024, 6, 20, 18, 0)
    const d = open(saturday, { grid: crypto })
    expect((d.root.querySelector('.wd-replay-field .wd-replay-label') as HTMLElement).textContent).toBe('Start (UTC)')
    expect(d.start.value).toBe('2024-07-13T18:00')
    // A typed date is read in UTC too.
    change(d.start, '2024-03-09T12:00')
    d.byText('Start').click()
    expect(d.starts[0].startAt).toBe(Date.UTC(2024, 2, 9, 12, 0))
  })

  test('On chart steps aside for a pick on the chart and takes the bar it gets back', () => {
    let finish: (startAt: number | null) => void = () => {}
    const d = open(JULY, { pickOnChart: (done) => (finish = done) })
    const backdrop = document.querySelector('.wd-replay-dialog-backdrop') as HTMLElement
    d.byText('On chart').click()
    expect(backdrop.hidden).toBe(true)
    // Escape belongs to the pick while it runs: the dialog must still be there afterwards.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(d.isOpen()).toBe(true)
    finish(Date.UTC(2024, 2, 11, 14, 0))
    expect(backdrop.hidden).toBe(false)
    expect(d.start.value).toBe('2024-03-11T10:00')

    // A cancelled pick leaves the start as it was.
    d.byText('On chart').click()
    finish(null)
    expect(backdrop.hidden).toBe(false)
    expect(d.start.value).toBe('2024-03-11T10:00')
  })

  test('is centred on the app, not over the active pane, however wide the page', () => {
    // A three-monitor window, with the pane last touched on the left-hand display: the rule that
    // moves a body-level card over that pane (chrome/focus.ts) must not move this one -- a replay
    // is the whole wall's mode.
    const width = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    Object.defineProperty(window, 'innerWidth', { value: 5760, configurable: true })
    setFocusSource(() => new DOMRect(0, 0, 1920, 1080))
    try {
      const d = open(JULY)
      const backdrop = document.querySelector('.wd-replay-dialog-backdrop') as HTMLElement
      expect(backdrop.style.justifyContent).toBe('')
      expect(d.root.style.marginLeft).toBe('')
    } finally {
      setFocusSource(null)
      if (width) Object.defineProperty(window, 'innerWidth', width)
      else delete (window as { innerWidth?: number }).innerWidth
    }
  })

  test('without a chart to pick on there is no On chart button', () => {
    const d = open(JULY)
    expect(d.byText('On chart')).toBeUndefined()
  })

  test('Enter starts from a field, but a focused button answers Enter itself', () => {
    const d = open(JULY)
    d.start.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(d.starts.length).toBe(1)
    expect(d.isOpen()).toBe(false)

    const e = open(JULY)
    e.byText('Cancel').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    expect(e.starts.length).toBe(0)
  })

  test('Start hands over the instant, the balance and the base, and closes', () => {
    const d = open(JULY)
    // The suggested base is the finest stored interval dividing every pane, and says so.
    expect(d.base.value).toBe('1m')
    expect(d.base.options[0].textContent).toBe('1m (recommended)')
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

  test('drags by its title, stays in the window, and a drag released over the backdrop does not close it', () => {
    const d = open(JULY)
    const title = d.root.querySelector('.wd-replay-dialog-title') as HTMLElement
    const backdrop = document.querySelector('.wd-replay-dialog-backdrop') as HTMLElement
    // happy-dom lays nothing out: the card's rect is all zeros, so the grab offset is the press.
    title.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100, pointerId: 1 }))
    expect(d.root.style.position).toBe('fixed')
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300, clientY: 250, pointerId: 1 }))
    expect([d.root.style.left, d.root.style.top]).toEqual(['200px', '150px'])
    // Never off the page: pulled back to the edge margin.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: -500, clientY: -500, pointerId: 1 }))
    expect([d.root.style.left, d.root.style.top]).toEqual(['8px', '8px'])
    // Released over the backdrop: the browser's click lands on the common ancestor, the backdrop.
    window.dispatchEvent(new PointerEvent('pointerup', { clientX: -500, clientY: -500, pointerId: 1 }))
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(d.isOpen()).toBe(true)
    // Released: a later move goes nowhere.
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400, clientY: 400, pointerId: 1 }))
    expect(d.root.style.left).toBe('8px')
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
    backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(c.isOpen()).toBe(false)

    // A click INSIDE the card is not a click on the backdrop.
    const d = open()
    d.root.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(d.isOpen()).toBe(true)
    expect([...a.starts, ...b.starts, ...c.starts, ...d.starts]).toEqual([])
  })
})

describe('the start dialog: past sessions', () => {
  const JULY = Date.UTC(2024, 6, 15, 20, 0)

  function open(rows: Listed[] | Promise<Listed[]>) {
    const resumed: Summary[] = []
    const removed: string[] = []
    let failRemove = false
    const starts: unknown[] = []
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    const dialog = openStartDialog({
      anchor,
      symbol: SYM,
      intervalsInUse: ['5m', '1h'],
      stored: ['1m', '1h', '1D'],
      latest: JULY,
      grid: FX_GRID,
      onStart: (choice) => starts.push(choice),
      sessions: {
        load: () => Promise.resolve(rows),
        resume: (s) => {
          resumed.push(s)
        },
        remove: async (id) => {
          if (failRemove) throw new Error('nope')
          removed.push(id)
        }
      }
    })
    const root = document.querySelector('.wd-replay-dialog') as HTMLElement
    const buttons = (): HTMLButtonElement[] => [...root.querySelectorAll('button')] as HTMLButtonElement[]
    const tab = (name: string): HTMLButtonElement => buttons().find((b) => b.getAttribute('role') === 'tab' && (b.textContent ?? '').startsWith(name)) as HTMLButtonElement
    const cards = (): HTMLElement[] => [...root.querySelectorAll('.wd-replay-session')] as HTMLElement[]
    const inCard = (card: HTMLElement, text: string): HTMLButtonElement => [...card.querySelectorAll('button')].find((b) => b.textContent === text) as HTMLButtonElement
    const panes = (): HTMLElement[] => [...root.querySelectorAll('.wd-replay-dialog-pane')] as HTMLElement[]
    return {
      dialog,
      root,
      starts,
      resumed,
      removed,
      failNextRemove: () => {
        failRemove = true
      },
      tab,
      cards,
      inCard,
      newPane: () => panes()[0],
      sessionsPane: () => panes()[1],
      isOpen: (): boolean => document.querySelector('.wd-replay-dialog') !== null
    }
  }

  test('opens on New replay; the Sessions tab counts the replays once they load', async () => {
    const d = open(listed([stored('a'), stored('b')]))
    expect((d.root.querySelector('.wd-replay-dialog-title') as HTMLElement).textContent).toBe('Bar replay')
    expect(d.newPane().hidden).toBe(false)
    expect(d.sessionsPane().hidden).toBe(true)
    expect(d.tab('Sessions').textContent).toBe('Sessions')
    await flush()
    expect(d.tab('Sessions').textContent).toBe('Sessions2')
    d.tab('Sessions').click()
    expect(d.newPane().hidden).toBe(true)
    expect(d.sessionsPane().hidden).toBe(false)
    expect(d.cards().length).toBe(2)
  })

  test('a row says what it replayed, how far, its score, and scores the BLOB, not the server account', async () => {
    const d = open(listed([stored('a', { savedAt: Date.UTC(2026, 10, 14, 15, 22) })]))
    await flush()
    d.tab('Sessions').click()
    const card = d.cards()[0]
    expect((card.querySelector('.wd-replay-session-ticker') as HTMLElement).textContent).toBe('EURUSD')
    expect((card.querySelector('.wd-replay-session-base') as HTMLElement).textContent).toBe('1m base')
    // 10,000 units bought at 1.10 and sold at 1.12: +200 on a 10,000 account. The server's copy
    // of the account says 10,000 flat; the row must not believe it.
    const net = card.querySelector('.wd-replay-session-net') as HTMLElement
    expect(net.textContent).toBe('+200.00 USD · +2.00%')
    expect(net.classList.contains('is-up')).toBe(true)
    expect((card.querySelector('.wd-replay-session-span') as HTMLElement).textContent).toBe('Tue, Jan 03, 2023, 17:00:00 → Fri, Jan 20, 09:00:00')
    const facts = (card.querySelector('.wd-replay-session-facts') as HTMLElement).textContent ?? ''
    expect(facts.startsWith('1 closed · 100% win · replayed 16d 16h · played ')).toBe(true)
  })

  test('Stats opens the Results figures for that session, and closes them again', async () => {
    const d = open(listed([stored('a'), stored('b', { win: false })]))
    await flush()
    d.tab('Sessions').click()
    expect(d.root.querySelector('.wd-tk-figs')).toBeNull()
    d.inCard(d.cards()[0], 'Stats').click()
    const figs = d.cards()[0].querySelector('.wd-tk-figs') as HTMLElement
    const read = (label: string): string | null =>
      [...figs.querySelectorAll('.wd-tk-fig')].find((f) => f.querySelector('dt')?.textContent === label)?.querySelector('dd')?.textContent ?? null
    expect(read('Closed')).toBe('1')
    expect(read('Win rate')).toBe('100% · 1W 0L')
    expect(read('Best')).toBe('+200.00')
    // Only the row asked about.
    expect(d.cards()[1].querySelector('.wd-tk-figs')).toBeNull()
    d.inCard(d.cards()[0], 'Hide stats').click()
    expect(d.root.querySelector('.wd-tk-figs')).toBeNull()
  })

  test('a session with no trades has no Stats to open', async () => {
    const d = open(listed([stored('a', { trade: false })]))
    await flush()
    d.tab('Sessions').click()
    const card = d.cards()[0]
    expect(d.inCard(card, 'Stats')).toBeUndefined()
    // No "0.00 USD · 0.00%" on a replay that never traded.
    expect(card.querySelector('.wd-replay-session-net')).toBeNull()
    expect((card.querySelector('.wd-replay-session-facts') as HTMLElement).textContent?.startsWith('No trades · replayed 16d 16h')).toBe(true)
  })

  test('Delete takes two presses, then the row and the count go', async () => {
    const d = open(listed([stored('a'), stored('b')]))
    await flush()
    d.tab('Sessions').click()
    d.inCard(d.cards()[0], 'Delete').click()
    expect(d.removed).toEqual([])
    const armed = d.inCard(d.cards()[0], 'Confirm delete')
    expect(armed.classList.contains('is-armed')).toBe(true)
    expect(armed.title).toContain('gone for good')
    armed.click()
    await flush()
    expect(d.removed).toEqual(['a'])
    expect(d.cards().map((c) => c.dataset.session)).toEqual(['b'])
    expect(d.tab('Sessions').textContent).toBe('Sessions1')
    // Still in the dialog, on the list: deleting is housekeeping, not leaving.
    expect(d.isOpen()).toBe(true)
  })

  test('a delete the server refuses keeps the row and says so', async () => {
    const d = open(listed([stored('a')]))
    await flush()
    d.tab('Sessions').click()
    d.failNextRemove()
    d.inCard(d.cards()[0], 'Delete').click()
    d.inCard(d.cards()[0], 'Confirm delete').click()
    await flush()
    expect(d.cards().length).toBe(1)
    expect(d.inCard(d.cards()[0], 'Delete').disabled).toBe(false)
    expect((d.root.querySelector('.wd-replay-flash') as HTMLElement).textContent).toBe('Could not delete that replay')
  })

  test('Resume closes the dialog and hands the session over; nothing is started', async () => {
    const d = open(listed([stored('a'), stored('b')]))
    await flush()
    d.tab('Sessions').click()
    d.inCard(d.cards()[1], 'Resume').click()
    expect(d.isOpen()).toBe(false)
    expect(d.resumed.map((s) => s.id)).toEqual(['b'])
    expect(d.resumed[0].state?.cursor).toBe(CURSOR)
    expect(d.starts).toEqual([])
  })

  test('a blob this client cannot read is listed to delete, not to resume', async () => {
    const unreadable = { ...stored('old'), state: { version: 0 } }
    const d = open(listed([unreadable]))
    await flush()
    d.tab('Sessions').click()
    const card = d.cards()[0]
    expect(d.inCard(card, 'Resume').disabled).toBe(true)
    expect(d.inCard(card, 'Delete').disabled).toBe(false)
    expect(card.querySelector('.wd-replay-session-net')).toBeNull()
    expect((card.querySelector('.wd-replay-session-facts') as HTMLElement).textContent).toContain('can be deleted, not resumed')
  })

  test('the tab is remembered, and a remembered Sessions tab with nothing in it opens on New', async () => {
    const a = open(listed([stored('a')]))
    await flush()
    a.tab('Sessions').click()
    a.dialog.close()

    const b = open(listed([stored('a')]))
    expect(b.sessionsPane().hidden).toBe(false)
    await flush()
    expect(b.cards().length).toBe(1)
    b.dialog.close()

    const c = open(listed([]))
    await flush()
    expect(c.newPane().hidden).toBe(false)
    c.tab('Sessions').click()
    expect((c.sessionsPane().textContent ?? '').startsWith('No past replays')).toBe(true)
  })

  test('Enter does not start a replay from the Sessions tab', async () => {
    const d = open(listed([stored('a')]))
    await flush()
    d.tab('Sessions').click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(d.starts).toEqual([])
    expect(d.isOpen()).toBe(true)
    d.tab('New replay').click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(d.starts.length).toBe(1)
  })

  test('a list that will not load says so; New still works', async () => {
    const d = open(Promise.reject(new Error('down')))
    await flush()
    d.tab('Sessions').click()
    expect(d.sessionsPane().textContent).toBe('Could not load your replays.')
    d.tab('New replay').click()
    expect(d.newPane().hidden).toBe(false)
  })
})

// The active pane's instrument cannot start a replay (no market hours, nothing stored): the dialog
// opens anyway, so every other replay stays one press away rather than out of reach until the
// pane is moved, and its New replay tab says why in place of a form that could only fail.
describe('the start dialog: a new replay refused', () => {
  function openRefused(rows: Listed[]) {
    const resumed: Summary[] = []
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    const dialog = openStartDialog({
      anchor,
      symbol: 'oanda:GBPUSD',
      intervalsInUse: ['1h'],
      refusal: 'No market hours for GBPUSD',
      sessions: {
        load: () => Promise.resolve(rows),
        resume: (s) => {
          resumed.push(s)
        },
        remove: async () => {}
      }
    })
    const root = document.querySelector('.wd-replay-dialog') as HTMLElement
    const panes = (): HTMLElement[] => [...root.querySelectorAll('.wd-replay-dialog-pane')] as HTMLElement[]
    const tab = (name: string): HTMLButtonElement =>
      [...root.querySelectorAll('button')].find((b) => b.getAttribute('role') === 'tab' && (b.textContent ?? '').startsWith(name)) as HTMLButtonElement
    return {
      dialog,
      resumed,
      tab,
      newPane: () => panes()[0],
      sessionsPane: () => panes()[1],
      cards: (): HTMLElement[] => [...root.querySelectorAll('.wd-replay-session')] as HTMLElement[],
      isOpen: (): boolean => document.querySelector('.wd-replay-dialog') !== null
    }
  }

  test('it opens on Sessions; New replay says why, with no form and nothing to start', async () => {
    const d = openRefused(listed([stored('a')]))
    expect(d.sessionsPane().hidden).toBe(false)
    expect(d.newPane().hidden).toBe(true)
    await flush()
    expect(d.cards().length).toBe(1)
    d.tab('New replay').click()
    expect(d.newPane().hidden).toBe(false)
    expect((d.newPane().querySelector('.wd-replay-dialog-error') as HTMLElement).textContent).toBe('No market hours for GBPUSD')
    expect(d.newPane().textContent).toContain('resume a past replay from Sessions')
    expect(d.newPane().querySelector('input, select')).toBeNull()
    expect([...d.newPane().querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Close'])
    // Enter has no Start to press.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(d.isOpen()).toBe(true)
    ;(d.newPane().querySelector('button') as HTMLButtonElement).click()
    expect(d.isOpen()).toBe(false)
  })

  test('another replay resumes from it', async () => {
    const d = openRefused(listed([stored('a'), stored('b', { ticker: 'EURUSD' })]))
    await flush()
    ;([...d.cards()[1].querySelectorAll('button')].find((b) => b.textContent === 'Resume') as HTMLButtonElement).click()
    expect(d.isOpen()).toBe(false)
    expect(d.resumed.map((s) => s.id)).toEqual(['b'])
  })

  test('with no past replays it shows New replay, which says why', async () => {
    const d = openRefused(listed([]))
    await flush()
    expect(d.newPane().hidden).toBe(false)
    expect(d.newPane().textContent).toContain('No market hours for GBPUSD')
  })

  test('opening on Sessions is not remembered: the next dialog opens on the tab last chosen', async () => {
    const d = openRefused(listed([stored('a')]))
    await flush()
    d.dialog.close()
    expect(window.localStorage.getItem('wd.replay.dialogTab')).toBeNull()
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    openStartDialog({
      anchor,
      symbol: SYM,
      intervalsInUse: ['5m', '1h'],
      stored: ['1m', '1h', '1D'],
      latest: Date.UTC(2024, 6, 15, 20, 0),
      grid: FX_GRID,
      onStart: () => {},
      sessions: { load: () => Promise.resolve(listed([stored('a')])), resume: () => {}, remove: async () => {} }
    })
    const panes = [...document.querySelectorAll('.wd-replay-dialog-pane')] as HTMLElement[]
    expect(panes[0].hidden).toBe(false)
    expect(panes[1].hidden).toBe(true)
  })
})

describe('the session list keeps its place', () => {
  test('in the start dialog, Stats far down the list does not rebuild the box the rows scroll in', async () => {
    const anchor = document.createElement('div')
    document.body.appendChild(anchor)
    openStartDialog({
      anchor,
      symbol: SYM,
      intervalsInUse: ['5m', '1h'],
      stored: ['1m', '1h', '1D'],
      latest: Date.UTC(2024, 6, 15, 20, 0),
      grid: FX_GRID,
      onStart: () => {},
      sessions: { load: () => Promise.resolve(listed([stored('a'), stored('b'), stored('c')])), resume: () => {}, remove: async () => {} }
    })
    await flush()
    const root = document.querySelector('.wd-replay-dialog') as HTMLElement
    const list = root.querySelector('.wd-replay-session-list')
    const last = [...root.querySelectorAll('.wd-replay-session')][2] as HTMLElement
    ;([...last.querySelectorAll('button')].find((b) => b.textContent === 'Stats') as HTMLButtonElement).click()
    expect(root.querySelector('.wd-replay-session-list')).toBe(list)
    expect(root.querySelectorAll('.wd-tk-figs').length).toBe(1)
  })
})
