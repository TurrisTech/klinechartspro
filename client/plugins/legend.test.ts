import { describe, expect, test } from 'bun:test'
import { phaseLabel } from './legend'
import type { SourceStore } from './types'

const store = (phase: SourceStore['phase'], progress: number | null = null) => ({ phase, progress }) as unknown as SourceStore

describe('phaseLabel', () => {
  // The legend's warning beside the × says it, and its card says why (user, 2026-11-26: "just put
  // it once at the end next to the X"): the text no longer ends in "· error", which a narrow pane
  // cut off first.
  test('an error leaves the name alone', () => {
    expect(phaseLabel('AREV21 MTF', [store('ready'), store('error')])).toBe('AREV21 MTF')
  })

  test('loading, computing and queued still say so, the worst first; ready says nothing', () => {
    expect(phaseLabel('X', [store('ready'), undefined])).toBe('X · loading')
    expect(phaseLabel('X', [store('replaying', 0.4)])).toBe('X · computing 40%')
    expect(phaseLabel('X', [store('queued')])).toBe('X · queued')
    expect(phaseLabel('X', [store('ready')])).toBeNull()
  })
})
