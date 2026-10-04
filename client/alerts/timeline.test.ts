import { describe, expect, test } from 'bun:test'
import { compile, operandKey } from './rules'
import { freshRun, instants, scan, type Track } from './timeline'
import type { Operand } from './types'

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
