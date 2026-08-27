import type { IndicatorGroup } from '../../src'
import { AXIS_GAP } from '../arev/plugin'
import { WindowStore } from '../plugins/store'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities } from '../plugins/types'
import { KREV_GENERATION, type KrevPoint } from './api'
import { isKrevIndicator, registerKrevIndicators, type BarPoints } from './templates'

// krev01 as a client plugin: one sub-pane template over one source, the votes for the
// pane's instrument and interval off the server's `krev` plugin. A bar can carry two
// points -- a top and a bottom candidate can print on the same bar -- so the store folds
// them by side (`BarPoints`), which is what the template reads back.

export function krevSourceKey(vendor: string, ticker: string, interval: string): string {
  return `${KREV_GENERATION}|${vendor}:${ticker}|${interval}`
}

export function createKrevPlugin(): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  return {
    id: 'krev',
    feature: 'krev',
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      return registerKrevIndicators()
    },
    matches: isKrevIndicator,
    bind(ctx: BindContext): BindingSpec | null {
      const f = facilities
      if (!f) return null
      const base = KREV_GENERATION.toUpperCase()
      return {
        sources: [
          {
            id: KREV_GENERATION,
            key: krevSourceKey(ctx.vendor, ctx.ticker, ctx.interval),
            resolution: ctx.interval,
            createStore: (key) =>
              new WindowStore<KrevPoint, BarPoints>(key, (point, existing) => ({ ...(existing ?? {}), [point.side]: point })),
            fetch: (range, limit) =>
              f.points<KrevPoint>({
                pluginId: 'krev',
                legacyPath: '/krev/values',
                vendorSymbol: `${ctx.vendor}:${ctx.ticker}`,
                resolution: ctx.interval,
                from: range.from,
                to: range.to,
                limit,
                variant: KREV_GENERATION
              })
          }
        ],
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
