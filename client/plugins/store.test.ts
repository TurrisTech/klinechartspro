import { describe, expect, test } from 'bun:test'
import { dropStore, mergeRange, missingRanges, peekStore, storeFor, WindowStore } from './store'

describe('missingRanges / mergeRange', () => {
  test('an uncovered window is missing whole', () => {
    expect(missingRanges([], { from: 10, to: 20 })).toEqual([{ from: 10, to: 20 }])
  })
  test('a covered window is missing nothing', () => {
    expect(missingRanges([{ from: 0, to: 30 }], { from: 10, to: 20 })).toEqual([])
  })
  test('a window straddling a fetched one is missing both ends, in order', () => {
    expect(missingRanges([{ from: 12, to: 15 }], { from: 10, to: 20 })).toEqual([
      { from: 10, to: 12 },
      { from: 15, to: 20 }
    ])
  })
  test('touching ranges merge', () => {
    expect(mergeRange([{ from: 0, to: 10 }], { from: 10, to: 20 })).toEqual([{ from: 0, to: 20 }])
    expect(mergeRange([{ from: 0, to: 5 }], { from: 10, to: 20 })).toEqual([
      { from: 0, to: 5 },
      { from: 10, to: 20 }
    ])
  })
})

describe('WindowStore', () => {
  test('ingest records the window and bumps rev; set does not record a window', () => {
    const s = new WindowStore<{ date: number; v: number }>('k')
    expect(s.rev).toBe(0)
    s.ingest([{ date: 1, v: 1 }], { from: 0, to: 10 })
    expect(s.rev).toBe(1)
    expect(s.missing({ from: 0, to: 10 })).toEqual([])
    s.set({ date: 20, v: 2 })
    expect(s.values.get(20)).toEqual({ date: 20, v: 2 })
    expect(s.missing({ from: 15, to: 25 })).toEqual([{ from: 15, to: 25 }])
    expect(s.latest()).toBe(20)
  })
  test('the index function folds points that share a bar', () => {
    const s = new WindowStore<{ date: number; side: 'top' | 'bottom' }, Partial<Record<'top' | 'bottom', boolean>>>(
      'k',
      (p, existing) => ({ ...(existing ?? {}), [p.side]: true })
    )
    s.ingest(
      [
        { date: 1, side: 'top' },
        { date: 1, side: 'bottom' }
      ],
      { from: 0, to: 2 }
    )
    expect(s.values.get(1)).toEqual({ top: true, bottom: true })
  })
  test('setPhase is a no-op when nothing changes', () => {
    const s = new WindowStore<{ date: number }>('k')
    s.setPhase('ready')
    const rev = s.rev
    s.setPhase('ready')
    expect(s.rev).toBe(rev)
    s.setPhase('error', null, 'boom')
    expect(s.rev).toBe(rev + 1)
    expect(s.error).toBe('boom')
  })
})

describe('the store registry', () => {
  test('storeFor creates once and peekStore finds it until dropped', () => {
    const a = storeFor('reg-1', (k) => new WindowStore<{ date: number }>(k))
    const b = storeFor('reg-1', (k) => new WindowStore<{ date: number }>(k))
    expect(a).toBe(b)
    expect(peekStore('reg-1')).toBe(a)
    dropStore('reg-1')
    expect(peekStore('reg-1')).toBeUndefined()
    expect(peekStore(undefined)).toBeUndefined()
  })
})
