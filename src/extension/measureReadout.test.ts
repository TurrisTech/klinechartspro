import { describe, expect, test } from 'bun:test'

import { formatSpan, measureReadout, withAlpha } from './measureReadout'

const HOUR = 3_600_000

describe('measureReadout', () => {
  test('an up move on a pip-priced pair reads price, percent and pips', () => {
    const readout = measureReadout({ from: 1.1, to: 1.10123, bars: 15, spanMs: 15 * HOUR, precision: 5, pipSize: 0.0001 })
    expect(readout).toEqual({ up: true, move: '+0.00123 (+0.11%)  +12.3 pips', span: '15 bars, 15h' })
  })

  test('a down move is signed with a minus throughout', () => {
    const readout = measureReadout({ from: 150.25, to: 149.75, bars: -4, spanMs: -4 * HOUR, precision: 3, pipSize: 0.01 })
    expect(readout).toEqual({ up: false, move: '−0.500 (−0.33%)  −50.0 pips', span: '4 bars, 4h' })
  })

  test('an instrument without pips is measured in price and percent alone', () => {
    const readout = measureReadout({ from: 60000, to: 61500, bars: 3, spanMs: 3 * 86_400_000, precision: 2 })
    expect(readout.move).toBe('+1500.00 (+2.50%)')
    expect(readout.span).toBe('3 bars, 3d')
  })

  test('a move too small for the display precision is flat, not negative zero', () => {
    const readout = measureReadout({ from: 1.1, to: 1.0999999, bars: 1, spanMs: HOUR, precision: 5, pipSize: 0.0001 })
    expect(readout.move).toBe('0.00000 (0.00%)  0.0 pips')
    expect(readout.span).toBe('1 bar, 1h')
  })

  test('the bar count is whole, whatever the pixels gave', () => {
    expect(measureReadout({ from: 1, to: 2, bars: 6.9999, spanMs: 0, precision: 2 }).span).toBe('7 bars, 0s')
  })

  test('a zero starting price has no percent', () => {
    expect(measureReadout({ from: 0, to: 1, bars: 1, spanMs: HOUR, precision: 2 }).move).toBe('+1.00')
  })
})

describe('formatSpan', () => {
  test('two largest units, dropping a zero second unit', () => {
    expect(formatSpan(45_000)).toBe('45s')
    expect(formatSpan(12 * 60_000 + 30_000)).toBe('12m 30s')
    expect(formatSpan(15 * HOUR)).toBe('15h')
    expect(formatSpan(26 * HOUR + 15 * 60_000)).toBe('1d 2h')
    expect(formatSpan(-2 * HOUR)).toBe('2h')
    expect(formatSpan(0)).toBe('0s')
  })
})

describe('withAlpha', () => {
  test('hex and rgb spellings take the alpha; anything else is left alone', () => {
    expect(withAlpha('#2DC08E', 0.15)).toBe('rgba(45, 192, 142, 0.15)')
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)')
    expect(withAlpha('#2DC08Eff', 0.15)).toBe('rgba(45, 192, 142, 0.15)')
    expect(withAlpha('rgba(1, 2, 3, 1)', 0.2)).toBe('rgba(1, 2, 3, 0.2)')
    expect(withAlpha('red', 0.2)).toBe('red')
  })
})
