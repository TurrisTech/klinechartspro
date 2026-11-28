import { capabilities, hasFeature } from './capabilities'
import { apiGet, getReadClock } from './config'
import { stream } from './stream'
import { symbolVendor } from './symbols'
import { fetchPoints } from './plugins/api'
import type { PluginFacilities, PluginStream } from './plugins/types'
import { periodToResolution, resolutionDurationMs } from './time/intervals'

// The app's shared services, bundled for plugin consumption. Built once per mount by
// client/index.ts (and the Lab's chart, client/lab/page.ts); a plugin gets this and nothing else,
// so what it may depend on is exactly what is listed in PluginFacilities (plugins/types.ts).
// Here at the root rather than in client/plugins because it adapts the app's own services
// (capabilities, config, the stream, symbols) to the framework, which knows none of them.

const MAX_VALUES_PER_REQUEST = 5000

/** The stream a replay wall hands the plugins: nothing live ever arrives. Only this client
 * moves the clock, and a live point would be a value from the future. */
export const inertStream: PluginStream = {
  subscribe() {},
  unsubscribe() {},
  subscribeIndicator() {},
  unsubscribeIndicator() {},
  subscribePlugin() {},
  unsubscribePlugin() {}
}

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
    maxValuesPerRequest: MAX_VALUES_PER_REQUEST,
    // A getter, so the cap is read off the page's discovery when a plugin asks for it rather than
    // copied when the facilities are built: what capabilities() says then is what it gets.
    get maxBarsPerRequest(): number {
      return capabilities().limits.maxBarsPerRequest
    },
    readClock: getReadClock
  }
}
