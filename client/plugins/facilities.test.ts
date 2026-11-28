import { describe, expect, test } from 'bun:test'
import { installWindow } from './testing'

installWindow()
const { createFacilities } = await import('./facilities')
const { capabilities } = await import('../capabilities')
const { setReadClock } = await import('../config')

// What a plugin reads off the page through its facilities rather than importing it.

describe('createFacilities', () => {
  test("the read clock is the page's, read when asked", () => {
    const f = createFacilities()
    try {
      expect(f.readClock()).toBeNull()
      setReadClock(1_700_000_000_000)
      expect(f.readClock()).toBe(1_700_000_000_000)
    } finally {
      setReadClock(null)
    }
    expect(f.readClock()).toBeNull()
  })

  test("the bars cap is the server's, as discovery states it", () => {
    expect(createFacilities().maxBarsPerRequest).toBe(capabilities().limits.maxBarsPerRequest)
  })
})
