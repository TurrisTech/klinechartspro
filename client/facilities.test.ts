import { describe, expect, test } from 'bun:test'
import { installWindow } from './plugins/testing'

installWindow()
const { createFacilities, inertStream } = await import('./facilities')
const { capabilities } = await import('./capabilities')
const { setReadClock } = await import('./config')
const { stream } = await import('./stream')

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

  test('a live wall gets the page stream, a replay wall the inert one', async () => {
    expect(createFacilities().stream).toBe(stream)
    const replay = createFacilities({ stream: inertStream })
    expect(replay.stream).toBe(inertStream)
    // Nothing live reaches a replay's stores: a subscription is taken and never answered.
    const heard: unknown[] = []
    const listener = { onBar: (bar: unknown) => void heard.push(bar), onBackfill: (bars: unknown[]) => void heard.push(...bars) }
    replay.stream.subscribe('oanda', 'EURUSD', '1h', listener)
    await new Promise((resolve) => setTimeout(resolve, 0))
    replay.stream.unsubscribe('oanda', 'EURUSD', '1h', listener)
    expect(heard).toEqual([])
  })
})
