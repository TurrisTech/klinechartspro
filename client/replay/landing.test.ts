import { describe, expect, test } from 'bun:test'
import { type LandingWall, LandingWarmer } from './landing'

// WHEN THE NEXT LANDING IS WARMED: after the wall's own reads, never while an advance runs, and
// one landing at a time. What is sent is the host's business (host.test.ts `warmAhead`) and where
// the panes will be the hub's (feed.test.ts `landingRange`).

/** A wall that loads bars for `loading` more looks, then goes quiet. */
function wall(opts: { loading?: number; busy?: () => boolean; cursor?: () => number } = {}) {
  let loading = opts.loading ?? 0
  const warmed: number[] = []
  const looks: number[] = []
  const stub: LandingWall = {
    settled: async () => {},
    loadsInFlight: () => {
      looks.push(loading)
      return loading > 0 ? loading-- : 0
    },
    busy: opts.busy ?? (() => false),
    cursor: opts.cursor ?? (() => 0),
    warm: async (at) => {
      warmed.push(at)
      return 1
    }
  }
  return { stub, warmed, looks }
}

const FAST = { timeoutMs: 1_000, pollMs: 1 }

describe('LandingWarmer', () => {
  test("waits until no pane is loading bars on two looks in a row: a reloaded pane's overlays ask after its bars arrive", async () => {
    const { stub, warmed, looks } = wall({ loading: 3 })
    expect(await new LandingWarmer(stub, FAST).warm(100)).toBe(1)
    expect(warmed).toEqual([100])
    // Three looks while loading, then two quiet ones.
    expect(looks).toEqual([3, 2, 1, 0, 0])
  })

  test("after the wall's plugin reads have settled, every look", async () => {
    const order: string[] = []
    const stub: LandingWall = {
      settled: async () => {
        order.push('settled')
      },
      loadsInFlight: () => 0,
      busy: () => false,
      cursor: () => 0,
      warm: async () => {
        order.push('warm')
        return 1
      }
    }
    await new LandingWarmer(stub, FAST).warm(100)
    expect(order).toEqual(['settled', 'settled', 'warm'])
  })

  test('a later landing drops one still waiting, and only the later one is sent', async () => {
    const { stub, warmed } = wall({ loading: 2 })
    const warmer = new LandingWarmer(stub, FAST)
    const first = warmer.warm(100)
    const second = warmer.warm(200)
    expect(await first).toBe(0)
    expect(await second).toBe(1)
    expect(warmed).toEqual([200])
  })

  test('not while an advance runs: the press reads its landing itself', async () => {
    let busy = true
    const { stub, warmed } = wall({ busy: () => busy })
    expect(await new LandingWarmer(stub, FAST).warm(100)).toBe(0)
    busy = false
    expect(await new LandingWarmer(stub, FAST).warm(100)).toBe(1)
    expect(warmed).toEqual([100])
  })

  test('nor once a press has landed there while it waited', async () => {
    let cursor = 0
    const { stub, warmed } = wall({ loading: 2, cursor: () => cursor })
    const waiting = new LandingWarmer(stub, FAST).warm(100)
    cursor = 100
    expect(await waiting).toBe(0)
    expect(warmed).toEqual([])
  })

  test('leaving the replay drops a warm-up still waiting', async () => {
    const { stub, warmed } = wall({ loading: 5 })
    const warmer = new LandingWarmer(stub, FAST)
    const waiting = warmer.warm(100)
    warmer.dispose()
    expect(await waiting).toBe(0)
    expect(warmed).toEqual([])
  })

  test('a wall that never goes quiet is warmed at the deadline anyway', async () => {
    const { stub, warmed } = wall({ loading: Number.POSITIVE_INFINITY })
    const started = Date.now()
    expect(await new LandingWarmer(stub, { timeoutMs: 30, pollMs: 1 }).warm(100)).toBe(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(30)
    expect(warmed).toEqual([100])
  })
})
