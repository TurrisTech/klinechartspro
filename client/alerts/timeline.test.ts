import { describe, expect, test } from 'bun:test'
import { compile, operandKey } from './rules'
import { freshRun, instants, scan, type Track } from './timeline'
import { ANY_LABEL, type Operand, type Rule } from './types'

const H = 3_600_000
const close1h: Operand = { kind: 'bar', interval: '1h', field: 'close' }
const close4h: Operand = { kind: 'bar', interval: '4h', field: 'close' }

function track(interval: string, at: number[], operand: Operand, values: Array<number | string | undefined>): Track {
  return { interval, at, values: new Map([[operandKey(operand), values]]) }
}

describe('instants', () => {
  test('every close of every timeframe, each operand as of its own latest close', () => {
    const compiled = compile({ left: close1h, op: '>', right: { operand: close4h } })
    const hourly = track('1h', [1, 2, 3, 4, 5].map((h) => h * H), close1h, [10, 11, 12, 13, 14])
    const fourHourly = track('4h', [4 * H], close4h, [12.5])
    const list = instants([hourly, fourHourly], compiled.fields)
    expect(list.map((i) => i.at / H)).toEqual([1, 2, 3, 4, 5])
    const diff = `${operandKey(close1h)} - ${operandKey(close4h)}`
    // Before the 4h bar closed there is nothing to compare with: unknowable, not stale.
    expect(list[2].observation[diff]).toBeUndefined()
    // The 1h and 4h closes at 04:00 are ONE observation, read together.
    expect(list[3].observation[diff]).toEqual({ value: 13 - 12.5 })
    expect(list[4].observation[diff]).toEqual({ value: 14 - 12.5 })
  })

  test('a missing value reads as missing, never as the bar before', () => {
    const compiled = compile({ left: close1h, op: '>', right: { value: 0 } })
    const list = instants([track('1h', [H, 2 * H, 3 * H], close1h, [1, undefined, Number.NaN])], compiled.fields)
    expect(list.map((i) => i.observation[operandKey(close1h)] !== undefined)).toEqual([true, false, false])
  })

  test('only (from, to] is returned', () => {
    const compiled = compile({ left: close1h, op: '>', right: { value: 0 } })
    const list = instants([track('1h', [H, 2 * H, 3 * H], close1h, [1, 2, 3])], compiled.fields, H, 2 * H)
    expect(list.map((i) => i.at)).toEqual([2 * H])
  })
})

describe('scan', () => {
  const at = [1, 2, 3, 4, 5, 6].map((h) => h * H)

  test('level: the first close after the cursor where the rule holds', () => {
    const { condition, fields } = compile({ left: close1h, op: '>', right: { value: 10 } })
    const list = instants([track('1h', at, close1h, [11, 12, 9, 11, 12, 13])], fields)
    // Holding at the cursor (02:00) does not make 02:00 "next"; 03:00 fails; 04:00 holds.
    expect(scan(condition, 'level', list, 2 * H, 6 * H)?.at).toBe(4 * H)
    // Still holding at 04:00, so level stops at 05:00 too.
    expect(scan(condition, 'level', list, 4 * H, 6 * H)?.at).toBe(5 * H)
  })

  test('edge: only where it STARTS holding, judged against what was before the cursor', () => {
    const { condition, fields } = compile({ left: close1h, op: '>', right: { value: 10 } })
    const list = instants([track('1h', at, close1h, [11, 12, 9, 11, 12, 13])], fields)
    expect(scan(condition, 'edge', list, 2 * H, 6 * H)?.at).toBe(4 * H)
    // Holding since 04:00: nothing new starts before the end.
    expect(scan(condition, 'edge', list, 4 * H, 6 * H)).toBeNull()
  })

  test('a crossing compares against the close at the cursor', () => {
    const { condition, fields } = compile({ left: close1h, op: 'crosses_above', right: { value: 10 } })
    const list = instants([track('1h', at, close1h, [9, 11, 9, 9, 11, 12])], fields)
    expect(scan(condition, 'level', list, 0, 6 * H)?.at).toBe(2 * H)
    expect(scan(condition, 'level', list, 2 * H, 6 * H)?.at).toBe(5 * H)
  })

  test('nothing after `until`, and the state carries across chunks', () => {
    const { condition, fields } = compile({ left: close1h, op: 'crosses_above', right: { value: 10 } })
    const list = instants([track('1h', at, close1h, [9, 9, 9, 11, 9, 9])], fields)
    expect(scan(condition, 'level', list, 0, 3 * H)).toBeNull()
    const state = freshRun()
    expect(scan(condition, 'level', list.slice(0, 3), 0, 6 * H, state)).toBeNull()
    // The second chunk's first instant crosses from the first chunk's last reading.
    expect(scan(condition, 'level', list.slice(3), 0, 6 * H, state)?.at).toBe(4 * H)
  })

  test('a signal is true on its own bar and nowhere else', () => {
    const signal: Operand = { kind: 'signal', interval: '1h', plugin: 'arev', variant: 'arev21' }
    const { condition, fields } = compile({ left: signal, op: '==', right: { label: 'long' } })
    const list = instants([track('1h', at, signal, ['', 'long', '', 'long', 'long', undefined])], fields)
    expect(scan(condition, 'level', list, 0, 6 * H)?.at).toBe(2 * H)
    expect(scan(condition, 'level', list, 2 * H, 6 * H)?.at).toBe(4 * H)
    expect(scan(condition, 'level', list, 4 * H, 6 * H)?.at).toBe(5 * H)
    // Two in a row are one episode to an edge trigger.
    expect(scan(condition, 'edge', list, 4 * H, 6 * H)).toBeNull()
  })
})

describe('entries take part in one firing', () => {
  // Minutes from 00:00: 3m bars close at 3, 6, 9, ..., 5m bars at 5, 10, 15, ...
  const MIN = 60_000
  const graph = (interval: string): Operand => ({ kind: 'graph', interval, overlay: 'mtf_arev21_outlier_rank_85', timeframes: ['3m', '5m', '1h', '1D'], roots: ['1D'], maxStep: 8 })
  const g3 = graph('3m')
  const g5 = graph('5m')
  const any = (operand: Operand) => ({ left: operand, op: '==', right: { label: ANY_LABEL } })
  const closes = (step: number, last: number) => Array.from({ length: last / step }, (_, i) => (i + 1) * step * MIN)
  /** A track of `operand` with an entry (`top`) on the bars closing at `stars`, none elsewhere. */
  function stars(interval: string, step: number, operand: Operand, at: number[]): Track {
    const ends = closes(step, 30)
    return { interval, at: ends, values: new Map([[operandKey(operand), ends.map((e) => (at.includes(e / MIN) ? 'top' : ''))]]), entries: new Set([operandKey(operand)]) }
  }
  /** Every stop a replay's Next alert makes, press after press, in minutes. */
  function stops(rule: Rule, trigger: 'level' | 'edge', tracks: Track[]): number[] {
    const { condition, fields } = compile(rule)
    const list = instants(tracks, fields)
    const out: number[] = []
    let after = 0
    for (let hit = scan(condition, trigger, list, after, 30 * MIN); hit; hit = scan(condition, trigger, list, after, 30 * MIN)) {
      out.push(hit.at / MIN)
      after = hit.at
    }
    return out
  }

  // A 5m star at 10, another at 25, and a 3m star at 27 while the 25 one is still the latest 5m bar.
  const either = { any: [any(g3), any(g5)] }
  const tracks = () => [stars('3m', 3, g3, [27]), stars('5m', 5, g5, [10, 25])]

  test('3m or 5m: one stop per star -- not again at the other timeframe\'s next close', () => {
    // Before: 10, 12, 25, 27, 30 -- the 5m star at 12, the 3m one at 30, read again.
    expect(stops(either, 'level', tracks())).toEqual([10, 25, 27])
  })

  test('3m or 5m, edge: a star landing while the other is the latest bar still stops', () => {
    // Before: 10, 25 -- the rule had held since 25, so the 3m star at 27 began nothing.
    expect(stops(either, 'edge', tracks())).toEqual([10, 25, 27])
  })

  test('3m and 5m: fires at the second of the two to close; a fired star is not reused', () => {
    const both = { all: [any(g3), any(g5)] }
    // 3m at 9 then 5m at 10: one stop, at 10. 5m at 20 then 3m at 21: one stop, at 21. The 3m
    // star at 24 has only the 5m one at 20 to pair with, and that one has fired.
    expect(stops(both, 'level', [stars('3m', 3, g3, [9, 21, 24]), stars('5m', 5, g5, [10, 20])])).toEqual([10, 21])
  })

  test('a star with a condition on a finer timeframe stops once, not at every finer close', () => {
    const close3m: Operand = { kind: 'bar', interval: '3m', field: 'close' }
    const ends = closes(3, 30)
    const rule = { all: [any(g5), { left: close3m, op: '>', right: { value: 0 } }] }
    // Before: 10 and 12 -- the 3m close at 12 is new and holds, and the 5m star was re-read.
    expect(stops(rule, 'level', [track('3m', ends, close3m, ends.map(() => 1)), stars('5m', 5, g5, [10])])).toEqual([10])
  })

  test('stars on back-to-back bars are a stop each, in either mode', () => {
    const one = any(g3)
    expect(stops(one, 'level', [stars('3m', 3, g3, [21, 24])])).toEqual([21, 24])
    // Unlike a signal, an entry is not an episode: each is a star of its own.
    expect(stops(one, 'edge', [stars('3m', 3, g3, [21, 24])])).toEqual([21, 24])
  })
})
