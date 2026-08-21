import { apiGet } from '../config'

// wdashboard-server's AREV research-prediction surface (services/arev.py): per-bar rows a
// hand-run research script persisted to the algo DB — nothing is computed on request, and
// there is no live stream. Deliberately not the `/indicators` surface: an AREV point is a
// vote with its provenance, where an indicator point is one number, and the two model
// generations are served side by side because that they disagree is the research interest.
//
// `p` is the point worth drawing: the k-NN prediction is a sum of ±1 votes over `n` past
// legs, so `p` is the share of them that rose — a probability, on the same scale in every
// year and on every interval. The running extrema this replaced (`max`/`min`, and the
// 0.9x bands drawn from them) are gone from the wire, because an all-time extremum
// freezes as history accumulates: on EURUSD 1h those bands produced 123 signals in 2010
// and none at all in 2024 or 2025.

export const AREV_GENERATIONS = ['arev19', 'arev20'] as const
export type ArevGeneration = (typeof AREV_GENERATIONS)[number]

export interface ArevPoint {
  date: number
  /** The raw ±1 vote sum over the k nearest past legs. */
  prediction: number
  /** How many legs the model's 5-year window actually held — the scale behind `prediction`. */
  n: number
  /** P(this leg rises): `(prediction / n + 1) / 2`. */
  p: number
  /** `|p - 0.5|`: how far from a coin flip the neighbourhood is. */
  confidence: number
  /** Whether the bar opened a leg. The model is fitted on legs and has no edge off one. */
  atCross: boolean
  /** The server's verdict: confident enough, on a cross bar, off a full window. */
  signal: boolean
}

export type ArevValuesResult =
  | { s: 'ok'; generation: string; points: ArevPoint[] }
  | { s: 'no_data'; generation: string }

export async function fetchArevValues(
  vendorSymbol: string,
  resolution: string,
  generation: ArevGeneration,
  from: number,
  to: number,
  limit: number | null
): Promise<ArevValuesResult> {
  return apiGet<ArevValuesResult>('/arev/values', {
    symbol: vendorSymbol,
    resolution,
    generation,
    from,
    to,
    limit: limit ?? undefined
  })
}
