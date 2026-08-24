import { apiGet } from '../config'

// wdashboard-server's AREV research-prediction surface (services/arev.py): per-bar rows a
// hand-run research script persisted to the algo DB — nothing is computed on request, and
// there is no live stream. Deliberately not the `/indicators` surface: an AREV point is a
// vote with its provenance, where an indicator point is one number, and the two model
// generations are served side by side because that they disagree is the research interest.
//
// `p` is the point worth drawing: the k-NN prediction is a sum of ±1 votes over `n` past
// samples, so `p` is the share of them that rose — a probability, on the same scale in
// every year and on every interval. The running extrema this replaced (`max`/`min`, and the
// 0.9x bands drawn from them) are gone from the wire, because an all-time extremum
// freezes as history accumulates: on EURUSD 1h those bands produced 123 signals in 2010
// and none at all in 2024 or 2025.

// Every generation after arev19 changes one stated thing about it and nothing else, so
// drawing it beside arev19 is a controlled read on that thing: arev21 the gate (fresh
// price extremes instead of WMA crosses), arev22 the label (a fixed 10-bar body-midpoint
// move instead of the path to the next sample — which is what then lets its gate be a
// plain stride over the bars).
//
// arev22 is served from the Parquet store rather than the algo DB (it is the first
// generation written for that pipeline), so on a server running INDICATOR_BACKEND=postgres
// its pane simply finds no data.
export const AREV_GENERATIONS = ['arev19', 'arev20', 'arev21', 'arev22'] as const
export type ArevGeneration = (typeof AREV_GENERATIONS)[number]

export interface ArevPoint {
  date: number
  /** The raw ±1 vote sum over the k nearest past samples. */
  prediction: number
  /** How many samples the model's 5-year window held — the scale behind `prediction`. */
  n: number
  /**
   * `(prediction / n + 1) / 2` — the share of the k nearest past samples that rose, which
   * is P(whatever the generation was trained to answer): price rises from here to the
   * next sample for arev19/20/21, the body midpoint 10 bars ahead is higher for arev22.
   */
  p: number
  /** `|p - 0.5|`: how far from a coin flip the neighbourhood is. */
  confidence: number
  /**
   * Whether this bar is a sample point — a WMA cross for arev19/arev20, a fresh
   * lookback-bar extreme for arev21, the stride landing on it for arev22. The model is
   * fitted only on such bars and has no edge off one. The wire name is arev19's and is
   * kept across generations.
   */
  atCross: boolean
  /** The server's verdict: confident enough, on a sample bar, off a full window. */
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
