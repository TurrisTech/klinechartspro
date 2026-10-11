import type { IndicatorGroup } from '../../src'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities, SourceSpec } from '../plugins/types'
import {
  DEFAULT_FLOW_RANGE_PCT,
  OWN_BOOKS,
  nearSource,
  profileSource,
  totalsSource,
  type BookFeed
} from './api'
import { hoverIndex, parseTemplateName, registerBooksIndicators } from './templates'
import { AXIS_GAP } from '../plugins/draw'
import { phaseLabel } from '../plugins/legend'

// The OANDA books as a client plugin (templates.ts has the catalogue of displays). One
// source per binding; the depth overlay and the hover viewer of one kind share the
// profile source's key, so a wall showing both pays for one fetch. Nothing to subscribe
// for data — the books are a 20-minute REST grid, not a stream; new snapshots appear on
// the next fetch — but the hover viewer does subscribe the CROSSHAIR, which is what makes
// "the book at the candle under the pointer" repaint as the pointer moves.


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

/** One plugin per book store: `OWN_BOOKS` (this environment's) or `DEV_BOOKS` (the dev
 * store, where the server advertises it). Same displays; its own templates and source keys. */
export function createBooksPlugin(feed: BookFeed = OWN_BOOKS): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  return {
    id: feed.pluginId,
    feature: feed.pluginId,
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      return registerBooksIndicators(feed)
    },
    matches: (name) => parseTemplateName(name, feed) !== null,
    bind(ctx: BindContext): BindingSpec | null {
      const parsed = parseTemplateName(ctx.indicator.name, feed)
      if (!parsed || !facilities) return null
      if (feed.vendors !== null && !feed.vendors.includes(ctx.vendor)) return null
      const { display, kind } = parsed
      let source: SourceSpec
      if (display === 'depth' || display === 'view') {
        source = profileSource(facilities, kind, ctx.vendor, ctx.ticker, ctx.interval, feed) as SourceSpec
      } else if (display === 'sentiment') {
        source = totalsSource(facilities, kind, ctx.vendor, ctx.ticker, ctx.interval, feed) as SourceSpec
      } else {
        const raw = Number(ctx.indicator.calcParams?.[0])
        const rangePct = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FLOW_RANGE_PCT
        source = nearSource(facilities, kind, ctx.vendor, ctx.ticker, ctx.interval, rangePct, feed) as SourceSpec
      }
      // The hover viewer follows the crosshair. What it draws is the hovered bar's book, which
      // `draw` reads off `hoverIndex`; nothing it CALCULATES changes, so a move asks for a redraw
      // and nothing more. Until 2026-10-11 it bumped the shared profile store's revision, which
      // recomputed this template and the depth overlay on the same store over every bar, per
      // frame of pointer movement.
      const chart = ctx.chart
      const { id, name, paneId } = ctx.indicator
      const attach =
        display === 'view'
          ? () => {
              let queued = false
              const redraw = (): void => {
                queued = false
                try {
                  chart.overrideIndicator({ id, name, paneId })
                } catch {
                  // chart already disposed
                }
              }
              const cb = (payload: unknown): void => {
                // This fork's crosshair event carries only {x, y, paneId}; a stock klinecharts
                // one carries dataIndex too. Take it when present, else convert the x pixel
                // through the chart.
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
                if (typeof requestAnimationFrame === 'function') requestAnimationFrame(redraw)
                else setTimeout(redraw, 16)
              }
              chart.subscribeAction('onCrosshairChange', cb)
              return () => chart.unsubscribeAction('onCrosshairChange', cb)
            }
          : undefined
      const base = `${baseLabel(display, kind)}${feed.suffix}`
      return {
        sources: [source],
        label: (state: BindingState) => phaseLabel(base, [state.sources[0]?.store]) ?? base,
        extendData: (state: BindingState) => ({ chartInterval: state.chartInterval }),
        yAxisGap: display === 'sentiment' || display === 'flow' ? AXIS_GAP : undefined,
        attach
      }
    }
  }
}
