import { describe, expect, test } from 'bun:test'
import { BarCache, type BarSource, PREFETCH_BARS, type ReplayBar, composeForming, composeLadder, composeSpans, nonWeekendGaps } from './cache'
import { FX_GRID, fromWall, intervalEnd, toWireDate } from './timeframes'

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
    const cache = new BarCache(src, 'oanda:EURUSD', '1h', FX_GRID)
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
    const cache = new BarCache(src, 'oanda:EURUSD', '1h', FX_GRID)
    await cache.ensure(start + H, start)
    expect(src.calls.length).toBe(1)
    await cache.ensure(start + 10 * H)
    expect(src.calls.length).toBe(1)
    expect(cache.covers(start + 10 * H)).toBe(true)
  })

  test('ensure extends only from the run end; the run stays contiguous', async () => {
    const src = new RecordingSource(data)
    const cache = new BarCache(src, 'oanda:EURUSD', '1h', FX_GRID)
    await cache.ensure(start + H, start)
    const reach = cache.reach as number
    await cache.ensure(reach + 5 * H)
    expect(src.calls[1].from).toBe(reach)
    const opens = cache.peekAll().map((b) => b.open)
    for (let i = 1; i < opens.length; i++) expect(opens[i]).toBeGreaterThan(opens[i - 1])
    expect(nonWeekendGaps('1h', cache.peekAll(), FX_GRID)).toEqual([])
  })

  test('seek dumps everything and reloads at the new anchor -- no bridging fetch', async () => {
    const src = new RecordingSource(data)
    const cache = new BarCache(src, 'oanda:EURUSD', '1h', FX_GRID)
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

  test('cover past the end of the run is a seek: the gap is never read', async () => {
    // Longer than the prefetch margin, so there is something past the run's end to land on.
    const src = new RecordingSource(series('1h', start, 2 * PREFETCH_BARS))
    const cache = new BarCache(src, 'oanda:EURUSD', '1h', FX_GRID)
    await cache.cover(start, start + 2 * H)
    const reach = cache.reach as number
    const far = reach + 10 * H
    await cache.cover(far, far + 2 * H)
    expect(src.calls.length).toBe(2)
    expect(src.calls[1].from).toBe(far)
    expect(cache.anchoredAt).toBe(far)
    expect(cache.slice(far, far + 2 * H).map((b) => b.open)).toEqual([far, far + H])
  })

  test('cover inside the run reads nothing; cover from its end extends it', async () => {
    const src = new RecordingSource(data)
    const cache = new BarCache(src, 'oanda:EURUSD', '1h', FX_GRID)
    await cache.cover(start, start + 2 * H)
    await cache.cover(start + H, start + 3 * H)
    expect(src.calls.length).toBe(1)
    const reach = cache.reach as number
    await cache.cover(reach, reach + H)
    expect(src.calls.length).toBe(2)
    expect(src.calls[1].from).toBe(reach)
    expect(cache.anchoredAt).toBe(start)
  })

  test('dump forgets the anchor; ensure without one is an error', async () => {
    const cache = new BarCache(new RecordingSource(data), 'oanda:EURUSD', '1h', FX_GRID)
    cache.dump()
    await expect(cache.ensure(start + H)).rejects.toThrow('no anchor')
  })
})

describe('composeForming', () => {
  test('folds finer bars into the bucket with the wire date and both sides', () => {
    const start = ny('2024-03-04 09:00')
    const minutes = series('1m', start, 37)
    const bar = composeForming('1h', start, minutes, FX_GRID)
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
    const bar = composeForming('1D', open, hours, FX_GRID)
    expect(bar?.date).toBe(open + 7 * H)
    expect(bar?.end).toBe(ny('2024-03-04 17:00'))
  })
  test('nothing closed yet is null', () => {
    expect(composeForming('1h', 0, [], FX_GRID)).toBeNull()
  })
})

describe('composeLadder', () => {
  const stored = ['5s', '1m', '1h', '1D']
  test('every stored interval between the base and the pane, coarsest first, then the base', () => {
    expect(composeLadder('1D', '5s', stored)).toEqual(['1h', '1m', '5s'])
    expect(composeLadder('1h', '5s', stored)).toEqual(['1m', '5s'])
    expect(composeLadder('4h', '5s', stored)).toEqual(['1h', '1m', '5s'])
    expect(composeLadder('5m', '5s', stored)).toEqual(['1m', '5s'])
    expect(composeLadder('1W', '5s', stored)).toEqual(['1D', '1h', '1m', '5s'])
    expect(composeLadder('1D', '1m', ['1m', '1h', '1D'])).toEqual(['1h', '1m'])
  })
  test('nothing between them, or nothing stored known: the base alone', () => {
    expect(composeLadder('1m', '5s', stored)).toEqual(['5s'])
    expect(composeLadder('1h', '1h', stored)).toEqual(['1h'])
    expect(composeLadder('1D', '5s', [])).toEqual(['5s'])
  })
  test('an interval that does not tile the pane, or is not tiled by the base, is left out', () => {
    // 1h does not tile a 90m candle; 15m does.
    expect(composeLadder('90m', '5s', ['5s', '1m', '15m', '1h'])).toEqual(['15m', '1m', '5s'])
    // A 2m base does not tile 5m: nothing between 2m and 1h is used but what 2m tiles.
    expect(composeLadder('1h', '2m', ['2m', '5m', '10m'])).toEqual(['10m', '2m'])
  })
})

describe('composeSpans', () => {
  const ladder = ['1h', '1m', '5s']
  const bucket = ny('2024-03-19 17:00')
  test('whole hours, then whole minutes, then the base for the rest', () => {
    const cursor = ny('2024-03-20 06:12') + 35_000
    expect(composeSpans(bucket, cursor, ladder, FX_GRID)).toEqual([
      { interval: '1h', from: bucket, to: ny('2024-03-20 06:00') },
      { interval: '1m', from: ny('2024-03-20 06:00'), to: ny('2024-03-20 06:12') },
      { interval: '5s', from: ny('2024-03-20 06:12'), to: cursor }
    ])
  })
  test('a cursor on an hour is hours alone', () => {
    const cursor = ny('2024-03-20 06:00')
    expect(composeSpans(bucket, cursor, ladder, FX_GRID)).toEqual([{ interval: '1h', from: bucket, to: cursor }])
  })
  test('inside the first hour and minute the base does it all', () => {
    const cursor = bucket + 35_000
    expect(composeSpans(bucket, cursor, ladder, FX_GRID)).toEqual([{ interval: '5s', from: bucket, to: cursor }])
  })
  test('at the Friday close, and over the weekend, the hours cover the session', () => {
    const thu = ny('2024-03-21 17:00')
    expect(composeSpans(thu, ny('2024-03-22 17:00'), ladder, FX_GRID)).toEqual([{ interval: '1h', from: thu, to: ny('2024-03-22 17:00') }])
    expect(composeSpans(thu, ny('2024-03-23 10:00'), ladder, FX_GRID)).toEqual([{ interval: '1h', from: thu, to: ny('2024-03-23 10:00') }])
  })
  test('one interval is one span to the cursor', () => {
    const cursor = ny('2024-03-20 06:12') + 35_000
    expect(composeSpans(bucket, cursor, ['5s'], FX_GRID)).toEqual([{ interval: '5s', from: bucket, to: cursor }])
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
    expect(nonWeekendGaps('1h', bars, FX_GRID)).toEqual([{ after: ny('2024-03-10 17:00'), before: ny('2024-03-10 19:00') }])
  })
})
