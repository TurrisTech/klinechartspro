import { describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'
import { timestampCalc } from './calc'

// A plugin template's result depends on the bars' timestamps, its stores (a new `extendData`)
// and its params -- never on the forming bar's prices, which is all a live tick changes.

const bars = (n: number): KLineData[] => Array.from({ length: n }, (_, i) => ({ timestamp: i, open: 1, high: 1, low: 1, close: 1 }))

describe('timestampCalc', () => {
  test('a tick reuses the result; a new bar, a reload, new extendData and new params recompute', () => {
    let runs = 0
    const calc = timestampCalc((data: KLineData[]) => {
      runs++
      return data.map((d) => d.timestamp)
    })
    const indicator = { extendData: { rev: 1 }, calcParams: [5] }
    const data = bars(3)
    const first = calc(data, indicator)
    data[2] = { ...data[2], close: 2 }
    expect(calc(data, indicator)).toBe(first)
    expect(runs).toBe(1)
    data.push({ timestamp: 3, open: 1, high: 1, low: 1, close: 1 })
    expect(calc(data, indicator)).toEqual([0, 1, 2, 3])
    expect(calc([...data], indicator)).toEqual([0, 1, 2, 3])
    indicator.extendData = { rev: 2 }
    calc([...data], indicator)
    indicator.calcParams = [6]
    calc([...data], indicator)
    expect(runs).toBe(5)
    // Each indicator keeps its own.
    calc(data, { extendData: { rev: 2 }, calcParams: [6] })
    expect(runs).toBe(6)
  })
})
