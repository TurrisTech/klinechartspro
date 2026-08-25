import { describe, expect, test } from 'bun:test'
import type { SignalCatalogueEntry } from '../plugins/types'
import { SignalBook, type SignalHit, type SignalSource } from './signals'

const H = 3_600_000
const catalogue: SignalCatalogueEntry[] = [
  { plugin: 'arev', title: 'AREV', variant: 'arev21', available: true, id: 'long', label: 'Long', side: 'long', description: '', ref: 'arev:arev21:long' },
  { plugin: 'arev', title: 'AREV', variant: 'arev21', available: true, id: 'short', label: 'Short', side: 'short', description: '', ref: 'arev:arev21:short' },
  { plugin: 'krev', title: 'krev', variant: 'krev01', available: true, id: 'top', label: 'Top', side: 'short', description: '', ref: 'krev:krev01:top' }
]

class FakeSource implements SignalSource {
  calls: Array<{ ref: string; resolution: string; from: number; to: number }> = []
  constructor(private hits: Record<string, SignalHit[]>) {}
  async points(ref: string, _symbol: string, resolution: string, from: number, to: number): Promise<SignalHit[]> {
    this.calls.push({ ref, resolution, from, to })
    return (this.hits[`${ref}@${resolution}`] ?? []).filter((h) => h.date >= from && h.date < to)
  }
}

describe('SignalBook', () => {
  test('star and arm are separate sets; arming stars, unstarring disarms', () => {
    const book = new SignalBook(catalogue, new FakeSource({}))
    book.star('arev:arev21:long')
    expect(book.isStarred('arev:arev21:long')).toBe(true)
    expect(book.isArmed('arev:arev21:long')).toBe(false)
    book.arm('krev:krev01:top', '1h')
    expect(book.isStarred('krev:krev01:top')).toBe(true)
    expect(book.isArmed('krev:krev01:top', '1h')).toBe(true)
    expect(book.isArmed('krev:krev01:top', '4h')).toBe(false)
    book.star('krev:krev01:top', false)
    expect(book.isArmed('krev:krev01:top')).toBe(false)
    expect(book.armed).toEqual([])
  })

  test('nextSignalAt is the earliest armed occurrence effective strictly after the cursor', async () => {
    const t0 = 1_700_000_000_000
    const source = new FakeSource({
      'arev:arev21:long@1h': [
        { date: t0 - H, effective: t0 }, // at the cursor: not after it
        { date: t0 + 2 * H, effective: t0 + 3 * H },
        { date: t0 + 9 * H, effective: t0 + 10 * H }
      ],
      'krev:krev01:top@1h': [{ date: t0 + H, effective: t0 + 2 * H }]
    })
    const book = new SignalBook(catalogue, source)
    book.arm('arev:arev21:long', '1h')
    expect(await book.nextSignalAt('oanda:EURUSD', t0, t0 + 24 * H)).toEqual({
      ref: 'arev:arev21:long',
      resolution: '1h',
      effective: t0 + 3 * H,
      date: t0 + 2 * H
    })
    book.arm('krev:krev01:top', '1h')
    expect((await book.nextSignalAt('oanda:EURUSD', t0, t0 + 24 * H))?.ref).toBe('krev:krev01:top')
    // Bounded by `until`.
    expect(await book.nextSignalAt('oanda:EURUSD', t0 + 3 * H, t0 + 9 * H)).toBeNull()
    expect((await book.nextSignalAt('oanda:EURUSD', t0 + 3 * H, t0 + 10 * H))?.effective).toBe(t0 + 10 * H)
  })

  test('fetches once with a look-ahead and answers later queries from coverage', async () => {
    const t0 = 1_700_000_000_000
    const source = new FakeSource({ 'arev:arev21:long@1h': [{ date: t0 + 5 * H, effective: t0 + 6 * H }] })
    const book = new SignalBook(catalogue, source)
    book.arm('arev:arev21:long', '1h')
    await book.nextSignalAt('x', t0, t0 + H)
    await book.nextSignalAt('x', t0 + H, t0 + 2 * H)
    await book.nextSignalAt('x', t0 + 2 * H, t0 + 100 * H)
    expect(source.calls.length).toBe(1)
    expect(source.calls[0].from).toBeLessThanOrEqual(t0 - H)
    expect(await book.nextSignalAt('x', t0 + 2 * H, t0 + 100 * H)).toMatchObject({ effective: t0 + 6 * H })
    book.reset()
    await book.nextSignalAt('x', t0, t0 + H)
    expect(source.calls.length).toBe(2)
  })

  test('setArmed restores a persisted set', () => {
    const book = new SignalBook(catalogue, new FakeSource({}))
    book.setArmed([
      { ref: 'arev:arev21:long', resolution: '1h' },
      { ref: 'arev:arev21:long', resolution: '4h' }
    ])
    expect(book.armed.length).toBe(2)
    expect(book.isStarred('arev:arev21:long')).toBe(true)
  })
})
