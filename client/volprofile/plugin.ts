import type { IndicatorGroup } from '../../src'
import { baseIntervalsFor } from '../capabilities'
import { paneConfig } from '../plugins/paneconfig'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities } from '../plugins/types'
import { nominalMs } from '../replay/timeframes'
import { clockFor } from '../tradetalk/plugin'
import { fromStoredVpConfig, normaliseVpConfig, toStoredVpConfig, VP_DEFAULTS, VP_FIELDS, type VpConfig } from './config'
import { type BarStore, barSource, barSourceKey, pickSource, type Schedule, wireShift } from './source'
import { isVolumeProfileIndicator, registerVolumeProfileIndicator, TEMPLATE_NAME } from './templates'

// The volume profile as a client plugin: one template on the price pane, at most one source
// (bars of a lower timeframe than the chart, source.ts), and no server change of any kind --
// the bars come from the chart tiles and `/getbars` like the chart's own, and the profile is
// computed and drawn in the browser.
//
// Settings are per chart pane, kept by the host and persisted in the wall document as
// `PersistedPane.vp`. An edit rebinds, and the rebind picks the source again -- mode and rows
// both decide it.

export const VP_PANE_CONFIG = paneConfig<VpConfig>({
  templates: [TEMPLATE_NAME],
  doc: 'vp',
  title: 'Volume profile',
  fields: VP_FIELDS,
  defaults: VP_DEFAULTS,
  normalise: normaliseVpConfig,
  toStored: toStoredVpConfig,
  fromStored: fromStoredVpConfig
})

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

  return {
    id: 'volprofile',
    // `/getbars` and the tiles are the oldest routes there are; nothing to gate on.
    feature: null,
    paneConfigs: [VP_PANE_CONFIG],
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      return registerVolumeProfileIndicator()
    },
    matches: isVolumeProfileIndicator,
    bind(ctx: BindContext): BindingSpec | null {
      const f = facilities
      if (!f) return null
      const config = ctx.config as VpConfig
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
    }
  }
}
