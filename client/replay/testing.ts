import type { SimSnapshot } from '../trading/api'
import { Engine } from '../sim/engine'
import { serialize, stampSaved } from './persist'
import type { ListedSession } from './sessionlist'
import { summarizeSessions } from './sessions'

// Test doubles for the replay's two DOM suites -- the replay window's (controls.test.ts) and the
// start dialog's (startdialog.test.ts): past replays as `GET /sim/sessions` lists them, which the
// dialog's Sessions tab and the window's Sessions panel both show, and the gestures both suites
// drive the DOM with. Not shipped: nothing outside `*.test.ts` imports this. It reaches config.ts,
// which reads `window` at import, so a suite imports it once its DOM is registered.

// Tue 3 Jan 2023 17:00 New York, and 20 Jan 09:00.
const STARTED = Date.UTC(2023, 0, 3, 22, 0)
/** Where every stored replay's cursor stands. */
export const CURSOR = Date.UTC(2023, 0, 20, 14, 0)

/** A replay session as `GET /sim/sessions` lists it: its blob holds an engine that traded. */
export function stored(id: string, opts: { savedAt?: number; win?: boolean; trade?: boolean; ticker?: string } = {}): SimSnapshot {
  const symbol = `oanda:${opts.ticker ?? 'EURUSD'}`
  const engine = new Engine(10_000)
  if (opts.trade !== false) {
    engine.onQuote({ symbol, time: STARTED, bid: 1.1, ask: 1.1 })
    const { order } = engine.submit({ symbol, side: 'buy', type: 'market', units: 10_000 })
    const exit = opts.win === false ? 1.09 : 1.12
    engine.onQuote({ symbol, time: CURSOR, bid: exit, ask: exit })
    engine.closeTrade(order.tradeId as string)
  }
  const blob = serialize({ vendor: 'oanda', symbol, cursor: CURSOR, startedAt: STARTED, base: '1m', advance: { interval: '1h', multiple: 1 }, pauseOnFill: false, watches: [], engine: engine.toState() })
  return {
    id,
    mode: 'replay',
    name: 'Replay',
    createdAt: Date.UTC(2026, 10, 1),
    rev: 3,
    // The server's own copy of a replay's account never moves: its engine runs in the client.
    account: { currency: 'USD', initialBalance: 10_000, balance: 10_000, unrealizedPnl: 0, equity: 10_000 },
    quotes: {},
    orders: [],
    trades: [],
    symbols: [symbol],
    state: opts.savedAt === undefined ? blob : stampSaved(blob, opts.savedAt)
  }
}

export function listed(snapshots: SimSnapshot[]): ListedSession[] {
  return summarizeSessions(snapshots).map((summary) => ({ summary, zone: 'America/New_York' }))
}

export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export function change(el: HTMLInputElement | HTMLSelectElement, value: string): void {
  el.value = value
  el.dispatchEvent(new Event('change'))
}

export function check(el: HTMLInputElement, on: boolean): void {
  el.checked = on
  el.dispatchEvent(new Event('change'))
}
