import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { AlertHit, AlertSearch, SearchOptions } from '../alerts/search'
import type { Alert } from '../alerts/types'

// THE LOOK-AHEAD: the session asks for the next alert as soon as an advance lands, and a Next
// alert pressed later takes that answer instead of searching. These hold when an answer may be
// reused -- the same alerts, an `after` at or past where it searched and short of what it found
// -- and that a Stop, an edit or a superseding search never leaves a wrong one behind.

installWindow()
const { ReplayAlerts } = await import('./alerts')

const H = 3_600_000

function alert(id: string, rule: unknown = { left: { kind: 'bar', interval: '1h', field: 'close' }, op: '>', right: { value: 1 } }): Alert {
  return {
    id, kind: 'client', name: id, note: '', enabled: true, symbol: 'oanda:EURUSD', rule: rule as Alert['rule'],
    trigger: 'level', repeat: 'always', cooldownMs: 0, createdAt: 0, updatedAt: 0, armedAt: 0, status: 'armed', lastFiredAt: null, fireCount: 0
  }
}

/** A search that triggers at fixed instants, counting its calls; `gate` holds each call open
 * until the test releases it. */
class FakeSearch {
  calls: Array<{ after: number; until: number }> = []
  running = 0
  maxRunning = 0
  gate: Promise<void> | null = null
  constructor(private readonly at: number[]) {}
  async next(a: Alert, after: number, until: number, options: SearchOptions = {}): Promise<AlertHit | null> {
    this.calls.push({ after, until })
    this.running++
    this.maxRunning = Math.max(this.maxRunning, this.running)
    try {
      options.onProgress?.(after + H)
      if (this.gate) await this.gate
      if (options.shouldStop?.()) return null
      const hit = this.at.find((t) => t > after && t <= until)
      return hit === undefined ? null : { alert: a, at: hit, instant: { at: hit, observation: {} } as never }
    } finally {
      this.running--
    }
  }
}

const progress = (stop = () => false) => ({ reached: [] as number[], shouldStop: stop, onProgress(r: number) { this.reached.push(r) } })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function book(at: number[], list: Alert[] = [alert('a')]) {
  const search = new FakeSearch(at)
  const alerts = { list }
  const replay = new ReplayAlerts('oanda:EURUSD', () => alerts.list, search as unknown as AlertSearch)
  return { replay, search, alerts }
}

describe('ReplayAlerts look-ahead', () => {
  test('a Next alert after the look-ahead takes its answer without searching again', async () => {
    const { replay, search } = book([5 * H, 9 * H])
    replay.prefetch(0, 100 * H)
    await settle()
    expect(search.calls).toHaveLength(1)
    expect((await replay.next(0, 100 * H, progress()))?.effective).toBe(5 * H)
    expect(search.calls).toHaveLength(1)
  })

  test('still good from a later cursor short of the hit; not from one at or past it', async () => {
    const { replay, search } = book([5 * H, 9 * H])
    replay.prefetch(0, 100 * H)
    expect((await replay.next(2 * H, 100 * H, progress()))?.effective).toBe(5 * H)
    expect(search.calls).toHaveLength(1)
    expect((await replay.next(5 * H, 100 * H, progress()))?.effective).toBe(9 * H)
    expect(search.calls).toHaveLength(2)
    expect(search.calls[1].after).toBe(5 * H)
  })

  test('nothing ahead is an answer too, from any later cursor with the same end', async () => {
    const { replay, search } = book([])
    replay.prefetch(0, 100 * H)
    expect(await replay.next(3 * H, 100 * H, progress())).toBeNull()
    expect(search.calls).toHaveLength(1)
    // A different end is a different question.
    expect(await replay.next(3 * H, 200 * H, progress())).toBeNull()
    expect(search.calls).toHaveLength(2)
  })

  test('an edited rule, or another alert switched on, makes it stale', async () => {
    const { replay, search, alerts } = book([5 * H])
    replay.prefetch(0, 100 * H)
    await replay.next(0, 100 * H, progress())
    alerts.list = [alert('a', { left: { kind: 'bar', interval: '1h', field: 'close' }, op: '<', right: { value: 1 } })]
    await replay.next(0, 100 * H, progress())
    alerts.list = [...alerts.list, alert('b')]
    await replay.next(0, 100 * H, progress())
    expect(search.calls).toHaveLength(3 + 1) // one search per alert for the two-alert list
  })

  test('a press while it runs waits for it, and sees its progress', async () => {
    const { replay, search } = book([5 * H])
    let release = () => {}
    search.gate = new Promise((resolve) => {
      release = resolve
    })
    replay.prefetch(0, 100 * H)
    const p = progress()
    const answer = replay.next(0, 100 * H, p)
    await settle()
    expect(p.reached).toEqual([H])
    release()
    expect((await answer)?.effective).toBe(5 * H)
    expect(search.calls).toHaveLength(1)
  })

  test("a Stop while waiting stops it, and its null is not kept as 'nothing ahead'", async () => {
    const { replay, search } = book([5 * H])
    let release = () => {}
    search.gate = new Promise((resolve) => {
      release = resolve
    })
    replay.prefetch(0, 100 * H)
    let stop = false
    const answer = replay.next(0, 100 * H, progress(() => stop))
    stop = true
    release()
    expect(await answer).toBeNull()
    search.gate = null
    // Searched again, not answered from the stopped one.
    const before = search.calls.length
    expect((await replay.next(0, 100 * H, progress()))?.effective).toBe(5 * H)
    expect(search.calls).toHaveLength(before + 1)
  })

  test('one search at a time: a superseded look-ahead is stopped before the next starts', async () => {
    const { replay, search } = book([5 * H, 50 * H])
    let release = () => {}
    search.gate = new Promise((resolve) => {
      release = resolve
    })
    replay.prefetch(0, 100 * H)
    await settle()
    // The cursor stepped past what that one will find: a new one, from there.
    replay.prefetch(10 * H, 100 * H)
    release()
    search.gate = null
    expect((await replay.next(10 * H, 100 * H, progress()))?.effective).toBe(50 * H)
    expect(search.maxRunning).toBe(1)
  })
})
