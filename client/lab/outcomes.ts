// WHAT HAPPENED AFTER EACH ENTRY -- the measure two versions of a rule are compared by before
// any trade management is assumed:
//
//   forward   the close N bars of the entry's own timeframe later, against the entry's close,
//             the trade's way, in pips and in ATRs
//   MFE/MAE   the furthest price went for and against it inside the longest horizon
//   touches   which of entry +k ATR (for it) and entry -k ATR (against it) price reached first,
//             for each k: a bar reaching both counts against (the fill engine's stop-first rule)
//
// Read on the PATH bars (the runner's path timeframe, which divides every entry's), from the bar
// that closes at the entry instant. Mid prices: spread belongs to the simulated trades.
//
// PURE.

import type { ReplayBar } from '../replay/cache'
import type { LabEntry } from './entries'
import type { OutcomeSpec } from './model'
import { lastAtOrBefore } from './sorted'

export interface Forward {
  bars: number
  pips: number | undefined
  atr: number | undefined
}

export type Touch = 'win' | 'loss' | 'open'

export interface EntryOutcome {
  entryPrice: number
  /** ATR(atrPeriod) of the entry's timeframe at the entry; undefined while it warms up. */
  atr: number | undefined
  forward: Forward[]
  mfePips: number
  maePips: number
  mfeAtr: number | undefined
  maeAtr: number | undefined
  touches: Array<{ k: number; result: Touch }>
}

export interface PathIndex {
  bars: readonly ReplayBar[]
  ends: number[]
  /** Nominal length of one path bar. */
  ms: number
}

export function pathIndex(bars: readonly ReplayBar[], ms: number): PathIndex {
  return { bars, ends: bars.map((b) => b.end), ms }
}

/** The outcome of one entry, or null when the path holds no bar closing at it. */
export function measureOutcome(entry: LabEntry, path: PathIndex, spec: OutcomeSpec, pip: number, atr: number | undefined): EntryOutcome | null {
  const i0 = lastAtOrBefore(path.ends, entry.at)
  // The path bar must close AT the entry: one closing earlier would price it before it existed.
  if (i0 < 0 || path.ends[i0] !== entry.at) return null
  const dir = entry.direction === 'long' ? 1 : -1
  const entryPrice = path.bars[i0].c
  const perBar = Math.max(1, Math.round(entry.signal.durationMs / path.ms))
  const horizons = [...spec.horizons].filter((h) => h >= 1).sort((a, b) => a - b)
  const longest = horizons.length > 0 ? horizons[horizons.length - 1] * perBar : perBar
  const last = Math.min(path.bars.length - 1, i0 + longest)
  const forward = horizons.map((h): Forward => {
    const i = i0 + h * perBar
    if (i >= path.bars.length) return { bars: h, pips: undefined, atr: undefined }
    const move = (path.bars[i].c - entryPrice) * dir
    return { bars: h, pips: move / pip, atr: atr ? move / atr : undefined }
  })
  let mfe = 0
  let mae = 0
  for (let i = i0 + 1; i <= last; i++) {
    const bar = path.bars[i]
    const forIt = dir > 0 ? bar.h - entryPrice : entryPrice - bar.l
    const against = dir > 0 ? entryPrice - bar.l : bar.h - entryPrice
    if (forIt > mfe) mfe = forIt
    if (against > mae) mae = against
  }
  const touches = spec.touches.map((k) => ({ k, result: touch(path, i0, last, entryPrice, dir, atr === undefined ? undefined : k * atr) }))
  return {
    entryPrice,
    atr,
    forward,
    mfePips: mfe / pip,
    maePips: mae / pip,
    mfeAtr: atr ? mfe / atr : undefined,
    maeAtr: atr ? mae / atr : undefined,
    touches
  }
}

function touch(path: PathIndex, i0: number, last: number, entry: number, dir: number, distance: number | undefined): Touch {
  if (distance === undefined || !(distance > 0)) return 'open'
  const win = entry + dir * distance
  const loss = entry - dir * distance
  for (let i = i0 + 1; i <= last; i++) {
    const bar = path.bars[i]
    const lost = dir > 0 ? bar.l <= loss : bar.h >= loss
    const won = dir > 0 ? bar.h >= win : bar.l <= win
    if (lost) return 'loss'
    if (won) return 'win'
  }
  return 'open'
}

// -- summary ------------------------------------------------------------------------------------

export interface HorizonSummary {
  bars: number
  n: number
  meanPips: number | null
  medianPips: number | null
  meanAtr: number | null
  /** Share of entries the trade's way at that horizon. */
  positive: number | null
}

export interface TouchSummary {
  k: number
  wins: number
  losses: number
  open: number
  /** wins / (wins + losses). */
  rate: number | null
}

export interface OutcomeSummary {
  n: number
  horizons: HorizonSummary[]
  touches: TouchSummary[]
  meanMfeAtr: number | null
  meanMaeAtr: number | null
  meanMfePips: number | null
  meanMaePips: number | null
}

const mean = (xs: number[]): number | null => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const defined = (xs: Array<number | undefined>): number[] => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))

export function summariseOutcomes(outcomes: readonly EntryOutcome[], spec: OutcomeSpec): OutcomeSummary {
  const horizons = [...spec.horizons].filter((h) => h >= 1).sort((a, b) => a - b)
  return {
    n: outcomes.length,
    horizons: horizons.map((bars, i) => {
      const pips = defined(outcomes.map((o) => o.forward[i]?.pips))
      return {
        bars,
        n: pips.length,
        meanPips: mean(pips),
        medianPips: median(pips),
        meanAtr: mean(defined(outcomes.map((o) => o.forward[i]?.atr))),
        positive: pips.length > 0 ? pips.filter((p) => p > 0).length / pips.length : null
      }
    }),
    touches: spec.touches.map((k, i) => {
      const results = outcomes.map((o) => o.touches[i]?.result)
      const wins = results.filter((r) => r === 'win').length
      const losses = results.filter((r) => r === 'loss').length
      return { k, wins, losses, open: results.length - wins - losses, rate: wins + losses > 0 ? wins / (wins + losses) : null }
    }),
    meanMfeAtr: mean(defined(outcomes.map((o) => o.mfeAtr))),
    meanMaeAtr: mean(defined(outcomes.map((o) => o.maeAtr))),
    meanMfePips: mean(outcomes.map((o) => o.mfePips)),
    meanMaePips: mean(outcomes.map((o) => o.maePips))
  }
}
