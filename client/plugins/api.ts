import { hasFeature } from '../capabilities'
import { apiGet, apiUrl, OhlcvApiError } from '../config'
import type { Page, PointsRequest, SignalCatalogueEntry, SignalPoint, SignalSpec, SignalsRequest } from './types'

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

/** `plugin:variant:id` -- the server's `signal_ref`; the variant part empty when the
 * plugin has none, the id part empty for "every label". */
export function signalRef(plugin: string, variant: string | null | undefined, id = ''): string {
  return `${plugin}:${variant ?? ''}:${id}`
}

export function parseSignalRef(ref: string): { plugin: string; variant: string | null; id: string } {
  const parts = ref.split(':')
  if (parts.length !== 3 || !parts[0]) throw new Error(`not a signal ref: ${ref} (want plugin:variant:id)`)
  return { plugin: parts[0], variant: parts[1] || null, id: parts[2] }
}

export function signalsUrl(request: SignalsRequest): URL {
  const { plugin, variant, id } = parseSignalRef(request.ref)
  return apiUrl(`/plugins/${plugin}/signals`, {
    symbol: request.vendorSymbol,
    resolution: request.resolution,
    from: request.from,
    to: request.to,
    limit: request.limit,
    variant: variant ?? undefined,
    signal: id || undefined,
    params: request.params ? JSON.stringify(request.params) : undefined
  })
}

/** The facilities' `signals.points`: a page of one plugin's labelled points. The page
 * continues from the server's `nextFrom` (the underlying read is what is paged, so a page
 * can hold no signal and still not be the end), not from its last point. */
export async function fetchSignals<P extends { date: number }>(request: SignalsRequest): Promise<Page<SignalPoint<P>>> {
  if (!hasFeature('plugins.signals')) return { points: [], nextFrom: null }
  const envelope = await fetchEnvelope<SignalPoint<P>>(signalsUrl(request))
  const page = toPage(envelope, Number.POSITIVE_INFINITY)
  const nextFrom = envelope.s === 'replaying' ? null : typeof envelope.nextFrom === 'number' ? envelope.nextFrom : null
  return { ...page, nextFrom }
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
