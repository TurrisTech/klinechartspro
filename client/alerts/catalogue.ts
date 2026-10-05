// WHAT AN ALERT CAN READ, and what each thing is called.
//
//   bar        open/high/low/close/volume
//   indicator  the klinecharts built-ins (RSI, MA, MACD...), computed in the browser by the
//              same template the chart draws (./compute.ts) -- through `getIndicatorClass`,
//              which the klinecharts patch exports for exactly this
//   series     the timeseries registry's STORED rows (AREV, krev, arev21_outlier...), read
//              from `/plugins/{id}/values`. The registry's computed `S:` rows are left out:
//              they need the server to resolve a node document per instance, and the
//              built-ins cover the same indicators
//   signal     the published signal labels (`GET /plugins/signals`), grouped by plugin
//
// Only the built-ins are named here: a plugin's template (`AREV:...`, `TS:...`) is also a
// registered klinecharts indicator, but its `calc` reads a store the plugin host fills for a
// pane, and computes nothing on bars of its own.

import { getIndicatorClass } from 'klinecharts'
import { loadSignalCatalogue } from '../plugins/api'
import type { SignalCatalogueEntry } from '../plugins/types'
import { loadRegistry, type RegistryIndicator, type RegistrySeries } from '../tsregistry/api'
import { type Feature, hasFeature } from '../capabilities'
import { instantiate } from './compute'
import { graphOverlays } from './graphentry'
import { operandKey } from './rules'
import type { BarField, Operand } from './types'

export const BAR_FIELDS: ReadonlyArray<{ field: BarField; label: string }> = [
  { field: 'close', label: 'Close' },
  { field: 'open', label: 'Open' },
  { field: 'high', label: 'High' },
  { field: 'low', label: 'Low' },
  { field: 'volume', label: 'Volume' }
]

/** The built-ins an alert may compute, in the order the picker lists them. Left out:
 *
 *  - AVP, which divides turnover by volume, and these bars carry no turnover;
 *  - OBV and PVT, which are running SUMS from the first bar loaded: their value depends on where
 *    the window starts and never converges, so a windowed read -- every alert's -- would cross
 *    a level at a different bar from the chart (measured: four crossings, none on the same bar).
 */
export const BUILTIN_INDICATORS: readonly string[] = [
  'MA', 'EMA', 'SMA', 'BOLL', 'SAR', 'BBI',
  'RSI', 'MACD', 'KDJ', 'CCI', 'WR', 'DMI', 'BIAS', 'ROC', 'MTM', 'TRIX', 'AO', 'BRAR', 'CR', 'DMA', 'EMV', 'PSY',
  'VOL', 'VR'
]

/** Where the template's default draws several lines -- one per period, which reads as noise in
 * an alert -- one sensible period instead. The chart's own defaults are untouched. */
const ALERT_DEFAULT_PARAMS: Record<string, number[]> = {
  RSI: [14],
  MA: [20],
  EMA: [20],
  WR: [14],
  BIAS: [12]
}

export interface IndicatorOutput {
  key: string
  title: string
}

export interface BuiltinInfo {
  name: string
  /** `price` draws over the candles; `normal` and `volume` are sub-pane oscillators. */
  series: string
  defaultParams: number[]
}

/** A built-in's facts, or null for a name klinecharts does not have. */
export function builtinInfo(name: string): BuiltinInfo | null {
  if (!BUILTIN_INDICATORS.includes(name)) return null
  const Template = getIndicatorClass(name)
  if (!Template) return null
  const instance = new Template()
  return {
    name,
    series: String(instance.series),
    defaultParams: ALERT_DEFAULT_PARAMS[name] ?? (instance.calcParams as number[]).slice()
  }
}

/** The lines a built-in draws for these params: its figure keys, titled as the chart titles
 * them ("MA20", "DIF"). */
export function builtinOutputs(name: string, params: readonly number[]): IndicatorOutput[] {
  const instance = instantiate(name, params)
  if (!instance) return []
  return instance.figures.map((figure) => ({ key: figure.key, title: (figure.title ?? figure.key).replace(/:\s*$/, '').trim() }))
}

// -- the server's half ------------------------------------------------------------------------

/** A stored registry row an alert can read, and the plugin it is served by. */
export interface StoredIndicator {
  entry: RegistryIndicator
  plugin: string
  variant: string
  /** The point field several rows on one bar are filed under (krev01's `side`), or null. */
  foldBy: string | null
  /** The series worth comparing: numbers, not reference lines or presentation-only keys. */
  series: RegistrySeries[]
}

/** One plugin's signals: the labels it puts on a bar. */
export interface SignalFamily {
  plugin: string
  variant: string
  title: string
  labels: Array<{ id: string; label: string; side: string | null }>
}

export interface ServerCatalogue {
  stored: StoredIndicator[]
  signals: SignalFamily[]
}

/** The stored registry rows: everything but the computed library (`plugin: indicators`). */
export function storedIndicators(registry: readonly RegistryIndicator[]): StoredIndicator[] {
  return registry
    .filter((entry) => entry.enabled && entry.wire.plugin !== 'indicators' && (entry.feature == null || hasFeature(entry.feature as Feature)))
    .map((entry) => ({
      entry,
      plugin: entry.wire.plugin,
      variant: entry.wire.variant ?? '',
      foldBy: entry.source.fold_by ?? null,
      series: entry.series.filter((s) => s.role === 'value' || s.role === 'signal')
    }))
    .filter((row) => row.series.length > 0)
    .sort((a, b) => a.entry.displayOrder - b.entry.displayOrder || a.entry.title.localeCompare(b.entry.title))
}

/** The signal catalogue grouped by plugin and variant -- one operand per family, its labels
 * the choices. */
export function signalFamilies(entries: readonly SignalCatalogueEntry[]): SignalFamily[] {
  const families = new Map<string, SignalFamily>()
  for (const entry of entries) {
    if (!entry.available) continue
    const variant = entry.variant ?? ''
    const key = `${entry.plugin}/${variant}`
    let family = families.get(key)
    if (!family) {
      family = { plugin: entry.plugin, variant, title: familyTitle(entry.title, variant), labels: [] }
      families.set(key, family)
    }
    family.labels.push({ id: entry.id, label: entry.label, side: entry.side ?? null })
  }
  return [...families.values()].sort((a, b) => a.title.localeCompare(b.title))
}

/** "AREV arev21", but "AREV21 outlier rank" rather than "AREV21 outlier arev21_outlier_rank":
 * a variant that repeats its plugin's title is named by what it adds. */
export function familyTitle(title: string, variant: string): string {
  if (!variant) return title
  const slug = `${title.toLowerCase().replace(/\s+/g, '_')}_`
  return variant.toLowerCase().startsWith(slug) ? `${title} ${variant.slice(slug.length).replace(/_/g, ' ')}` : `${title} ${variant}`
}

let server: Promise<ServerCatalogue> | null = null

/** The server's catalogue, fetched once per page. Each half degrades to empty on a server
 * that does not have it, which is the honest answer: the picker then offers nothing there. */
export function loadServerCatalogue(): Promise<ServerCatalogue> {
  if (!server) {
    server = Promise.all([
      loadRegistry().catch(() => []),
      hasFeature('plugins.signals') ? loadSignalCatalogue().catch(() => []) : Promise.resolve([])
    ]).then(([registry, signals]) => ({ stored: storedIndicators(registry), signals: signalFamilies(signals) }))
  }
  return server
}

/** For tests. */
export function resetServerCatalogue(): void {
  server = null
}

// -- names -------------------------------------------------------------------------------------

/** How an operand reads in a sentence and in the list: "RSI(14)", "MACD(12,26,9) DEA",
 * "AREV21 p", "AREV arev21 signal". Uses the server catalogue where one is loaded. */
export function labelOperand(operand: Operand, catalogue: ServerCatalogue | null = null): string {
  switch (operand.kind) {
    case 'bar':
      return BAR_FIELDS.find((f) => f.field === operand.field)?.label ?? operand.field
    case 'indicator': {
      const outputs = builtinOutputs(operand.name, operand.params)
      const base = `${operand.name}(${operand.params.join(',')})`
      if (outputs.length <= 1) return base
      return `${base} ${outputs.find((o) => o.key === operand.output)?.title ?? operand.output}`
    }
    case 'series': {
      const row = catalogue?.stored.find((s) => s.entry.name === operand.indicator)
      const series = row?.series.find((s) => s.key === operand.key)
      const title = row?.entry.title ?? operand.indicator
      return series && row && row.series.length > 1 ? `${title} ${series.label || series.key}` : title
    }
    case 'signal': {
      const family = catalogue?.signals.find((f) => f.plugin === operand.plugin && f.variant === operand.variant)
      return `${family?.title ?? (operand.variant || operand.plugin)} signal`
    }
    case 'graph':
      return `${graphTitle(operand.overlay)} graph entry`
    case 'time':
      return `${operand.field === 'minute' ? 'Time of day' : 'Weekday'} (${zoneLabel(operand.zone)})`
  }
}

/** An overlay's name without the "MTF" every one of them carries: "AREV21 OUTLIER RANK 85". */
export function graphTitle(overlayId: string): string {
  const overlay = graphOverlays().find((o) => o.id === overlayId)
  return overlay ? overlay.title.replace(/\s+MTF$/, '') : overlayId
}

/** The clocks a time condition can read, by the markets they open. */
export const TIME_ZONES: ReadonlyArray<{ zone: string; label: string }> = [
  { zone: 'America/New_York', label: 'New York' },
  { zone: 'Europe/London', label: 'London' },
  { zone: 'Europe/Berlin', label: 'Frankfurt' },
  { zone: 'Asia/Tokyo', label: 'Tokyo' },
  { zone: 'Australia/Sydney', label: 'Sydney' },
  { zone: 'UTC', label: 'UTC' }
]

export function zoneLabel(zone: string): string {
  return TIME_ZONES.find((z) => z.zone === zone)?.label ?? zone
}

/** Bars of lead-in an operand needs before its value is trustworthy: enough for a recursive
 * indicator (an EMA, Wilder's RSI) to forget where it started, to well under a part in ten
 * thousand. A bar field or a stored series needs one bar before -- for a crossing to have
 * something to cross from. */
export function leadInBars(operand: Operand): number {
  if (operand.kind !== 'indicator') return 2
  const longest = Math.max(1, ...operand.params.filter((p) => Number.isFinite(p)))
  return Math.min(1200, Math.max(60, Math.ceil(longest * 5 + 50)))
}

/** The most lead-in any operand on `interval` needs. */
export function leadInFor(operands: readonly Operand[], interval: string): number {
  return Math.max(2, ...operands.filter((o) => o.interval === interval).map(leadInBars))
}

/** Operands grouped by interval, keyed. */
export function byInterval(operands: readonly Operand[]): Map<string, Map<string, Operand>> {
  const out = new Map<string, Map<string, Operand>>()
  for (const operand of operands) {
    let group = out.get(operand.interval)
    if (!group) {
      group = new Map()
      out.set(operand.interval, group)
    }
    group.set(operandKey(operand), operand)
  }
  return out
}
