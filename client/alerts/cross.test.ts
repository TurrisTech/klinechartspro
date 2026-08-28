import { expect, test } from 'bun:test'
import { observationFor, reach, sideOf, triggers } from './cross'

// The whole of when an alert fires. Pure, so this file needs no window, no chart and no
// stream -- which is the point of keeping the rule in cross.ts rather than in the monitor.

const armedAt = 1_000_000

function alert(price: number, from: 'above' | 'below') {
  return { price, from } as const
}

test('the armed side is taken from where the market is', () => {
  expect(sideOf(1.15, 1.16)).toBe('below')
  expect(sideOf(1.17, 1.16)).toBe('above')
  // At the level exactly: 'below' means "fires as soon as it is at or above", which is the
  // honest answer to "tell me when it is 1.16" when it already is.
  expect(sideOf(1.16, 1.16)).toBe('below')
})

test('an alert armed below fires at or above its level', () => {
  const a = alert(1.16, 'below')
  expect(triggers(a, { price: 1.1599 })).toBe(false)
  expect(triggers(a, { price: 1.16 })).toBe(true)
  expect(triggers(a, { price: 1.1601 })).toBe(true)
})

test('an alert armed above fires at or below its level', () => {
  const a = alert(1.16, 'above')
  expect(triggers(a, { price: 1.1601 })).toBe(false)
  expect(triggers(a, { price: 1.16 })).toBe(true)
  expect(triggers(a, { price: 1.1599 })).toBe(true)
})

test('a wick fires it even when the bar closed back on the wrong side', () => {
  // The move between two frames is exactly what the close-to-close reading misses, and on a
  // fast market it is where the crossing is.
  expect(triggers(alert(1.16, 'below'), { price: 1.1595, high: 1.1605, low: 1.159 })).toBe(true)
  expect(triggers(alert(1.16, 'above'), { price: 1.1605, high: 1.161, low: 1.1595 })).toBe(true)
})

test('the direction is one-sided: the wrong-way extreme is ignored', () => {
  // A bar that dipped to 1.1590 does not fire an alert waiting for 1.1600 from below.
  expect(triggers(alert(1.16, 'below'), { price: 1.1595, high: 1.1598, low: 1.159 })).toBe(false)
  expect(triggers(alert(1.16, 'above'), { price: 1.1605, high: 1.161, low: 1.1602 })).toBe(false)
})

test('reach is the extreme in the watched direction only', () => {
  expect(reach({ price: 1.1, high: 1.2, low: 1.0 }, 'below')).toBe(1.2)
  expect(reach({ price: 1.1, high: 1.2, low: 1.0 }, 'above')).toBe(1.0)
  // No extremes: the close is all there is, in both directions.
  expect(reach({ price: 1.1 }, 'below')).toBe(1.1)
  expect(reach({ price: 1.1 }, 'above')).toBe(1.1)
})

test('a bar already forming when the alert was armed contributes no extremes', () => {
  const bar = { date: armedAt - 30_000, open: 1.16, high: 1.17, low: 1.15, close: 1.161 }
  const observation = observationFor({ armedAt }, bar)
  expect(observation).toEqual({ price: 1.161 })
  // ...so the 1.15 low, which happened before the user asked for anything, cannot fire an
  // alert armed above at 1.155.
  expect(triggers(alert(1.155, 'above'), observation)).toBe(false)
})

test('a bar that opened after the alert was armed contributes its extremes', () => {
  const bar = { date: armedAt, open: 1.16, high: 1.17, low: 1.15, close: 1.161 }
  const observation = observationFor({ armedAt }, bar)
  expect(observation).toEqual({ price: 1.161, high: 1.17, low: 1.15 })
  expect(triggers(alert(1.155, 'above'), observation)).toBe(true)
})
