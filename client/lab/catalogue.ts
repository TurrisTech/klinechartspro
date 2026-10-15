// WHAT THE LAB OFFERS: the server's published signals with the parameters each is read with,
// the indicator templates a rule may compute, and the timeframes.
//
// A signal family is the alert manager's (`GET /plugins/signals`, grouped by plugin and variant)
// joined to its registry row (`GET /indicators/registry`, matched on the row's wire), which is what
// declares the parameters and their defaults -- `arev21_outlier_rank` reads `bars`, `q`, `q2`, `q3`
// and `samples_only`, and the rank 85 overlay is the row at q = 0.85.

import { getIndicatorClass } from 'klinecharts'
import { BUILTIN_INDICATORS, loadServerCatalogue, type ServerCatalogue, type SignalFamily } from '../alerts/catalogue'
import { offeredIntervalCodes, resolutionDurationMs } from '../periods'
import { loadRegistry, type RegistryParam } from '../tsregistry/api'
import libraryIndicators from '../../src/indicators'
import type { Side } from './model'

export interface LabSignalFamily extends SignalFamily {
  /** The registry row's declared parameters, in its order; empty when it has none. */
  params: RegistryParam[]
  description: string
}

export interface LabCatalogue {
  server: ServerCatalogue
  signals: LabSignalFamily[]
}

let loaded: Promise<LabCatalogue> | null = null

export function loadLabCatalogue(): Promise<LabCatalogue> {
  if (!loaded) {
    loaded = Promise.all([loadServerCatalogue(), loadRegistry().catch(() => [])]).then(([server, registry]) => ({
      server,
      signals: server.signals.map((family) => {
        const row = registry.find((r) => r.wire.plugin === family.plugin && (r.wire.variant ?? '') === family.variant)
        return { ...family, params: row?.params ?? [], description: row?.description ?? '' }
      })
    }))
  }
  return loaded
}

/** The side a label sits on in a graph, by default: `top` and `bottom` as they say, a long label
 * on top and a short one below -- the rank 85 overlay's zone placement, where a long (P(up) in
 * its top zone) is drawn over the price. */
export function defaultSide(label: { id: string; side: string | null }): Side | null {
  if (label.id === 'top') return 'top'
  if (label.id === 'bottom') return 'bottom'
  if (label.side === 'long') return 'top'
  if (label.side === 'short') return 'bottom'
  return null
}

/** Templates read nothing but the bars they are handed, so a rule can compute them headless:
 * klinecharts' built-ins the alert manager offers, and this library's own (the NNFX and
 * windicators templates), less SESSIONS, which reads the clock rather than the bars. */
export function labIndicators(): string[] {
  const library = libraryIndicators.map((t) => t.name).filter((name) => name !== 'SESSIONS')
  return [...BUILTIN_INDICATORS, ...library].filter((name) => getIndicatorClass(name) !== null)
}

/** The timeframes offered for `symbol`, shortest first. */
export function labIntervals(symbol: string): string[] {
  const at = symbol.indexOf(':')
  const codes = at > 0 ? offeredIntervalCodes(symbol.slice(0, at), symbol.slice(at + 1)) : []
  return [...new Set(codes)].sort((a, b) => resolutionDurationMs(a) - resolutionDurationMs(b))
}
