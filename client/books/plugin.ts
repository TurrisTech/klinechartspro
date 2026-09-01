import type { IndicatorGroup } from '../../src'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities, SourceSpec } from '../plugins/types'
import {
  DEFAULT_FLOW_RANGE_PCT,
  nearSource,
  profileSource,
  totalsSource,
  type BookProfilePoint
} from './api'
import { hoverIndex, parseTemplateName, registerBooksIndicators } from './templates'

// The OANDA books as a client plugin (templates.ts has the catalogue of displays). One
// source per binding; the depth overlay and the hover viewer of one kind share the
// profile source's key, so a wall showing both pays for one fetch. Nothing to subscribe
// for data — the books are a 20-minute REST grid, not a stream; new snapshots appear on
// the next fetch — but the hover viewer does subscribe the CROSSHAIR, which is what makes
// "the book at the candle under the pointer" repaint as the pointer moves.

const AXIS_GAP = { top: 0.1, bottom: 0.05 }

function baseLabel(display: string, kind: string): string {
  switch (display) {
    case 'depth':
      return `${kind.toUpperCase()} BOOK`
    case 'view':
      return `${kind.toUpperCase()} BOOK VIEW`
    case 'sentiment':
      return `${kind.toUpperCase()} LONG%`
    default:
      return 'BOOK FLOW'
  }
}

export function createBooksPlugin(): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  return {
    id: 'books',
    feature: 'books',
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      return registerBooksIndicators()
    },
    matches: (name) => parseTemplateName(name) !== null,
    bind(ctx: BindContext): BindingSpec | null {
      const parsed = parseTemplateName(ctx.indicator.name)
      if (!parsed || !facilities) return null
      const { display, kind } = parsed
      let source: SourceSpec
      if (display === 'depth' || display === 'view') {
        source = profileSource(facilities, kind, ctx.vendor, ctx.ticker, ctx.interval) as SourceSpec
      } else if (display === 'sentiment') {
        source = totalsSource(facilities, kind, ctx.vendor, ctx.ticker, ctx.interval) as SourceSpec
      } else {
        const raw = Number(ctx.indicator.calcParams?.[0])
        const rangePct = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FLOW_RANGE_PCT
        source = nearSource(facilities, kind, ctx.vendor, ctx.ticker, ctx.interval, rangePct) as SourceSpec
      }
      if (display === 'view') {
        // The crosshair, as a subscription on the shared profile store: moving the
        // pointer bumps the store's rev (through a rAF throttle) so the host re-applies
        // and the viewer redraws with the hovered bar's book. The disposer unhooks with
        // the binding, which is what keeps a torn-down wall from leaking callbacks.
        const chart = ctx.chart
        source = {
          ...(source as SourceSpec<BookProfilePoint>),
          subscribe: (store, notify) => {
            let queued = false
            const cb = (payload: unknown) => {
              // This fork's crosshair event carries only {x, y, paneId}; a stock
              // klinecharts one carries dataIndex too. Take it when present, else
              // convert the x pixel through the chart.
              const c = payload as { dataIndex?: number; x?: number; paneId?: string } | undefined
              let next: number | null = typeof c?.dataIndex === 'number' ? c.dataIndex : null
              if (next === null && typeof c?.x === 'number') {
                const point = chart.convertFromPixel([{ x: c.x }], { paneId: c.paneId ?? 'candle_pane' })
                const p = Array.isArray(point) ? point[0] : point
                if (typeof p?.dataIndex === 'number') next = p.dataIndex
              }
              if (hoverIndex.get(chart) === next) return
              hoverIndex.set(chart, next)
              if (queued) return
              queued = true
              const fire = () => {
                queued = false
                store.rev++
                notify.changed()
              }
              if (typeof requestAnimationFrame === 'function') requestAnimationFrame(fire)
              else setTimeout(fire, 16)
            }
            chart.subscribeAction('onCrosshairChange', cb)
            return () => chart.unsubscribeAction('onCrosshairChange', cb)
          }
        } as SourceSpec
      }
      const base = baseLabel(display, kind)
      return {
        sources: [source],
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
        extendData: (state: BindingState) => ({ chartInterval: state.chartInterval }),
        yAxisGap: display === 'sentiment' || display === 'flow' ? AXIS_GAP : undefined
      }
    }
  }
}
