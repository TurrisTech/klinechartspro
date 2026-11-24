import { describe, expect, test } from 'bun:test'
import { describeStep, forgetStep, MAX_SAVED_STEPS, parseStep, readSavedSteps, rememberStep } from './steps'
import { FX_GRID } from './timeframes'

// A step typed in words is the session's `{ interval, multiple }`: N whole candles of one
// interval, the weekend skipped by the candle grid.

const ok = (text: string, base = '5s', frames: string[] = []) => {
  const parsed = parseStep(text, base, frames)
  if (!parsed.ok) throw new Error(`${text}: ${parsed.reason}`)
  return parsed.step
}
const refused = (text: string, base = '5s', frames: string[] = []) => {
  const parsed = parseStep(text, base, frames)
  if (parsed.ok) throw new Error(`${text} was taken as ${JSON.stringify(parsed.step)}`)
  return parsed.reason
}

describe('parseStep', () => {
  test('an amount is that many one-unit candles', () => {
    expect(ok('15h')).toEqual({ interval: '1h', multiple: 15 })
    expect(ok('30h')).toEqual({ interval: '1h', multiple: 30 })
    expect(ok('90m')).toEqual({ interval: '1m', multiple: 90 })
    expect(ok('2D')).toEqual({ interval: '1D', multiple: 2 })
    expect(ok('2d')).toEqual({ interval: '1D', multiple: 2 })
    expect(ok('3W')).toEqual({ interval: '1W', multiple: 3 })
    expect(ok('2M')).toEqual({ interval: '1M', multiple: 2 })
    // Spelled, spaced, upper-case hours.
    expect(ok(' 15 hrs ')).toEqual({ interval: '1h', multiple: 15 })
    expect(ok('15H')).toEqual({ interval: '1h', multiple: 15 })
  })

  test('`m` is a minute and `M` a month', () => {
    expect(ok('6m')).toEqual({ interval: '1m', multiple: 6 })
    expect(ok('6M')).toEqual({ interval: '1M', multiple: 6 })
    expect(ok('6mo')).toEqual({ interval: '1M', multiple: 6 })
  })

  test('as finely as the base lets the step end on a base bar', () => {
    // A 5m base cannot stop on a minute that is not a multiple of five.
    expect(ok('45m', '5m')).toEqual({ interval: '5m', multiple: 9 })
    expect(ok('15h', '1h')).toEqual({ interval: '1h', multiple: 15 })
    expect(ok('30s', '5s')).toEqual({ interval: '5s', multiple: 6 })
    expect(refused('7m', '5m')).toBe('7m is not a whole number of 5m base bars')
    expect(refused('15h', '2h')).toBe('15h is not a whole number of 2h base bars')
    expect(refused('15h', '1D')).toBe('15h is not a whole number of 1D base bars')
  })

  test('an explicit multiple keeps its interval', () => {
    expect(ok('3 × 4h')).toEqual({ interval: '4h', multiple: 3 })
    expect(ok('3x4h')).toEqual({ interval: '4h', multiple: 3 })
    expect(ok('3*15m')).toEqual({ interval: '15m', multiple: 3 })
    expect(refused('3 × 4h', '8h')).toBe('3 × 4h does not end on a 8h base bar')
  })

  test('a listed timeframe typed is that timeframe', () => {
    expect(ok('15m', '1m', ['1m', '15m', '1h'])).toEqual({ interval: '15m', multiple: 1 })
    expect(ok('15m', '1m', ['1m', '1h'])).toEqual({ interval: '1m', multiple: 15 })
  })

  test('nonsense, nothing, zero and a runaway are refused with a reason', () => {
    expect(refused('')).toBe('Type a step, like 15h or 30h')
    expect(refused('soon')).toBe('soon is not a step: try 15h, 90m or 2D')
    expect(refused('15q')).toBe('q is not a unit: use s, m, h, D, W or M')
    expect(refused('0h')).toBe('A step moves forward: use 1 or more')
    expect(refused('-3h')).toContain('not a step')
    expect(refused('99999h')).toContain('too long a step')
  })

  test('the step 15 × 1h lands fifteen market hours on, over the weekend', () => {
    // Fri 2024-03-08 10:00 New York (15:00Z): 7 hours to the 17:00 close, 8 more from Sunday's open.
    const step = ok('15h')
    const from = Date.UTC(2024, 2, 8, 15)
    expect(FX_GRID.advanceTarget(step.interval, from, step.multiple)).toBe(Date.UTC(2024, 2, 11, 5))
  })
})

describe('describeStep', () => {
  test('reads back what was typed', () => {
    for (const text of ['15h', '30h', '90m', '2D', '3 × 4h']) expect(describeStep(ok(text))).toBe(text)
    expect(describeStep({ interval: '1h', multiple: 1 })).toBe('1h')
    expect(describeStep({ interval: '15m', multiple: 1 })).toBe('15m')
  })

  test('never reads like a listed timeframe it is not', () => {
    expect(describeStep({ interval: '1m', multiple: 15 }, ['1m', '15m'])).toBe('15 × 1m')
    expect(describeStep({ interval: '1m', multiple: 15 }, ['1m', '1h'])).toBe('15m')
  })
})

describe('the steps this browser remembers', () => {
  const memory = (): Pick<Storage, 'getItem' | 'setItem'> => {
    const data = new Map<string, string>()
    return { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
  }

  test('most recent first, once each, at most MAX_SAVED_STEPS', () => {
    const storage = memory()
    expect(readSavedSteps(storage)).toEqual([])
    rememberStep('15h', storage)
    rememberStep('30h', storage)
    expect(rememberStep('15h', storage)).toEqual(['15h', '30h'])
    for (let i = 1; i <= MAX_SAVED_STEPS + 2; i++) rememberStep(`${i}D`, storage)
    expect(readSavedSteps(storage)).toHaveLength(MAX_SAVED_STEPS)
    expect(readSavedSteps(storage)[0]).toBe(`${MAX_SAVED_STEPS + 2}D`)
    expect(forgetStep(`${MAX_SAVED_STEPS + 2}D`, storage)[0]).toBe(`${MAX_SAVED_STEPS + 1}D`)
  })

  test('a damaged entry reads as none', () => {
    const storage = memory()
    storage.setItem('wd.replay.steps', '{not json')
    expect(readSavedSteps(storage)).toEqual([])
    storage.setItem('wd.replay.steps', JSON.stringify(['15h', 3, '']))
    expect(readSavedSteps(storage)).toEqual(['15h'])
  })
})
