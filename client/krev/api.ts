import { apiGet } from '../config'

// wdashboard-server's krev01 surface (services/krev.py): per-candidate rows a hand-run
// research script persisted to the algo DB — nothing is computed on request, and there is
// no live stream. krev01 is a k-NN asked, at every bar that prints a fresh extreme, whether
// that extreme holds: whether price retraces a set number of ATRs from the bar's close
// before the extreme is taken out. Each row is that vote, and — once the label is known,
// up to the model's horizon later — what then happened.

export const KREV_GENERATION = 'krev01'

export type KrevSide = 'top' | 'bottom'
export type KrevOutcome = 'held' | 'failed'

export interface KrevPoint {
  date: number
  side: KrevSide
  /** The raw ±1 vote sum over the k nearest past candidates. */
  prediction: number
  /** How many candidates the model's 5-year window held — the scale behind `prediction`. */
  n: number
  /** P(this extreme holds): `(prediction / n + 1) / 2`. */
  p: number
  /** The extreme itself (the bar's high for a top, low for a bottom): where the marker sits. */
  extreme: number
  close: number
  atr: number
  /** The server's verdict: `p` at or above its threshold, off a full window. */
  signal: boolean
  /** Null while the candidate is still in play. */
  outcome: KrevOutcome | null
  resolvedAt: number | null
  /** The furthest favourable excursion before resolution, in ATRs. */
  excursion: number | null
}

export type KrevValuesResult =
  | { s: 'ok'; generation: string; points: KrevPoint[] }
  | { s: 'no_data'; generation: string }

export async function fetchKrevValues(
  vendorSymbol: string,
  resolution: string,
  from: number,
  to: number,
  limit: number | null
): Promise<KrevValuesResult> {
  return apiGet<KrevValuesResult>('/krev/values', {
    symbol: vendorSymbol,
    resolution,
    from,
    to,
    limit: limit ?? undefined
  })
}
