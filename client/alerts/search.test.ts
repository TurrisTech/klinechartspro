import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// klinecharts touches `window` at import.
installWindow()
const { AlertSearch, earliestHit, SEARCH_CHUNK_BARS } = await import('./search')
const { buildTrack, indexPoints } = await import('./compute')
const { compile } = await import('./rules')
const { instants, scan } = await import('./timeline')
const { FX_GRID } = await import('../replay/timeframes')
import type { AlertBar } from './compute'
import type { AlertData, Point } from './data'
import type { ServerCatalogue } from './catalogue'
import type { Alert, Operand, Rule } from './types'

const H = 3_600_000
const T0 = Date.UTC(2024, 0, 1)
const SYM = 'oanda:EURUSD'

/** A continuous hourly market: a slow wave with a faster one on it, so an RSI and a moving
 * average cross their levels many times over a few thousand bars. */
function hourly(count: number): AlertBar[] {
  return Array.from({ length: count }, (_, i) => {
    const c = 1.1 + 0.01 * Math.sin(i / 40) + 0.003 * Math.sin(i / 7)
    const o = 1.1 + 0.01 * Math.sin((i - 1) / 40) + 0.003 * Math.sin((i - 1) / 7)
    const open = T0 + i * H
    return { open, end: open + H, date: open, o, h: Math.max(o, c) + 0.0005, l: Math.min(o, c) - 0.0005, c, v: 100 }
  })
}

class FakeData implements AlertData {
  barReads = 0
  pointReads = 0
  constructor(
    readonly series: Map<string, AlertBar[]>,
    readonly pointRows: Point[] = []
  ) {}
  async grid() {
    return FX_GRID
  }
  async bars(_symbol: string, interval: string, from: number, to: number): Promise<AlertBar[]> {
    this.barReads++
    return (this.series.get(interval) ?? []).filter((b) => b.open >= from && b.open < to)
  }
  async votes() {
    return []
  }
  async points(_source: unknown, _symbol: string, _interval: string, from: number, to: number): Promise<Point[]> {
    this.pointReads++
    return this.pointRows.filter((p) => p.date >= from && p.date < to)
  }
}

const NO_CATALOGUE: ServerCatalogue = { stored: [], signals: [] }

function alert(rule: Rule, trigger: Alert['trigger'] = 'level'): Alert {
  return {
    id: 'a1', kind: 'client', name: 'test', note: '', enabled: true, symbol: SYM, rule, trigger, repeat: 'always',
    cooldownMs: 0, createdAt: 0, updatedAt: 0, armedAt: 0, status: 'armed', lastFiredAt: null, fireCount: 0
  }
}

/** Every instant the rule triggers at, by one evaluation over the whole series at once -- the
 * answer the chunked search must reproduce. */
async function wholeSeriesHits(bars: AlertBar[], rule: Rule, trigger: Alert['trigger'], after: number): Promise<number[]> {
  const compiled = compile(rule)
  const track = await buildTrack('1h', bars, compiled.operands.values(), () => undefined)
  const list = instants([track], compiled.fields)
  const hits: number[] = []
  let cursor = after
  for (let i = 0; i < 5; i++) {
    const hit = scan(compiled.condition, trigger, list, cursor, Number.POSITIVE_INFINITY)
    if (!hit) break
    hits.push(hit.at)
    cursor = hit.at
  }
  return hits
}

describe('AlertSearch', () => {
  const bars = hourly(SEARCH_CHUNK_BARS * 3)
  const data = (): FakeData => new FakeData(new Map([['1h', bars]]))
  const until = bars[bars.length - 1].end

  const ma: Operand = { kind: 'indicator', interval: '1h', name: 'MA', params: [20], output: 'ma1' }
  const close: Operand = { kind: 'bar', interval: '1h', field: 'close' }
  const rsi: Operand = { kind: 'indicator', interval: '1h', name: 'RSI', params: [14], output: 'rsi1' }

  test('finds what one whole-series evaluation finds, across chunk boundaries', async () => {
    const rule: Rule = { left: close, op: 'crosses_above', right: { operand: ma } }
    // Starting deep enough that the hits straddle the first chunk's end.
    const after = bars[SEARCH_CHUNK_BARS - 200].end
    const expected = await wholeSeriesHits(bars, rule, 'level', after)
    expect(expected.length).toBeGreaterThan(2)
    const search = new AlertSearch(data(), async () => NO_CATALOGUE)
    let cursor = after
    const found: number[] = []
    for (const _ of expected) {
      const hit = await search.next(alert(rule), cursor, until)
      if (!hit) break
      found.push(hit.at)
      cursor = hit.at
    }
    expect(found).toEqual(expected)
  })

  test('a recursive indicator lands on the same bars with a windowed lead-in', async () => {
    const rule: Rule = { left: rsi, op: 'crosses_below', right: { value: 35 } }
    const after = bars[2000].end
    const expected = await wholeSeriesHits(bars, rule, 'edge', after)
    const search = new AlertSearch(data(), async () => NO_CATALOGUE)
    const hit = await search.next(alert(rule, 'edge'), after, until)
    expect(hit?.at).toBe(expected[0])
  })

  test('nothing to find answers null, and a stop is heard between chunks', async () => {
    const never: Rule = { left: close, op: '>', right: { value: 5 } }
    const search = new AlertSearch(data(), async () => NO_CATALOGUE)
    expect(await search.next(alert(never), bars[100].end, until)).toBeNull()
    let chunks = 0
    const stopped = await search.next(alert(never), bars[100].end, until, {
      onProgress: () => {
        chunks++
      },
      shouldStop: () => chunks >= 1
    })
    expect(stopped).toBeNull()
    expect(chunks).toBe(1)
  })

  test('a second search starting where the first stopped refetches nothing it holds', async () => {
    const rule: Rule = { left: close, op: 'crosses_above', right: { operand: ma } }
    const fake = data()
    const search = new AlertSearch(fake, async () => NO_CATALOGUE)
    const first = await search.next(alert(rule), bars[500].end, until)
    const reads = fake.barReads
    await search.next(alert(rule), first?.at ?? 0, (first?.at ?? 0) + 10 * H)
    expect(fake.barReads).toBe(reads)
  })

  test('a signal is read off the plugin points by bar date', async () => {
    const signal: Operand = { kind: 'signal', interval: '1h', plugin: 'arev', variant: 'arev21' }
    const points: Point[] = bars.slice(0, 400).map((b, i) => ({ date: b.date, signal: i === 150 || i === 300 ? 'long' : null }))
    const fake = new FakeData(new Map([['1h', bars]]), points)
    const search = new AlertSearch(fake, async () => NO_CATALOGUE)
    const rule: Rule = { left: signal, op: '==', right: { label: 'long' } }
    expect((await search.next(alert(rule), bars[100].end, until))?.at).toBe(bars[150].end)
    expect((await search.next(alert(rule), bars[150].end, until))?.at).toBe(bars[300].end)
    // Served bars with no label are "no signal", which never holds.
    expect(await search.next(alert(rule), bars[300].end, bars[399].end)).toBeNull()
  })

  test('across a gap the cursor\'s baseline is the bars before the gap, not nothing', async () => {
    // Hourly bars, then 48 hours of nothing, then hourly again; the cursor at the end of the gap.
    const gapped = hourly(400).map((b, i) => (i < 200 ? b : { ...b, open: b.open + 48 * H, end: b.end + 48 * H, date: b.date + 48 * H }))
    const flat = gapped.map((b, i) => ({ ...b, c: i < 199 ? 1.0 : 1.2, o: 1.0, h: 1.2, l: 1.0 }))
    const search = new AlertSearch(new FakeData(new Map([['1h', flat]])), async () => NO_CATALOGUE)
    const cursor = flat[199].end + 47 * H
    // The close crossed above 1.1 on the last bar BEFORE the gap: nothing after it is a new
    // crossing, and an edge that started holding there is not new either.
    expect(await search.next(alert({ left: close, op: 'crosses_above', right: { value: 1.1 } }), cursor, flat[399].end)).toBeNull()
    expect(await search.next(alert({ left: close, op: '>', right: { value: 1.1 } }, 'edge'), cursor, flat[399].end)).toBeNull()
    // ...while one placed before that bar does see it.
    expect((await search.next(alert({ left: close, op: 'crosses_above', right: { value: 1.1 } }), flat[197].end, flat[399].end))?.at).toBe(flat[199].end)
  })

  test('a sparse source: a bar it evaluated past with no row is "no signal", so each signal is new', async () => {
    const signal: Operand = { kind: 'signal', interval: '1h', plugin: 'krev', variant: 'krev01' }
    // Rows only on the extremes, as krev writes them -- nothing on the bars between.
    const points: Point[] = [120, 160, 161, 230].map((i) => ({ date: bars[i].date, side: 'bottom', signal: 'bottom' }))
    const search = new AlertSearch(new FakeData(new Map([['1h', bars]]), points), async () => NO_CATALOGUE)
    const rule: Rule = { left: signal, op: '==', right: { label: 'bottom' } }
    const hits: number[] = []
    let cursor = bars[100].end
    for (let i = 0; i < 4; i++) {
      const hit = await search.next(alert(rule, 'edge'), cursor, until)
      if (!hit) break
      hits.push(hit.at)
      cursor = hit.at
    }
    // Two in a row (160, 161) are one episode to an edge trigger; the empty bars between the
    // others reset it.
    expect(hits).toEqual([bars[120].end, bars[160].end, bars[230].end])
  })

  test('earliestHit takes the soonest of several', async () => {
    const search = new AlertSearch(data(), async () => NO_CATALOGUE)
    const a = { ...alert({ left: close, op: '>', right: { value: 5 } }), id: 'never' }
    const b = { ...alert({ left: close, op: 'crosses_above', right: { operand: ma } }), id: 'cross' }
    const hit = await earliestHit(search, [a, b], bars[100].end, until)
    expect(hit?.alert.id).toBe('cross')
  })
})

describe('time conditions', () => {
  const bars = hourly(24 * 10)
  const data = (): FakeData => new FakeData(new Map([['1h', bars]]))
  const until = bars[bars.length - 1].end
  const close: Operand = { kind: 'bar', interval: '1h', field: 'close' }
  test('the clock is read at a bar\'s close, on the zone\'s own wall clock, across DST', async () => {
    const { clockValue } = await import('./compute')
    // 14:30Z in March is 09:30 New York (EST); in July 13:30Z is (EDT).
    expect(clockValue(Date.UTC(2024, 2, 4, 14, 30), 'minute', 'America/New_York')).toBe(570)
    expect(clockValue(Date.UTC(2024, 6, 1, 13, 30), 'minute', 'America/New_York')).toBe(570)
    expect(clockValue(Date.UTC(2024, 2, 4, 14, 30), 'weekday', 'America/New_York')).toBe('Mon')
    expect(clockValue(Date.UTC(2024, 2, 4, 3, 0), 'weekday', 'America/New_York')).toBe('Sun')
    expect(clockValue(Date.UTC(2024, 2, 4, 14, 30), 'minute', 'Asia/Tokyo')).toBe(23 * 60 + 30)
  })

  test('"reaches 09:30 New York" fires once a day, at the first close at or after it', async () => {
    // The hourly bars above start 2024-01-01 00:00Z; New York is UTC-5 then, so 09:30 is
    // 14:30Z and the first hourly close at or after it is 15:00Z.
    const search = new AlertSearch(data(), async () => NO_CATALOGUE)
    const at: Operand = { kind: 'time', interval: '1h', field: 'minute', zone: 'America/New_York' }
    const rule: Rule = { left: at, op: 'crosses_above', right: { value: 570 } }
    const first = await search.next(alert(rule), bars[0].end, until)
    expect(first?.at).toBe(Date.UTC(2024, 0, 1, 15))
    const second = await search.next(alert(rule), first?.at ?? 0, until)
    expect(second?.at).toBe(Date.UTC(2024, 0, 2, 15))
  })

  test('a window: a condition holds only between 08:00 and 11:00', async () => {
    const search = new AlertSearch(data(), async () => NO_CATALOGUE)
    const minute: Operand = { kind: 'time', interval: '1h', field: 'minute', zone: 'America/New_York' }
    const rule: Rule = { all: [{ left: close, op: '>', right: { value: 0 } }, { left: minute, op: 'inside', right: { band: [480, 660] } }] }
    // 08:00 New York is 13:00Z: the first hourly close inside the window.
    expect((await search.next(alert(rule), bars[0].end, until))?.at).toBe(Date.UTC(2024, 0, 1, 13))
  })
})

describe('familyTitle', () => {
  test('a variant that repeats its plugin is named by what it adds', async () => {
    const { familyTitle } = await import('./catalogue')
    expect(familyTitle('AREV21 outlier', 'arev21_outlier_rank')).toBe('AREV21 outlier rank')
    expect(familyTitle('AREV', 'arev21')).toBe('AREV arev21')
    expect(familyTitle('KREV', '')).toBe('KREV')
  })
})

describe('indexPoints', () => {
  test('folds several rows on one bar under their side', () => {
    const index = indexPoints(
      [
        { date: 1, side: 'top', p: 0.7 },
        { date: 1, side: 'bottom', p: 0.2 }
      ] as Point[],
      'side'
    )
    expect(index.rows.get(1)?.folded).toEqual({ top: { date: 1, side: 'top', p: 0.7 }, bottom: { date: 1, side: 'bottom', p: 0.2 } })
    expect(index.rows.get(1)?.rows.length).toBe(2)
  })
})
