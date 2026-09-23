import type { IndicatorGroup } from '../../src'
import { AREV_GENERATIONS, type ArevGeneration } from '../arev/api'
import { fetchBars } from '../history'
import { setByPath } from '../chartlayers/settings'
import type {
  BindContext,
  BindingSpec,
  BindingState,
  IndicatorPlugin,
  PluginFacilities,
  PluginSettings,
  Range,
  SettingsRequest,
  SourceSpec
} from '../plugins/types'
import { loadRegistry, type RegistryIndicator } from '../tsregistry/api'
import { storedSource } from '../tsregistry/plugin'
import { LAB_DEFAULTS, LAB_FIELDS, enabledGenerations, normaliseLabConfig, type LabConfig, type LabGeneration } from './config'
import { spanMs, windowBars } from './compute'
import { AREV22_HORIZON, type LabBar } from './labels'
import { BARS_SOURCE_ID, LAB_TEMPLATE_NAME, isLabIndicator, labFigures, registerLabIndicator } from './templates'

// The AREV lab as a client plugin: one sub-pane reading the prediction line of any AREV
// generation, several at once, with each generation's arrows placed by the published rule or
// by one of the adaptive ones (rank, median, prior) computed here in the browser.
//
// Each generation is read through the registry's own source for it (`storedSource`), so the
// lab and an AREV sub-pane on the same instrument share one store: same key, same factory,
// same resolution, same tiles-first fetch. The only thing the lab adds to that source is a
// wider window, because an adaptive rule's lines at the first visible bar are built from the
// samples BEFORE it -- the previous `window` of them, or the last `labels` resolved labels --
// and without that lead-in every rule would start blank at the left edge of the chart.
//
// The prior also needs bars, to rebuild each sample's label (labels.ts). That source exists
// only while some generation on the pane uses the prior.
//
// Settings are per pane, persisted in the wall document (client/layout.ts's
// PersistedPane.arevlab) exactly as the AREV21 multi-timeframe overlay persists its own: this
// plugin is their only writer, an edit bumps the pane's revision, the revision is part of the
// binding signature, and the rebind sets the figures the new config draws.

/** The most history a lab pane loads per generation, in bars -- 8 pages at the server's cap, and
 * what a browser can hold per pane. A window longer than this in wall-clock terms is honoured as
 * far as the cap and the legend says what span was actually used, rather than being silently
 * computed over less. Ten years of daily bars fit; ten years of 1m does not. */
const LEAD_MAX_BARS = 40_000

/** `/getbars` is bounded by range and 413s past the server's cap; fetch in nominal chunks
 * comfortably under it (as mtf/plugin.ts does). */
const BAR_CHUNK = 4000

const LEGEND_ROW_HEIGHT = 24

/** The history one generation's rule needs before the first bar it is drawn on: its window,
 * exactly -- plus, for arev22's prior, the ten bars its label waits for. Capped at what a pane
 * may hold, so the answer is in milliseconds and the caller can see it was shortened. */
export function leadInMs(generation: ArevGeneration, settings: LabGeneration, barMs: number): number {
  // rank counts bars, so its history is bars; median and prior span time.
  const span = windowBars(settings) > 0 ? windowBars(settings) * barMs : spanMs(settings)
  if (span === 0) return 0
  const horizon = settings.signals === 'prior' && generation === 'arev22' ? AREV22_HORIZON * barMs : 0
  return Math.min(LEAD_MAX_BARS * barMs, span + horizon + barMs)
}

/** A chart range widened backwards by `leadMs`. Wire dates do not go below zero on any series
 * here, and a negative `from` is a request the server refuses. */
export function widen(range: Range, leadMs: number): Range {
  return { from: Math.max(0, range.from - leadMs), to: range.to }
}

/** Whether the cap shortened a generation's window, for the legend. Only a SPAN can be cut --
 * a count of bars is already bounded by the lever's own maximum. */
export function windowTruncatedDays(settings: LabGeneration, barMs: number): number | null {
  const span = spanMs(settings)
  if (span === 0) return null
  const capped = LEAD_MAX_BARS * barMs
  return span > capped ? Math.floor(capped / 86_400_000) : null
}

export function barsSourceKey(vendor: string, ticker: string, interval: string): string {
  return `arevlab-bars|${vendor}:${ticker}|${interval}`
}

function barsSource(f: PluginFacilities, ctx: BindContext, leadMs: number): SourceSpec<LabBar> {
  const duration = f.resolutionDurationMs(ctx.interval)
  const chunk = BAR_CHUNK * duration
  const vendorSymbol = `${ctx.vendor}:${ctx.ticker}`
  return {
    id: BARS_SOURCE_ID,
    key: barsSourceKey(ctx.vendor, ctx.ticker, ctx.interval),
    resolution: ctx.interval,
    window: (range) => widen(range, leadMs),
    fetch: async (range) => {
      const to = Math.min(range.to, range.from + chunk)
      const bars = await fetchBars(vendorSymbol, ctx.interval, range.from, to, null)
      return {
        points: bars.map((bar) => ({ date: bar.timestamp, open: bar.open, close: bar.close })),
        nextFrom: to < range.to ? to : null
      }
    }
  }
}

export function createArevLabPlugin(): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  let entries = new Map<ArevGeneration, RegistryIndicator>()
  const configs: Record<number, LabConfig> = {}
  const configRevs: Record<number, number> = {}
  let panel: { close(): void } | null = null

  const configFor = (paneIndex: number): LabConfig => configs[paneIndex] ?? LAB_DEFAULTS

  /** The generations switched on that this server actually serves. */
  const readable = (config: LabConfig): ArevGeneration[] => enabledGenerations(config).filter((g) => entries.has(g))

  const label = (config: LabConfig, state: BindingState, barMs: number): string => {
    const shown = readable(config)
    if (shown.length === 0) return 'AREV lab · none on'
    const names = shown.join(' ')
    const stores = shown.map((g) => state.sources.find((s) => s.id === g)?.store)
    if (stores.some((s) => s?.phase === 'error')) return `AREV lab ${names} · error`
    if (stores.some((s) => !s || s.phase === 'idle' || s.phase === 'loading')) return `AREV lab ${names} · loading`
    // A window this timeframe cannot hold is drawn over what it can, and says so -- a shortened
    // window is a different statistic, and silently computing one is how a reader is misled.
    const cut = shown
      .map((g) => [g, windowTruncatedDays(config.generations[g], barMs)] as const)
      .filter(([, days]) => days !== null)
    if (cut.length > 0) return `AREV lab ${names} · window ${cut.map(([g, d]) => `${g} ${d}d`).join(' ')}`
    return `AREV lab ${names}`
  }

  /** A pane's new config, from its panel or from the indicator manager: every lever made legal
   * before it reaches a binding -- the panel's number inputs commit every keystroke, and a
   * window of 0 or a quantile of 7 is a rule that cannot be computed -- then kept, persisted
   * and that pane alone redrawn. */
  const applyConfig = (paneIndex: number, paneId: string, next: LabConfig): void => {
    const f = facilities
    if (!f) return
    configs[paneIndex] = normaliseLabConfig(next)
    configRevs[paneIndex] = (configRevs[paneIndex] ?? 0) + 1
    f.requestPersist()
    f.requestReconcile(paneId)
  }

  const settings: PluginSettings = {
    fields: LAB_FIELDS,
    read: (paneIndex) => configFor(paneIndex),
    write: (paneIndex, paneId, key, value) => {
      const next = structuredClone(configFor(paneIndex))
      setByPath(next, key, value)
      applyConfig(paneIndex, paneId, next)
    }
  }

  const openPanel = (paneId: string): boolean => {
    const f = facilities
    const info = f?.paneInfo(paneId)
    if (!f || !info) return false
    let anchor: HTMLElement | null = null
    try {
      anchor = info.chart.getDom() as HTMLElement | null
    } catch {
      anchor = null
    }
    if (!anchor) return false
    // The gear is drawn on the canvas, so the panel hangs under the legend row rather than
    // under an element (mtf/plugin.ts explains the rect).
    const chartRect = anchor.getBoundingClientRect()
    const paneIndex = info.paneIndex
    panel?.close()
    panel = f.openSettingsPanel<LabConfig>({
      anchor,
      anchorRect: { top: chartRect.top, bottom: chartRect.top + LEGEND_ROW_HEIGHT, left: chartRect.left + 8 },
      title: `AREV lab · ${info.pane.getSymbol().ticker} ${f.periodToResolution(info.pane.getPeriod())}`,
      fields: LAB_FIELDS,
      config: configFor(paneIndex),
      defaults: LAB_DEFAULTS,
      onChange: (next) => applyConfig(paneIndex, paneId, next),
      onClose: () => {
        panel = null
      }
    })
    return true
  }

  return {
    id: 'arevlab',
    // Reads the AREV generations' own stored series, so it is gated on the same capability.
    feature: 'arev',
    async register(f: PluginFacilities): Promise<IndicatorGroup[]> {
      facilities = f
      // The registry says which generations this server serves and how to read each; a
      // generation with no enabled row is simply not offered (and never fetched).
      const rows = await loadRegistry()
      entries = new Map(
        rows
          .filter((r) => r.enabled && r.wire.plugin === 'arev' && (AREV_GENERATIONS as readonly string[]).includes(r.name))
          .map((r) => [r.name as ArevGeneration, r])
      )
      return entries.size > 0 ? registerLabIndicator() : []
    },
    matches: isLabIndicator,
    signature: (ctx) => [configRevs[ctx.paneIndex] ?? 0],
    bind(ctx: BindContext): BindingSpec | null {
      const f = facilities
      if (!f) return null
      const config = configFor(ctx.paneIndex)
      const duration = f.resolutionDurationMs(ctx.interval)
      const shown = readable(config)
      const sources: SourceSpec[] = shown.map((generation) => {
        const entry = entries.get(generation) as RegistryIndicator
        const lead = leadInMs(generation, config.generations[generation], duration)
        const base = storedSource(f, entry, ctx)
        return lead > 0 ? { ...base, window: (range: Range) => widen(range, lead) } : base
      }) as SourceSpec[]
      const priors = shown.filter((g) => config.generations[g].signals === 'prior')
      if (priors.length > 0) {
        const lead = Math.max(...priors.map((g) => leadInMs(g, config.generations[g], duration)))
        sources.push(barsSource(f, ctx, lead) as unknown as SourceSpec)
      }
      return {
        sources,
        label: (state) => label(config, state, duration),
        extendData: () => ({ config }),
        overrides: { figures: labFigures(config) }
      }
    },
    handleSettings(request: SettingsRequest): boolean {
      if (request.indicatorName !== LAB_TEMPLATE_NAME) return false
      return openPanel(request.paneId)
    },
    ownsSettings: (templateName) => templateName === LAB_TEMPLATE_NAME,
    settings: (templateName) => (templateName === LAB_TEMPLATE_NAME ? settings : null),
    paneState: {
      hydrate(initial) {
        for (const [index, config] of Object.entries(initial)) {
          if (config) configs[Number(index)] = normaliseLabConfig(config as LabConfig)
        }
      },
      snapshot: () => ({ ...configs })
    },
    dispose() {
      panel?.close()
      panel = null
    }
  }
}
