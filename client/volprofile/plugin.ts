import type { IndicatorGroup } from '../../src'
import { baseIntervalsFor } from '../capabilities'
import { setByPath } from '../chartlayers/settings'
import type {
  BindContext,
  BindingSpec,
  BindingState,
  IndicatorPlugin,
  PluginFacilities,
  PluginSettings,
  SettingsRequest
} from '../plugins/types'
import { nominalMs } from '../replay/timeframes'
import { clockFor } from '../tradetalk/plugin'
import { normaliseVpConfig, VP_DEFAULTS, VP_FIELDS, type VpConfig } from './config'
import { type BarStore, barSource, barSourceKey, pickSource, type Schedule, wireShift } from './source'
import { isVolumeProfileIndicator, registerVolumeProfileIndicator } from './templates'

// The volume profile as a client plugin: one template on the price pane, at most one source
// (bars of a lower timeframe than the chart, source.ts), and no server change of any kind --
// the bars come from the chart tiles and `/getbars` like the chart's own, and the profile is
// computed and drawn in the browser.
//
// Settings are per chart pane, persisted in the wall document (client/layout.ts's
// PersistedPane.vp) the way the AREV21 divergence persists its own: this plugin is their only
// writer, an edit bumps the pane's revision, the revision is part of the binding signature,
// and the rebind picks the source again -- mode and rows both decide it.

const LEGEND_ROW_HEIGHT = 24

function scheduleOf(ctx: BindContext): Schedule | null {
  const { timezone, dayGeometry } = ctx.symbol
  return timezone && dayGeometry ? { timezone, day: dayGeometry } : null
}

/** Whether any of the chart's recent bars carries volume. An index (`$SPX`) has none, and an
 * empty chart is given the benefit of the doubt rather than a flash of "no volume". */
function chartHasVolume(ctx: BindContext): boolean {
  let data: ReadonlyArray<{ volume?: number | null }>
  try {
    data = ctx.chart.getDataList()
  } catch {
    return true
  }
  if (data.length === 0) return true
  for (let i = data.length - 1; i >= Math.max(0, data.length - 500); i--) if ((data[i].volume ?? 0) > 0) return true
  return false
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function createVolumeProfilePlugin(bases: (vendor: string) => string[] = baseIntervalsFor): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  const configs: Record<number, VpConfig> = {}
  const configRevs: Record<number, number> = {}
  let panel: { close(): void } | null = null

  const configFor = (paneIndex: number): VpConfig => configs[paneIndex] ?? VP_DEFAULTS

  const applyConfig = (paneIndex: number, paneId: string, next: VpConfig): void => {
    const f = facilities
    if (!f) return
    configs[paneIndex] = normaliseVpConfig(next)
    configRevs[paneIndex] = (configRevs[paneIndex] ?? 0) + 1
    f.requestPersist()
    f.requestReconcile(paneId)
  }

  const settings: PluginSettings = {
    fields: VP_FIELDS,
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
    // The gear is drawn on the canvas, so the panel hangs under the legend row rather than under
    // an element (mtf/plugin.ts explains the rect).
    const chartRect = anchor.getBoundingClientRect()
    const paneIndex = info.paneIndex
    panel?.close()
    panel = f.openSettingsPanel<VpConfig>({
      anchor,
      anchorRect: { top: chartRect.top, bottom: chartRect.top + LEGEND_ROW_HEIGHT, left: chartRect.left + 8 },
      title: `Volume profile · ${info.pane.getSymbol().ticker} ${f.periodToResolution(info.pane.getPeriod())}`,
      fields: VP_FIELDS,
      config: configFor(paneIndex),
      defaults: VP_DEFAULTS,
      onChange: (next) => applyConfig(paneIndex, paneId, next),
      onClose: () => {
        panel = null
      }
    })
    return true
  }

  return {
    id: 'volprofile',
    // `/getbars` and the tiles are the oldest routes there are; nothing to gate on.
    feature: null,
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      return registerVolumeProfileIndicator()
    },
    matches: isVolumeProfileIndicator,
    signature: (ctx) => [configRevs[ctx.paneIndex] ?? 0],
    bind(ctx: BindContext): BindingSpec | null {
      const f = facilities
      if (!f) return null
      const config = configFor(ctx.paneIndex)
      const schedule = scheduleOf(ctx)
      const chartShift = wireShift(ctx.interval, schedule)
      let source = pickSource(ctx.interval, bases(ctx.vendor), config.mode, config.rows, config.source)
      let sourceShift = source ? wireShift(source, schedule) : 0
      // A session-dated source cannot be mapped onto the chart without the schedule: fall back
      // to the chart's own bars rather than guess a zone.
      if (source === null || sourceShift === null || chartShift === null) {
        source = null
        sourceShift = 0
      }
      const clock = config.mode === 'session' ? clockFor(ctx.symbol, ctx.interval) : null
      const precision = ctx.symbol.pricePrecision
      const tick = typeof precision === 'number' ? 10 ** -precision : 0
      const what = ctx.vendor === 'oanda' ? 'tick count' : 'volume'
      const sources =
        source !== null && chartShift !== null
          ? [
              barSource({
                stream: f.stream,
                vendor: ctx.vendor,
                ticker: ctx.ticker,
                source,
                chart: ctx.interval,
                chartShift,
                sourceShift: sourceShift as number,
                schedule
              })
            ]
          : []
      const quantumKey = source ? barSourceKey(ctx.vendor, ctx.ticker, source) : `chart|${ctx.vendor}:${ctx.ticker}|${ctx.interval}`

      // The legend names the source and what the volume IS, and says why nothing is drawn when
      // nothing is. A source that does not reach the chart's first bar says from when it runs:
      // before that the profile is spread from the chart's own bars, which looks just as
      // plausible and is coarser.
      const label = (state: BindingState): string => {
        if (chartShift === null) return 'VP · no schedule for this instrument'
        if (config.mode === 'session' && clock === null) return 'VP · no schedule for sessions'
        if (!chartHasVolume(ctx)) return 'VP · no volume'
        if (source === null) return `VP ${ctx.interval} · ${what}`
        const store = state.sources[0]?.store as BarStore | undefined
        if (!store || store.phase === 'idle' || store.phase === 'loading') return `VP ${source} · loading`
        if (store.phase === 'error') return `VP ${source} · unavailable`
        const first = store.bars[0]
        let firstChart: number | undefined
        try {
          firstChart = ctx.chart.getDataList()[0]?.timestamp
        } catch {
          firstChart = undefined
        }
        if (first && firstChart !== undefined && first.date - (sourceShift as number) > firstChart - chartShift + nominalMs(ctx.interval)) {
          return `VP ${source} from ${day(first.date - (sourceShift as number))} · ${what}`
        }
        return `VP ${source} · ${what}`
      }

      return {
        sources,
        label,
        extendData: () => ({
          config,
          cacheKey: `${ctx.pane.id}|${ctx.indicator.id}`,
          chart: ctx.interval,
          source,
          chartShift,
          sourceShift,
          schedule,
          clock,
          tick,
          quantumKey
        }),
        overrides: typeof precision === 'number' ? { precision } : undefined
      }
    },
    handleSettings(request: SettingsRequest): boolean {
      if (!isVolumeProfileIndicator(request.indicatorName)) return false
      return openPanel(request.paneId)
    },
    ownsSettings: (templateName) => isVolumeProfileIndicator(templateName),
    settings: (templateName) => (isVolumeProfileIndicator(templateName) ? settings : null),
    paneState: {
      hydrate(initial) {
        for (const [index, config] of Object.entries(initial)) {
          if (config) configs[Number(index)] = normaliseVpConfig(config)
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
