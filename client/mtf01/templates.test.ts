import { expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()

const { getIndicatorClass } = await import('klinecharts')
const { registerMtf01Indicators } = await import('./templates')
const { Mtf01Store } = await import('./store')
const { storeFor } = await import('../plugins/store')
const { FX_GRID, fromWall } = await import('../time/timeframes')
type Event = import('./api').Mtf01Event
type Trade = import('./api').Mtf01Trade

// The step line on an FX 1D pane. A row's `date` is a pane bar on the wire clock (00:00 New York
// of the session date), but a context's end is an instant the server never shifts. Each FX day
// opens at 17:00 the evening before its date, so an end at 21:00 Wednesday falls inside
// THURSDAY's bar, which holds the rung.

registerMtf01Indicators()
const template = new (getIndicatorClass('MTF01:mtf01') as new () => { calc: (d: unknown[], i: unknown) => { stage?: number }[] })()
const ny = (day: number, hour = 0) => fromWall(Date.UTC(2026, 9, day, hour), 'America/New_York')
// Mon 5 .. Fri 9 October 2026, on the wire clock.
const wire = [5, 6, 7, 8, 9].map((day) => ny(day))
const bars = wire.map((timestamp) => ({ timestamp, open: 1, high: 1, low: 1, close: 1 }))

function stages(key: string, events: Event[], trades: Trade[], extend: Record<string, unknown>): (number | undefined)[] {
  const store = storeFor(key, (k) => new Mtf01Store(k)) as InstanceType<typeof Mtf01Store>
  store.ingest(events, { from: wire[0], to: wire[4] + 1 }, { trades })
  return template.calc(bars, { calcParams: [], extendData: { seriesKey: key, rev: store.rev, ...extend } }).map((v) => v.stage)
}

const armed = (endedAt: number): Event => ({
  date: wire[0],
  stage: 'htf',
  interval: '8h',
  barDate: 0,
  effective: wire[0],
  p: 0.3,
  n: 200,
  bodyLow: 1,
  accepted: true,
  reason: null,
  expiresAt: null,
  endedAt,
  endReason: 'spent'
})

test('a context that ends in the evening holds its rung through the bar open then', () => {
  const extend = { chartInterval: '1D', schedule: FX_GRID.schedule }
  // Wed 21:00 is inside Thursday's bar (opened Wed 17:00).
  expect(stages('mtf01|test|evening', [armed(ny(7, 21))], [], extend)).toEqual([1, 1, 1, 1, 0])
  // Wed 12:00 is inside Wednesday's.
  expect(stages('mtf01|test|midday', [armed(ny(7, 12))], [], extend)).toEqual([1, 1, 1, 0, 0])
})

test("a trade holds the top rung until the bar open when it resolved", () => {
  const trade = { date: wire[1], triggeredAt: wire[1], resolvedAt: ny(8, 18), outcome: 'stop' } as Trade
  // Thu 18:00 is inside Friday's bar.
  expect(stages('mtf01|test|trade', [], [trade], { chartInterval: '1D', schedule: FX_GRID.schedule })).toEqual([0, 3, 3, 3, 3])
})
