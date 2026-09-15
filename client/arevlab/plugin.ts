import type { IndicatorGroup } from '../../src'
import { AREV_GENERATIONS, type ArevGeneration } from '../arev/api'
import { fetchBars } from '../history'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities, Range, SettingsRequest, SourceSpec } from '../plugins/types'
import { loadRegistry, type RegistryIndicator } from '../tsregistry/api'
import { storedSource } from '../tsregistry/plugin'
import { LAB_DEFAULTS, LAB_FIELDS, enabledGenerations, normaliseLabConfig, type LabConfig, type LabGeneration } from './config'
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

/** Roughly how many bars separate two samples, per generation -- to turn "the previous N
 * samples" into a time span. Measured on EURUSD: arev21's fresh extremes and arev22's stride
 * land about every 4 bars, the WMA crosses of arev19/20/23 about every 12. */
const BARS_PER_SAMPLE: Record<ArevGeneration, number> = { arev19: 12, arev20: 12, arev21: 4, arev22: 4, arev23: 12 }
/** Headroom on that span: a nominal bar duration overcounts trading time (the FX weekend is a
 * third of the week), and the spacing is an average. */
const LEAD_SLACK = 2
/** The widest lead-in fetched, in bars. A 5000-sample window on arev19 would otherwise ask for
 * 120,000 minute bars; past this the rule simply starts later on the chart. */
const LEAD_MAX_BARS = 40_000

/** `/getbars` is bounded by range and 413s past the server's cap; fetch in nominal chunks
 * comfortably under it (as mtf/plugin.ts does). */
const BAR_CHUNK = 4000

const LEGEND_ROW_HEIGHT = 24

/** Bars of history a generation's rule needs before the first bar it is drawn on. */
export function leadInBars(generation: ArevGeneration, settings: LabGeneration): number {
  const samples =
    settings.signals === 'rank'
      ? settings.rank.window
      : settings.signals === 'median'
        ? settings.median.window
        : settings.signals === 'prior'
          ? settings.prior.labels
          : 0
  if (samples === 0) return 0
  const horizon = settings.signals === 'prior' && generation === 'arev22' ? AREV22_HORIZON : 0
  return Math.min(LEAD_MAX_BARS, Math.ceil((samples + 2) * BARS_PER_SAMPLE[generation] * LEAD_SLACK) + horizon)
}

/** A chart range widened backwards by `bars` bars of `durationMs`. Wire dates do not go below
 * zero on any series here, and a negative `from` is a request the server refuses. */
export function widen(range: Range, bars: number, durationMs: number): Range {
  return { from: Math.max(0, range.from - bars * durationMs), to: range.to }
}

export function barsSourceKey(vendor: string, ticker: string, interval: string): string {
  return `arevlab-bars|${vendor}:${ticker}|${interval}`
}

function barsSource(f: PluginFacilities, ctx: BindContext, leadBars: number): SourceSpec<LabBar> {
  const duration = f.resolutionDurationMs(ctx.interval)
  const chunk = BAR_CHUNK * duration
  const vendorSymbol = `${ctx.vendor}:${ctx.ticker}`
  return {
    id: BARS_SOURCE_ID,
    key: barsSourceKey(ctx.vendor, ctx.ticker, ctx.interval),
    resolution: ctx.interval,
    window: (range) => widen(range, leadBars, duration),
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

  const label = (config: LabConfig, state: BindingState): string => {
    const shown = readable(config)
    if (shown.length === 0) return 'AREV lab · none on'
    const names = shown.join(' ')
    const stores = shown.map((g) => state.sources.find((s) => s.id === g)?.store)
    if (stores.some((s) => s?.phase === 'error')) return `AREV lab ${names} · error`
    if (stores.some((s) => !s || s.phase === 'idle' || s.phase === 'loading')) return `AREV lab ${names} · loading`
    return `AREV lab ${names}`
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
      onChange: (next) => {
        // Clamped before it reaches a binding: the number inputs commit every keystroke, and
        // a window of 0 or a quantile of 7 is a rule that cannot be computed.
        configs[paneIndex] = normaliseLabConfig(next)
        configRevs[paneIndex] = (configRevs[paneIndex] ?? 0) + 1
        f.requestPersist()
        f.requestReconcile(paneId)
      },
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
        const lead = leadInBars(generation, config.generations[generation])
        const base = storedSource(f, entry, ctx)
        return lead > 0 ? { ...base, window: (range: Range) => widen(range, lead, duration) } : base
      }) as SourceSpec[]
      const priorLead = Math.max(
        0,
        ...shown.filter((g) => config.generations[g].signals === 'prior').map((g) => leadInBars(g, config.generations[g]))
      )
      if (shown.some((g) => config.generations[g].signals === 'prior')) {
        sources.push(barsSource(f, ctx, priorLead) as unknown as SourceSpec)
      }
      return {
        sources,
        label: (state) => label(config, state),
        extendData: () => ({ config }),
        overrides: { figures: labFigures(config) }
      }
    },
    handleSettings(request: SettingsRequest): boolean {
      if (request.indicatorName !== LAB_TEMPLATE_NAME) return false
      return openPanel(request.paneId)
    },
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
