import { apiGet } from '../config'

// wdashboard-server's AREV research-prediction surface (services/arev.py): per-bar rows a
// hand-run research script persisted to the algo DB — nothing is computed on request, and
// there is no live stream. Deliberately not the `/indicators` surface: an AREV point is
// three values (the k-NN prediction and its running extrema), where an indicator point is
// one, and the two model generations are served side by side because that they disagree is
// the research interest.

export const AREV_GENERATIONS = ['arev19', 'arev20'] as const
export type ArevGeneration = (typeof AREV_GENERATIONS)[number]

export interface ArevPoint {
  date: number
  prediction: number
  max: number
  min: number
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
