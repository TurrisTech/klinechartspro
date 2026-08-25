import { hasFeature } from '../capabilities'
import { openSettingsPanel } from '../chartlayers/settings'
import { apiGet, apiUrl } from '../config'
import { periodToResolution, resolutionDurationMs } from '../periods'
import { stream } from '../stream'
import { symbolVendor } from '../symbols'
import { fetchPoints, fetchSignals, loadSignalCatalogue } from './api'
import type { HostFacilities } from './host'
import type { PluginStream } from './types'

// The app's shared services, bundled for plugin consumption. Built once per mount by
// client/index.ts and completed by the host (paneInfo, requestReconcile); a plugin gets
// this and nothing else, so what it may depend on is exactly what is listed in
// PluginFacilities (types.ts).

const MAX_VALUES_PER_REQUEST = 5000

export function createFacilities(options: {
  requestPersist(): void
  /** The live stream the plugins subscribe to; a replay wall passes an inert one (its
   * clock is the cursor, and nothing live may reach its stores). */
  stream?: PluginStream
}): HostFacilities {
  return {
    api: { get: apiGet, url: apiUrl },
    stream: options.stream ?? stream,
    hasFeature,
    points: fetchPoints,
    periodToResolution,
    resolutionDurationMs,
    symbolVendor,
    openSettingsPanel,
    requestPersist: options.requestPersist,
    maxValuesPerRequest: MAX_VALUES_PER_REQUEST,
    signals: { catalogue: loadSignalCatalogue, points: fetchSignals }
  }
}
