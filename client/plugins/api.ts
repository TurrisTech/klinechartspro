import type { TileHint } from '../indicatortiles/index'
import { hasFeature } from '../capabilities'
import { apiGet, apiUrl, OhlcvApiError } from '../config'
import type { Page, PointsRequest, SignalCatalogueEntry, SignalSpec } from './types'

// The unified plugin wire (wdashboard_server/plugins/host.py):
//
//   GET /plugins                          the catalogue
//   GET /plugins/{id}/values?symbol&resolution&from&to&limit[&variant][&params]
//   GET /plugins/signals                  every published signal label, with its ref
//   GET /plugins/{id}/signals?...[&signal]  only the labelled points, each with `effective`
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
  /** The labels this plugin publishes; empty for a continuous series. */
  signals?: SignalSpec[]
  /** Whether the server pushes this plugin's points over `/stream` (feature `plugins.live`). */
  live?: boolean
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

let signalCatalogue: Promise<SignalCatalogueEntry[]> | null = null

/** `GET /plugins/signals`, once per page; empty on a server without the feature. */
export function loadSignalCatalogue(): Promise<SignalCatalogueEntry[]> {
  if (!signalCatalogue) {
    signalCatalogue = hasFeature('plugins.signals')
      ? apiGet<{ signals: SignalCatalogueEntry[] }>('/plugins/signals')
          .then((r) => r.signals)
          .catch((err) => {
            signalCatalogue = null
            throw err
          })
      : Promise.resolve([])
  }
  return signalCatalogue
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
export function toPage<P extends { date: number }>(envelope: PointsEnvelope<P>, limit: number, arrays?: readonly string[]): Page<P> {
  // A requested array always appears on the page, even on an envelope that carries none:
  // `no_data`, a replaying server, or one too old to know the name. The plugin then reads
  // an empty array instead of `undefined`, which is the honest answer in every case.
  const extra = arrays?.length
    ? { arrays: Object.fromEntries(arrays.map((name) => [name, readArray(envelope, name)])) }
    : {}
  if (envelope.s === 'replaying') {
    return {
      points: [],
      nextFrom: null,
      status: {
        phase: envelope.phase === 'queued' ? 'queued' : 'replaying',
        progress: envelope.progress ?? null,
        retryAfterMs: envelope.retryAfterMs
      },
      ...extra
    }
  }
  if (envelope.s === 'no_data') return { points: [], nextFrom: null, ...extra }
  const points = envelope.points
  const last = points[points.length - 1]
  const full = points.length >= limit
  const hint = (envelope as { tiles?: TileHint }).tiles
  if (hint !== undefined && typeof hint?.path === 'string') {
    return { points, nextFrom: full && last ? last.date + 1 : null, ...extra, tiles: hint }
  }
  // `nextFrom` is driven by `points` alone. An auxiliary array is a different kind of row,
  // not more of the same one, so it has no cursor of its own -- the server caps each array
  // independently and a capped `points` is what tells the host to come back for more.
  return { points, nextFrom: full && last ? last.date + 1 : null, ...extra }
}

/** One auxiliary array off an envelope, defensively: anything that is not an array of
 * dated rows reads as empty rather than reaching a template as garbage. */
function readArray(envelope: PointsEnvelope<unknown>, name: string): { date: number }[] {
  const value = (envelope as Record<string, unknown>)[name]
  if (!Array.isArray(value)) return []
  return value.filter((row): row is { date: number } => typeof (row as { date?: unknown })?.date === 'number')
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
      params: request.params ? JSON.stringify(request.params) : undefined,
      ...(request.asof !== undefined ? { asof: request.asof } : {})
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
export async function fetchPoints<P extends { date: number }>(request: PointsRequest): Promise<Page<P>> {
  return toPage(await fetchEnvelope<P>(pointsUrl(request)), request.limit, request.arrays)
}
