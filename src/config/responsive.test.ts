import { describe, expect, test } from 'bun:test'

import { centreWithin, shellSize } from './responsive'

describe('shellSize', () => {
  test('unmeasured is regular', () => {
    expect(shellSize(0, 0)).toBe('regular')
  })

  test('a portrait phone and a landscape phone are both phone', () => {
    expect(shellSize(390, 780)).toBe('phone')
    expect(shellSize(844, 360)).toBe('phone')
  })

  test('a tablet and a laptop are regular', () => {
    expect(shellSize(768, 1000)).toBe('regular')
    expect(shellSize(1366, 700)).toBe('regular')
  })

  test('two 1080p monitors spanned, or one 4K at 1x, is wide', () => {
    expect(shellSize(3840, 1030)).toBe('wide')
    expect(shellSize(3840, 2100)).toBe('wide')
  })
})

describe('centreWithin', () => {
  test('centres on the focus when there is room', () => {
    // A 600px dialog over the right monitor's pane, centred at 2880.
    expect(centreWithin(2880, 600, 0, 3840, 16)).toBe(2580)
  })

  test('is held inside the bounds at either edge', () => {
    expect(centreWithin(100, 600, 0, 3840, 16)).toBe(16)
    expect(centreWithin(3800, 600, 0, 3840, 16)).toBe(3224)
  })

  test('a box wider than the bounds pins to the start', () => {
    expect(centreWithin(200, 900, 0, 400, 8)).toBe(8)
  })
})
