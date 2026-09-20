import { apiGet } from './config'
import type { InstrumentConfig } from './symbols'

// The one client-side cache of `GET /instrument`, keyed by `vendor:TICKER`.
//
// There were two before: `symbols.ts`'s `fetchSymbolInfo` (which had none at all, so every
// layout hydration refetched) and `trading/instrument.ts` (which cached its own derived
// `InstrumentInfo` and said in its own comment that it existed because /instrument had no
// cache). A pane therefore cost two identical requests on every boot -- measured on the dev
// server 2026-09-20 -- and switching workspaces paid for them again. The request is worth
// collapsing rather than repeating: it is a per-call Postgres read of `instrument_config`
// (the whole cost of the route: 1 query, ~15 ms from this workstation), and the answer is
// static configuration.
//
// An instrument's configuration changes when someone edits `marketdata.instrument_config`
// and reruns the seeder, never during a session, so this is cached for the life of the page
// with no TTL -- the same reasoning as `capabilities.ts`, which resolves once at boot.
//
// NEVER REJECTS. `/instrument` failing must degrade a caller to its own fallback (a
// price-only ticket, a symbol without config), not take the chart down; a failure caches as
// `null` so a missing or misconfigured instrument is not re-requested on every redraw.
//
// The `InstrumentConfig` import is type-only, so the symbols.ts <-> instrumentconfig.ts pair
// carries no runtime cycle.

const cache = new Map<string, InstrumentConfig | null>()
const inflight = new Map<string, Promise<InstrumentConfig | null>>()

/** What is already known for `vendor:TICKER`: the config, `null` if it was asked for and
 * could not be had, `undefined` if it has never been fetched. Synchronous, for a caller
 * that must render now and redraw later. */
export function cachedInstrumentConfig(vendorSymbol: string): InstrumentConfig | null | undefined {
  return cache.get(vendorSymbol)
}

/** The config for `vendor:TICKER`, fetched once per page. Concurrent callers share one
 * request; a later caller gets the cached answer without touching the network. */
export function instrumentConfig(vendorSymbol: string): Promise<InstrumentConfig | null> {
  const hit = cache.get(vendorSymbol)
  if (hit !== undefined) return Promise.resolve(hit)
  const pending = inflight.get(vendorSymbol)
  if (pending) return pending
  const request = apiGet<InstrumentConfig>('/instrument', { symbol: vendorSymbol })
    .then((config) => {
      cache.set(vendorSymbol, config)
      return config
    })
    .catch((err: unknown) => {
      console.warn(`[instrument] /instrument failed for ${vendorSymbol}`, err)
      cache.set(vendorSymbol, null)
      return null
    })
    .finally(() => inflight.delete(vendorSymbol))
  inflight.set(vendorSymbol, request)
  return request
}

/** Tests only: forget everything, so one suite's fetches cannot answer another's. */
export function resetInstrumentConfigCache(): void {
  cache.clear()
  inflight.clear()
}
