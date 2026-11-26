import { describe, expect, test } from 'bun:test'
import { installWindow } from './testing'

// The published-signals contract as the client consumes it: the AREV pane reads the server's
// label rather than restating its rule. (The MTF overlays read the label off `GET /mtf/graph`,
// where the server put it: client/mtf/values.test.ts.)
installWindow()
const { matches } = await import('../tsregistry/api')

import type { ArevPoint } from '../arev/api'

const point = (over: Partial<ArevPoint>): ArevPoint => ({
  date: 0,
  prediction: 0,
  n: 200,
  p: 0.5,
  confidence: 0,
  atCross: true,
  signal: null,
  ...over
})

describe('the label is read, not re-derived', () => {
  test('the AREV pane marks exactly the labelled bars, whatever p did between them', () => {
    // The registry row's marks, as wtradingindicators declares them: each selects on the
    // server's published label, never on where p happens to sit. p is above the band on
    // both of the first two bars -- the old crossing rule drew one arrow (a red one), the
    // label rule draws a green one on the labelled bar and none on the unlabelled.
    const up = { field: 'signal', eq: 'long' }
    const down = { field: 'signal', eq: 'short' }
    expect(matches(up, point({ p: 0.6, signal: 'long' }))).toBe(true)
    expect(matches(up, point({ p: 0.62, signal: null }))).toBe(false)
    expect(matches(down, point({ p: 0.62, signal: null }))).toBe(false)
    expect(matches(down, point({ p: 0.4, signal: 'short' }))).toBe(true)
    expect(matches(up, undefined)).toBe(false)
  })
})
