import { hasFeature } from '../capabilities'
import { apiGet } from '../config'
import { periodToResolution, resolutionDurationMs } from '../periods'
import { stream } from '../stream'
import { symbolVendor } from '../symbols'
import { fetchPoints } from './api'
import type { PluginFacilities, PluginStream } from './types'

// The app's shared services, bundled for plugin consumption. Built once per mount by
// client/index.ts; a plugin gets this and nothing else, so what it may depend on is exactly
// what is listed in PluginFacilities (types.ts).

const MAX_VALUES_PER_REQUEST = 5000

export function createFacilities(options: {
  /** The live stream the plugins subscribe to; a replay wall passes an inert one (its
   * clock is the cursor, and nothing live may reach its stores). */
  stream?: PluginStream
} = {}): PluginFacilities {
  return {
    api: { get: apiGet },
    stream: options.stream ?? stream,
    hasFeature,
    points: fetchPoints,
    periodToResolution,
    resolutionDurationMs,
    symbolVendor,
    maxValuesPerRequest: MAX_VALUES_PER_REQUEST
  }
}
