import { hasFeature } from '../capabilities'
import { apiGet, apiUrl, OhlcvApiError } from '../config'
import type { Page, PointsRequest } from './types'

// The unified plugin wire (wdashboard_server/plugins/host.py):
//
//   GET /plugins                          the catalogue
//   GET /plugins/{id}/values?symbol&resolution&from&to&limit[&variant][&params]
//
// with the `{ s: 'ok' | 'no_data' | 'replaying', points, ... }` envelope every values route
// on this server shares. A server from before the host (no `plugins` feature) is asked on
// the plugin's legacy path instead, with the same envelope -- the paths are aliases of
// each other server-side, so a client gets one fetch whichever it is talking to.

export interface PluginCatalogueEntry {
  id: string
  kind: 'points' | 'series' | 'entities'
  feature: string | null
  title: string
  description: string
  variants: string[]
  available: boolean
  [extra: string]: unknown
}

export interface PluginCatalogue {
  plugins: PluginCatalogueEntry[]
  serverTime: number
}

let catalogue: Promise<PluginCatalogue> | null = null

export function loadPluginCatalogue(): Promise<PluginCatalogue> {
  if (!catalogue) {
    catalogue = apiGet<PluginCatalogue>('/plugins').catch((err) => {
      catalogue = null
      throw err
    })
  }
  return catalogue
}

export type PointsEnvelope<P> =
  | { s: 'ok'; points: P[]; [extra: string]: unknown }
  | { s: 'no_data'; [extra: string]: unknown }
  | { s: 'replaying'; phase?: string; progress: number | null; retryAfterMs: number; [extra: string]: unknown }

export async function fetchEnvelope<P>(url: URL): Promise<PointsEnvelope<P>> {
  const response = await fetch(url)
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    const b = body as { code?: string; detail?: string; field?: string } | null
    throw new OhlcvApiError(response.status, b?.code ?? 'internal', b?.detail ?? `${response.status} from ${url.pathname}`, b?.field)
  }
  return body as PointsEnvelope<P>
}

/** Turn an envelope into the host's page: a capped `ok` continues from its last point. */
export function toPage<P extends { date: number }>(
  envelope: PointsEnvelope<P>,
  limit: number,
  onEnvelope?: (envelope: PointsEnvelope<P>) => void
): Page<P> {
  onEnvelope?.(envelope)
  if (envelope.s === 'replaying') {
    return {
      points: [],
      nextFrom: null,
      status: {
        phase: envelope.phase === 'queued' ? 'queued' : 'replaying',
        progress: envelope.progress ?? null,
        retryAfterMs: envelope.retryAfterMs
      }
    }
  }
  if (envelope.s === 'no_data') return { points: [], nextFrom: null }
  const points = envelope.points
  const last = points[points.length - 1]
  const full = points.length >= limit
  return { points, nextFrom: full && last ? last.date + 1 : null }
}

export function pointsUrl(request: PointsRequest): URL {
  const unified = hasFeature('plugins') || !request.legacyPath
  if (unified) {
    return apiUrl(`/plugins/${request.pluginId}/values`, {
      symbol: request.vendorSymbol,
      resolution: request.resolution,
      from: request.from,
      to: request.to,
      limit: request.limit,
      variant: request.variant,
      params: request.params ? JSON.stringify(request.params) : undefined
    })
  }
  return apiUrl(request.legacyPath as string, {
    symbol: request.vendorSymbol,
    resolution: request.resolution,
    from: request.from,
    to: request.to,
    limit: request.limit,
    ...(request.legacyQuery ?? {})
  })
}

/** The facilities' `points`: one fetch for every plugin, paged by the host. */
export async function fetchPoints<P extends { date: number }>(
  request: PointsRequest,
  onEnvelope?: (envelope: PointsEnvelope<P>) => void
): Promise<Page<P>> {
  return toPage(await fetchEnvelope<P>(pointsUrl(request)), request.limit, onEnvelope)
}
