import { describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'
import { DecodedTiles } from './cache'

const bars = (n: number): KLineData[] =>
  Array.from({ length: n }, (_, i) => ({ timestamp: i, open: 1, high: 1, low: 1, close: 1 }))

describe('DecodedTiles', () => {
  test('evicts the least recently used tile once the bar bound is passed', () => {
    const cache = new DecodedTiles(10)
    cache.set('a', bars(4))
    cache.set('b', bars(4))
    expect(cache.get('a')?.length).toBe(4) // a is now the most recent
    cache.set('c', bars(4))
    expect(cache.has('b')).toBe(false)
    expect(cache.has('a')).toBe(true)
    expect(cache.has('c')).toBe(true)
    expect(cache.bars).toBe(8)
  })

  test('keeps a single tile larger than the bound while it is the one in use', () => {
    const cache = new DecodedTiles(10)
    cache.set('a', bars(3))
    cache.set('big', bars(25))
    expect(cache.has('a')).toBe(false)
    expect(cache.has('big')).toBe(true)
    expect(cache.bars).toBe(25)
  })

  test('re-setting a tile replaces its count rather than adding to it', () => {
    const cache = new DecodedTiles(10)
    cache.set('a', bars(4))
    cache.set('a', bars(6))
    expect(cache.bars).toBe(6)
  })
})
