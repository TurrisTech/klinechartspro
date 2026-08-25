import { describe, expect, test } from 'bun:test'
import { BarCache, type BarSource, type ReplayBar, composeForming, nonWeekendGaps } from './cache'
import { fromWall, intervalEnd, toWireDate } from './timeframes'

function ny(text: string): number {
  const [d, t] = text.split(' ')
  const [y, m, day] = d.split('-').map(Number)
  const [h, mi] = t.split(':').map(Number)
  return fromWall(Date.UTC(y, m - 1, day, h, mi), 'America/New_York')
}

const H = 3_600_000

/** A synthetic 1h series over the FX week: one bar per open hour from `start`. */
function series(interval: string, start: number, count: number): ReplayBar[] {
  const out: ReplayBar[] = []
  let open = start
  for (let i = 0; i < count; i++) {
    const end = intervalEnd(interval, open)
    const px = 1.1 + i * 0.001
    out.push({
      open,
      end,
      date: toWireDate(interval, open),
      o: px,
      h: px + 0.0005,
      l: px - 0.0005,
      c: px + 0.0002,
      v: 10,
      bid: { o: px - 0.0001, h: px + 0.0004, l: px - 0.0006, c: px + 0.0001 },
      ask: { o: px + 0.0001, h: px + 0.0006, l: px - 0.0004, c: px + 0.0003 }
    })
    // next open on the grid, skipping the weekend
    open = end
    while (out.length && !isOpenHour(open)) open += H
  }
  return out
}

function isOpenHour(ms: number): boolean {
  const d = new Date(ms)
  // crude: the synthetic series only spans weekdays in the tests below
  return d.getUTCDay() !== 0 || true
}

class RecordingSource implements BarSource {
  calls: Array<{ from: number; to: number }> = []
  constructor(private data: ReplayBar[]) {}
  async fetch(_s: string, _i: string, from: number, to: number): Promise<ReplayBar[]> {
    this.calls.push({ from, to })
    return this.data.filter((b) => b.open >= from && b.open < to)
  }
}

describe('BarCache', () => {
  const start = ny('2024-03-04 09:00')
  const data = series('1h', start, 100)

  test('walk: ensure then take consumes contiguously and never twice', async () => {
    const src = new RecordingSource(data)
    const cache = new BarCache(src, 'oanda:EURUSD', '1h')
    await cache.ensure(start + 3 * H, start)
    expect(cache.size).toBeGreaterThanOrEqual(3)
    const taken = cache.take(start + 2 * H)
    expect(taken.map((b) => b.open)).toEqual([start, start + H])
    expect(cache.take(start + 2 * H)).toEqual([])
    expect(cache.peek()?.open).toBe(start + 2 * H)
    // A bar still forming at `until` is not taken.
    expect(cache.take(start + 2 * H + 1).length).toBe(0)
    expect(cache.take(start + 3 * H).map((b) => b.open)).toEqual([start + 2 * H])
  })

  test('ensure prefetches ahead so a later step needs no fetch', async () => {
    const src = new RecordingSource(data)
    const cache = new BarCache(src, 'oanda:EURUSD', '1h')
    await cache.ensure(start + H, start)
    expect(src.calls.length).toBe(1)
    await cache.ensure(start + 10 * H)
    expect(src.calls.length).toBe(1)
    expect(cache.covers(start + 10 * H)).toBe(true)
  })

  test('ensure extends only from the run end; the run stays contiguous', async () => {
    const src = new RecordingSource(data)
    const cache = new BarCache(src, 'oanda:EURUSD', '1h')
    await cache.ensure(start + H, start)
    const reach = cache.reach as number
    await cache.ensure(reach + 5 * H)
    expect(src.calls[1].from).toBe(reach)
    const opens = cache.peekAll().map((b) => b.open)
    for (let i = 1; i < opens.length; i++) expect(opens[i]).toBeGreaterThan(opens[i - 1])
    expect(nonWeekendGaps('1h', cache.peekAll())).toEqual([])
  })

  test('seek dumps everything and reloads at the new anchor -- no bridging fetch', async () => {
    const src = new RecordingSource(data)
    const cache = new BarCache(src, 'oanda:EURUSD', '1h')
    await cache.ensure(start + H, start)
    const far = start + 60 * H
    cache.seek(far)
    expect(cache.size).toBe(0)
    expect(cache.anchoredAt).toBe(far)
    await cache.ensure(far + H)
    expect(src.calls[1].from).toBe(far)
    expect(cache.peek()?.open).toBeGreaterThanOrEqual(far)
    // Nothing between the old run and the new anchor was ever requested.
    expect(src.calls.some((c) => c.from < far && c.to > start + 30 * H && c.from > start)).toBe(false)
  })

  test('dump forgets the anchor; ensure without one is an error', async () => {
    const cache = new BarCache(new RecordingSource(data), 'oanda:EURUSD', '1h')
    cache.dump()
    await expect(cache.ensure(start + H)).rejects.toThrow('no anchor')
  })
})

describe('composeForming', () => {
  test('folds finer bars into the bucket with the wire date and both sides', () => {
    const start = ny('2024-03-04 09:00')
    const minutes = series('1m', start, 37)
    const bar = composeForming('1h', start, minutes)
    expect(bar).not.toBeNull()
    expect(bar?.open).toBe(start)
    expect(bar?.end).toBe(start + H)
    expect(bar?.date).toBe(start)
    expect(bar?.o).toBe(minutes[0].o)
    expect(bar?.c).toBe(minutes[36].c)
    expect(bar?.h).toBe(Math.max(...minutes.map((m) => m.h)))
    expect(bar?.v).toBe(370)
    expect(bar?.bid?.c).toBe(minutes[36].bid?.c)
    expect(bar?.ask?.h).toBe(Math.max(...minutes.map((m) => m.ask?.h as number)))
  })
  test('a daily bucket is wire-dated by its session', () => {
    const open = ny('2024-03-03 17:00')
    const hours = series('1h', open, 3)
    const bar = composeForming('1D', open, hours)
    expect(bar?.date).toBe(open + 7 * H)
    expect(bar?.end).toBe(ny('2024-03-04 17:00'))
  })
  test('nothing closed yet is null', () => {
    expect(composeForming('1h', 0, [])).toBeNull()
  })
})

describe('nonWeekendGaps', () => {
  test('the weekend is not a gap; a missing weekday hour is', () => {
    const fri = ny('2024-03-08 16:00')
    const bars: ReplayBar[] = [
      { open: fri, end: fri + H, date: fri, o: 1, h: 1, l: 1, c: 1, v: 1 },
      { open: ny('2024-03-10 17:00'), end: ny('2024-03-10 18:00'), date: ny('2024-03-10 17:00'), o: 1, h: 1, l: 1, c: 1, v: 1 },
      { open: ny('2024-03-10 19:00'), end: ny('2024-03-10 20:00'), date: ny('2024-03-10 19:00'), o: 1, h: 1, l: 1, c: 1, v: 1 }
    ]
    expect(nonWeekendGaps('1h', bars)).toEqual([{ after: ny('2024-03-10 17:00'), before: ny('2024-03-10 19:00') }])
  })
})
