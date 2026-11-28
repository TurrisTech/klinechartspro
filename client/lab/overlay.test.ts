import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// THE RUNS THE OVERLAY DRAWS (overlay.ts `publishRun` / `publishedRun`): a page files each run
// under a key and the `LAB:strategy` template reads it back by the key in its extendData. A pane
// publishes under a new key whenever it moves to another strategy, instrument or trades setting,
// and nothing says when an old key stops being drawn -- so the registry is bounded, least recently
// used out first, and a run still being drawn is never the one that goes.
installWindow()
const { publishRun, publishedRun } = await import('./overlay')

import type { LabRun } from './runner'

/** A run as the registry sees it: anything, under a name to tell it by. */
const run = (name: string): LabRun => ({ symbol: name }) as unknown as LabRun

/** A key as a dashboard pane's store makes one (lab/plugin.ts). */
const paneKey = (i: number): string => `lab|test-${i}|oanda:EURUSD|nosim`

describe('the published runs', () => {
  test('do not pile up over a sequence of distinct runs, and one still drawn is still served', () => {
    publishRun('test-lab-page', run('drawn'))
    for (let i = 0; i < 1000; i++) {
      publishRun(paneKey(i), run(`run ${i}`))
      // The pane still showing its run reads it at each of its redraws (the template's `calc`).
      expect(publishedRun('test-lab-page')?.symbol).toBe('drawn')
    }
    const held = Array.from({ length: 1000 }, (_, i) => publishedRun(paneKey(i))).filter((r) => r !== null)
    expect(held.length).toBeLessThanOrEqual(64)
    expect(publishedRun(paneKey(999))?.symbol).toBe('run 999')
    expect(publishedRun(paneKey(0))).toBeNull()
    expect(publishedRun('test-lab-page')?.symbol).toBe('drawn')
  })

  test('a run published again every minute, as a pane re-runs its strategy, stays served', () => {
    publishRun('test-refreshed', run('refreshed'))
    for (let i = 0; i < 1000; i++) {
      publishRun(paneKey(i), run(`run ${i}`))
      if (i % 10 === 0) publishRun('test-refreshed', run('refreshed'))
    }
    expect(publishedRun('test-refreshed')?.symbol).toBe('refreshed')
  })

  test('null clears a run', () => {
    publishRun('test-cleared', run('cleared'))
    publishRun('test-cleared', null)
    expect(publishedRun('test-cleared')).toBeNull()
    expect(publishedRun(null)).toBeNull()
  })
})
