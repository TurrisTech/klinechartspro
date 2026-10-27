import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// Where each MTF mark goes beside its candle: stacked on its own bar, and moved outward past a
// mark on a nearby bar whose label it would print over -- a label is several 5m bars wide.
installWindow()
const { placeMarks } = await import('./templates')
import type { MarkRoom } from './templates'

const INSET = 6
const H = 30
const room = (x: number, edge: number, above = false, halfWidth = 20): MarkRoom => ({ x, edge, above, halfWidth, height: H })

describe('placeMarks', () => {
  test("one bar's marks stack outward, as before", () => {
    expect(placeMarks([room(100, 200), room(100, 200), room(100, 200)])).toEqual([INSET, INSET + H, INSET + 2 * H])
  })

  test('a label that would cross a neighbour on the next bar moves outward past it', () => {
    // Bars 6 px apart, labels 40 px wide, lows at the same height.
    expect(placeMarks([room(100, 200), room(106, 200)])).toEqual([INSET, INSET + H])
  })

  test('marks far enough apart keep their places', () => {
    expect(placeMarks([room(100, 200), room(141, 200)])).toEqual([INSET, INSET])
  })

  test('a neighbour hanging from a different height is not in the way', () => {
    // The second bar's low is a whole mark further down: its own mark already clears the first.
    expect(placeMarks([room(100, 200), room(106, 200 + H)])).toEqual([INSET, INSET])
  })

  test('a neighbour only partly in the way moves just far enough', () => {
    // 10 px lower, so its room starts 10 px inside the first one's.
    expect(placeMarks([room(100, 200), room(106, 210)])).toEqual([INSET, INSET + H - 10])
  })

  test('above the candle the same, mirrored', () => {
    expect(placeMarks([room(100, 200, true), room(106, 200, true), room(106, 200, true)])).toEqual([INSET, INSET + H, INSET + 2 * H])
  })

  test('marks on the two sides do not push each other', () => {
    expect(placeMarks([room(100, 200), room(106, 150, true)])).toEqual([INSET, INSET])
  })

  test('a run of crowded bars becomes a staircase, and the nearest mark to a candle keeps its place', () => {
    const offsets = placeMarks([0, 1, 2, 3].map((k) => room(100 + 6 * k, 200)))
    expect(offsets).toEqual([INSET, INSET + H, INSET + 2 * H, INSET + 3 * H])
  })

  test('a mark is checked against everything still in reach, not only its neighbour', () => {
    // The first bar's mark is 12 px left of the third's -- still in reach -- and the second
    // bar's hangs from a lower low.
    const offsets = placeMarks([room(100, 200), room(106, 240), room(112, 200)])
    expect(offsets[0]).toBe(INSET)
    expect(offsets[1]).toBe(INSET)
    // At INSET the third crosses the first; moved past it, it lands inside the second's room
    // (from 240 + INSET), so it moves again, past that one too.
    expect(offsets[2]).toBe(240 + INSET + H - 200)
  })
})
