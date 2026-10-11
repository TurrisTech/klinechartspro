import { describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'
import { installWindow } from '../plugins/testing'

// klinecharts recalculates both TradeTalk templates on every live tick. Each keeps its calendar
// map across ticks (templates.ts `calendar`), on the argument that a tick cannot change it; this
// holds that argument to a fresh pass after every tick and every new bar -- the streaming-equals-
// batch rule the indicators keep.

installWindow()
const { calc: entries } = await import('./templates')
const { calc: heath } = await import('./heathtemplate')
const { sessionsFromBars } = await import('./calendar')
const { storeFor, WindowStore } = await import('../plugins/store')

const H = 3_600_000
const DAY = 86_400_000
const CLOCK = { timezone: 'America/New_York', openOffset: -7, sessionDated: false }

/** EURUSD-like hourly bars over the FX week, a wave with enough swing to sweep levels. */
function hourly(count: number): KLineData[] {
  const out: KLineData[] = []
  let price = 1.1
  for (let t = Date.UTC(2026, 0, 4, 22); out.length < count; t += H) {
    const ny = new Date(t - 5 * H)
    const weekday = ny.getUTCDay()
    if (weekday === 6 || (weekday === 5 && ny.getUTCHours() >= 17) || (weekday === 0 && ny.getUTCHours() < 17)) continue
    const open = price
    price += Math.sin(out.length * 0.21) * 0.0011 + Math.cos(out.length * 0.047) * 0.0007
    out.push({ timestamp: t, open, high: Math.max(open, price) + 0.0004, low: Math.min(open, price) - 0.0004, close: price, volume: 1 })
  }
  return out
}

/** One pseudo-random number per call, the same sequence every run. */
function random(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31
    return s / 2 ** 31
  }
}

describe('TradeTalk across live ticks', () => {
  for (const [name, calc, params] of [
    ['TT:entries', entries, [2, 0, 0, 5, 0, 1, 1]],
    ['TT:heathlevels', heath, [5, 5, 0, 0, 0, 12, 1, 3, 50]]
  ] as const) {
    test(`${name}: every tick and every new bar gives what a fresh pass gives`, () => {
      const all = hourly(600)
      const data = all.slice(0, 400)
      // The daily feed: every session but the last few, which the chart's own bars supply.
      const sessions = sessionsFromBars(all, CLOCK)
      const key = `tt-ticks|${name}`
      const store = storeFor(key, (k) => new WindowStore(k))
      store.ingest(
        sessions.slice(0, 20).map((s) => ({ date: s.day * DAY + 5 * H, open: s.open, high: s.high, low: s.low, close: s.close })),
        { from: 0, to: Date.UTC(2030, 0, 1) }
      )
      const extendData = { seriesKey: key, rev: 1, clock: CLOCK, barMs: H, tick: 0.00001 }
      const live = { extendData, calcParams: [...params] }
      const next = random(7)
      let compared = 0
      for (let step = 0; step < 150; step++) {
        if (step % 15 === 14) {
          data.push({ ...all[data.length] })
        } else {
          // A tick: the forming bar's close moves, its high and low widen to it.
          const last = data[data.length - 1]
          const close = last.close + (next() - 0.5) * 0.002
          data[data.length - 1] = { ...last, close, high: Math.max(last.high, close), low: Math.min(last.low, close) }
        }
        const kept = calc(data, live as never)
        const fresh = calc(data.map((bar) => ({ ...bar })), { extendData: { ...extendData }, calcParams: [...params] } as never)
        expect(JSON.stringify(kept)).toBe(JSON.stringify(fresh))
        compared++
      }
      expect(compared).toBe(150)
      // The pass is not vacuous: there is a calendar map, and the entries rule found trades.
      const last = calc(data, live as never).at(-1) as { summary?: { entries: number }; levels?: unknown[]; heath?: unknown[] }
      expect((last.levels ?? last.heath ?? []).length).toBeGreaterThan(0)
      if (name === 'TT:entries') expect(last.summary?.entries ?? 0).toBeGreaterThan(0)
    }, 60_000)
  }
})
