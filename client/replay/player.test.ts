import { describe, expect, test } from 'bun:test'
import { ReplayPlayer } from './player'
import type { AdvanceResult } from './session'

// THE PLAYER on its own: a fake step, a sleep the test releases by hand, and the one promise
// it is allowed to wait on besides. No DOM, no timers of its own.

function result(reason: AdvanceResult['reason'] = 'target'): AdvanceResult {
  return { from: 0, to: 1, request: { interval: '1h', multiple: 1 }, reason, alert: null, events: [], bars: [], walked: false, observed: [] }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function harness(steps: Array<AdvanceResult | null | Error> = []) {
  const sleeps: Array<{ ms: number; release: () => void }> = []
  const results: AdvanceResult[] = []
  let changes = 0
  let calls = 0
  const player = new ReplayPlayer({
    step: async () => {
      // By position, not `??`: a scripted null (could not start) is a step result too.
      const next = calls < steps.length ? steps[calls] : result()
      calls++
      if (next instanceof Error) throw next
      return next
    },
    onResult: (r) => results.push(r),
    onChange: () => {
      changes++
    },
    sleep: (ms) => new Promise((resolve) => sleeps.push({ ms, release: resolve })),
    delayMs: 500
  })
  return {
    player,
    results,
    get calls() {
      return calls
    },
    get changes() {
      return changes
    },
    sleeps,
    async tick(): Promise<void> {
      for (const s of sleeps.splice(0)) s.release()
      await flush()
    }
  }
}

describe('ReplayPlayer', () => {
  test('steps, waits the pace, steps again, until paused', async () => {
    const h = harness()
    h.player.play()
    expect(h.player.playing).toBe(true)
    await flush()
    expect(h.calls).toBe(1)
    expect(h.sleeps.map((s) => s.ms)).toEqual([500])
    await h.tick()
    expect(h.calls).toBe(2)
    h.player.pause()
    await h.tick()
    expect(h.calls).toBe(2)
    expect(h.results.length).toBe(2)
  })

  test('play twice is one play, not two loops', async () => {
    const h = harness()
    h.player.play()
    h.player.play()
    await flush()
    expect(h.calls).toBe(1)
    expect(h.sleeps.length).toBe(1)
  })

  test('stops on the first stop that is not the target, and hands that result on', async () => {
    const h = harness([result(), result('fill'), result()])
    h.player.play()
    await flush()
    await h.tick()
    expect(h.calls).toBe(2)
    expect(h.player.playing).toBe(false)
    expect(h.results.map((r) => r.reason)).toEqual(['target', 'fill'])
    await h.tick()
    expect(h.calls).toBe(2)
  })

  test('a step that could not start (busy) ends the play', async () => {
    const h = harness([null])
    h.player.play()
    await flush()
    expect(h.player.playing).toBe(false)
    expect(h.results).toEqual([])
  })

  test('a step that throws ends the play instead of looping on the error', async () => {
    const h = harness([new Error('network')])
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      h.player.play()
      await flush()
    } finally {
      console.error = original
    }
    expect(h.player.playing).toBe(false)
    expect(errors.length).toBe(1)
  })

  test('paused while a step runs: that step lands and is handed on, and no other follows', async () => {
    let release: (r: AdvanceResult) => void = () => {}
    const results: AdvanceResult[] = []
    let calls = 0
    const player = new ReplayPlayer({
      step: () => {
        calls++
        return new Promise((resolve) => (release = resolve))
      },
      onResult: (r) => results.push(r),
      sleep: async () => {}
    })
    player.play()
    player.pause()
    release(result('fill'))
    await flush()
    expect(results.map((r) => r.reason)).toEqual(['fill'])
    expect(calls).toBe(1)
  })

  test('a pause and a new play while the old loop sleeps leave exactly one loop', async () => {
    const h = harness()
    h.player.play()
    await flush()
    h.player.pause()
    h.player.play()
    await flush()
    expect(h.calls).toBe(2)
    // The first loop's sleep ends; it sees it was superseded and goes quietly.
    await h.tick()
    expect(h.calls).toBe(3)
    expect(h.sleeps.length).toBe(1)
  })

  test('the pace takes effect from the next wait, and a bad one is ignored', async () => {
    const h = harness()
    h.player.setDelay(0)
    h.player.setDelay(Number.NaN)
    expect(h.player.delayMs).toBe(500)
    h.player.play()
    await flush()
    h.player.setDelay(2000)
    await h.tick()
    expect(h.sleeps.map((s) => s.ms)).toEqual([2000])
  })

  test('the wait is for the pace AND the wall: whichever is later', async () => {
    let settle: () => void = () => {}
    let calls = 0
    const sleeps: Array<() => void> = []
    const player = new ReplayPlayer({
      step: async () => {
        calls++
        return result()
      },
      settled: () => new Promise((resolve) => (settle = resolve)),
      sleep: () => new Promise((resolve) => sleeps.push(resolve))
    })
    player.play()
    await flush()
    for (const s of sleeps.splice(0)) s()
    await flush()
    expect(calls).toBe(1)
    settle()
    await flush()
    expect(calls).toBe(2)
  })

  test('dispose ends a play without telling anyone', async () => {
    const h = harness()
    h.player.play()
    await flush()
    const before = h.changes
    h.player.dispose()
    await h.tick()
    expect(h.calls).toBe(1)
    expect(h.changes).toBe(before)
  })
})
