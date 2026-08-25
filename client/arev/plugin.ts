import type { IndicatorGroup } from '../../src'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities, SourceSpec } from '../plugins/types'
import { AREV_GENERATIONS, type ArevPoint } from './api'
import { parseTemplateName, registerArevIndicators, TEMPLATE_PREFIX } from './templates'

// AREV as a client plugin: one sub-pane template per model generation, each reading one
// source -- that generation's votes for the pane's instrument and interval, off the
// server's `arev` plugin (`GET /plugins/arev/values?variant=<generation>`, or
// `/arev/values?generation=` on a server from before the host). Nothing to resolve (a
// template IS a generation; there are no params) and nothing to subscribe (the rows are
// written by hand-run research scripts, not a live feed -- new data appears when a script
// is re-run, and a reload or range change picks it up).

// klinecharts pads an indicator pane's y-axis by 20% above and 10% below its data range,
// which is sized for a candle pane (room for the legend, and for a price line to sit off
// the top). This pane's range is already bounded either side by the flat threshold lines,
// so most of that padding is just empty pane. Give it half: enough that the top line
// clears the legend row, without spending a third of the height on nothing.
export const AXIS_GAP = { top: 0.1, bottom: 0.05 }

export function arevSourceKey(generation: string, vendor: string, ticker: string, interval: string): string {
  return `${generation}|${vendor}:${ticker}|${interval}`
}

/** The source for one generation on one instrument/interval -- shared with the MTF overlay,
 * which reads arev21 at intervals that are not the chart's. */
export function arevSource(facilities: PluginFacilities, generation: string, vendor: string, ticker: string, interval: string): SourceSpec<ArevPoint> {
  return {
    id: generation,
    key: arevSourceKey(generation, vendor, ticker, interval),
    fetch: (range, limit) =>
      facilities.points<ArevPoint>({
        pluginId: 'arev',
        legacyPath: '/arev/values',
        legacyQuery: { generation },
        vendorSymbol: `${vendor}:${ticker}`,
        resolution: interval,
        from: range.from,
        to: range.to,
        limit,
        variant: generation
      })
  }
}

export function createArevPlugin(): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  return {
    id: 'arev',
    feature: 'arev',
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      return registerArevIndicators()
    },
    matches: (name) => name.startsWith(TEMPLATE_PREFIX) && parseTemplateName(name) !== null,
    bind(ctx: BindContext): BindingSpec | null {
      const generation = parseTemplateName(ctx.indicator.name)
      if (!generation || !facilities) return null
      const base = generation.toUpperCase()
      return {
        sources: [arevSource(facilities, generation, ctx.vendor, ctx.ticker, ctx.interval)],
        label: (state: BindingState) => {
          switch (state.sources[0]?.store.phase) {
            case 'idle':
            case 'loading':
              return `${base} · loading`
            case 'error':
              return `${base} · error`
            default:
              return base
          }
        },
        yAxisGap: AXIS_GAP
      }
    }
  }
}

export { AREV_GENERATIONS }
