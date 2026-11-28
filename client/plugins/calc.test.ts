import { describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'
import { shouldUpdateOn, timestampCalc } from './calc'

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

describe('shouldUpdateOn', () => {
  interface Extend {
    seriesKey: string
    rev: number
    config?: { colour: string; enabled: string[] }
    other?: string
  }
  const at = (extendData: Extend | undefined, calcParams: unknown[] = [1]) => ({ extendData, calcParams })
  const base: Extend = { seriesKey: 'a', rev: 1, config: { colour: '#fff', enabled: ['1h'] }, other: 'x' }

  test('recomputes when a named key changes, by identity, and always redraws', () => {
    const should = shouldUpdateOn<Extend>({ keys: ['seriesKey', 'rev'] })
    expect(should(at(base), at({ ...base }))).toEqual({ calc: false, draw: true })
    expect(should(at(base), at({ ...base, rev: 2 }))).toEqual({ calc: true, draw: true })
    expect(should(at(base), at({ ...base, seriesKey: 'b' }))).toEqual({ calc: true, draw: true })
    // A key it was not told about, and a params edit, only redraw.
    expect(should(at(base), at({ ...base, other: 'y' }, [2]))).toEqual({ calc: false, draw: true })
  })

  test('compares a json key by value, so a rebuilt but equal config does not recompute', () => {
    const should = shouldUpdateOn<Extend>({ keys: ['rev'], json: ['config'] })
    expect(should(at(base), at({ ...base, config: { colour: '#fff', enabled: ['1h'] } })).calc).toBe(false)
    expect(should(at(base), at({ ...base, config: { colour: '#000', enabled: ['1h'] } })).calc).toBe(true)
    // By identity the rebuilt config would have read as a change.
    expect(shouldUpdateOn<Extend>({ keys: ['config'] })(at(base), at({ ...base, config: { colour: '#fff', enabled: ['1h'] } })).calc).toBe(true)
  })

  test('counts a params edit only when asked to', () => {
    const should = shouldUpdateOn<Extend>({ keys: ['seriesKey', 'rev'], calcParams: true })
    expect(should(at(base, [1, 2]), at({ ...base }, [1, 2])).calc).toBe(false)
    expect(should(at(base, [1, 2]), at({ ...base }, [1, 3])).calc).toBe(true)
  })

  test('an indicator with no extendData yet reads every key as missing', () => {
    const should = shouldUpdateOn<Extend>({ keys: ['seriesKey', 'rev'], json: ['config'] })
    expect(should(at(undefined), at(undefined)).calc).toBe(false)
    expect(should(at(undefined), at(base)).calc).toBe(true)
  })
})
