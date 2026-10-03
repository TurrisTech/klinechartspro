import { type IndicatorTemplate, registerIndicator } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import type { Feature } from '../capabilities'
import type { BindContext, BindingSpec, IndicatorPlugin, PluginFacilities, PluginSettings, SettingsRequest } from '../plugins/types'
import type { LayerController } from './controller'
import { setByPath } from './settings'

// The chart layers as indicators: each layer's controller (controller.ts) draws a pane's
// overlays while that pane carries the layer's template, and this plugin is everything else an
// indicator has -- the picker entry, the legend, the gear's settings panel, the indicator
// manager's inline settings and the per-pane settings in the wall document.
//
// One plugin for every layer, not one each: the picker keys a group by its label, so two
// plugins could not both put an entry under "Levels".
//
// The template draws nothing. A layer's objects are price-anchored overlays with lifespans
// that predate the loaded bars (chartlayers/README.md), drawn by the controller; the template
// exists to be added, hidden, removed and configured like any other indicator. It reads
// nothing through the plugin host either -- a layer fetches by price band as well as time,
// which the host's sources cannot express -- so a binding has no sources and only names the
// layer in the legend.

const LEGEND_ROW_HEIGHT = 24

export interface LayerIndicator {
  controller: LayerController
  /** The picker's hover text. */
  description: string
  /** The server feature the layer needs. Without it the layer is still in the picker -- the
   * old toolbar button stayed too, greyed out -- and its legend says it is not served. */
  feature?: Feature
}

const registered = new Set<string>()

function registerTemplate(name: string, shortName: string): void {
  if (registered.has(name)) return
  const template: IndicatorTemplate = {
    name,
    shortName,
    // Never TIGHTENS the price axis (klinecharts takes the smallest precision of the pane's
    // indicators); the instrument's own is applied as an override when bound.
    precision: 5,
    // Must stay empty: klinecharts prints calcParams into the legend, and the settings are the
    // pane's layer config, edited on the gear.
    calcParams: [],
    shouldOhlc: false,
    shouldFormatBigNumber: false,
    visible: true,
    zLevel: 0,
    series: 'price',
    // No figures and `draw` returns true: nothing of this template's own is drawn, and nothing
    // can enter -- and flatten -- the candles' price axis.
    figures: [],
    minValue: null,
    maxValue: null,
    styles: null,
    calc: (dataList) => dataList.map(() => ({})),
    regenerateFigures: null,
    createTooltipDataSource: null,
    draw: () => true
  }
  registerIndicator(template)
  registered.add(name)
}

export function createLayerPlugin(options: { id: string; group: string; layers: LayerIndicator[] }): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  let panel: { close(): void } | null = null
  // Per layer and pane, bumped by every settings edit: part of the binding signature, so the
  // legend (which names the timeframes drawn) follows the settings.
  const revs = new Map<string, number>()
  const byTemplate = new Map(options.layers.map((entry) => [entry.controller.template, entry]))

  const revKey = (template: string, paneIndex: number): string => `${template}|${paneIndex}`

  const apply = (entry: LayerIndicator, paneIndex: number, paneId: string, next: unknown): void => {
    entry.controller.setConfig(paneIndex, next)
    const key = revKey(entry.controller.template, paneIndex)
    revs.set(key, (revs.get(key) ?? 0) + 1)
    facilities?.requestPersist()
    facilities?.requestReconcile(paneId)
  }

  const settingsFor = (entry: LayerIndicator): PluginSettings => ({
    fields: entry.controller.layer.fields,
    read: (paneIndex) => entry.controller.configFor(paneIndex),
    write: (paneIndex, paneId, key, value) => {
      const next = structuredClone(entry.controller.configFor(paneIndex))
      setByPath(next, key, value)
      apply(entry, paneIndex, paneId, next)
    }
  })

  const openPanel = (entry: LayerIndicator, paneId: string): boolean => {
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
    const { layer } = entry.controller
    panel?.close()
    panel = f.openSettingsPanel<object>({
      anchor,
      anchorRect: { top: chartRect.top, bottom: chartRect.top + LEGEND_ROW_HEIGHT, left: chartRect.left + 8 },
      title: `${layer.label} · ${info.pane.getSymbol().ticker} ${f.periodToResolution(info.pane.getPeriod())}`,
      fields: layer.fields,
      config: entry.controller.configFor(paneIndex),
      defaults: layer.defaults,
      onChange: (next) => apply(entry, paneIndex, paneId, next),
      onClose: () => {
        panel = null
      }
    })
    return true
  }

  // The legend: the layer's name and the timeframes it is drawing, or why it draws nothing.
  // Coverage is per instrument, and the old toolbar button said so by greying out; a legend
  // that reads only "Zones" over an empty chart would leave the user wondering.
  const legend = (entry: LayerIndicator, ctx: BindContext): string => {
    const { layer } = entry.controller
    if (entry.feature && !facilities?.hasFeature(entry.feature)) return `${layer.label} · not served here`
    if (!layer.available(ctx.symbol, ctx.vendor)) return `${layer.label} · none for ${ctx.ticker}`
    const config = entry.controller.configFor(ctx.paneIndex) as { intervals?: Record<string, boolean> }
    const intervals = Object.entries(config.intervals ?? {})
      .filter(([, on]) => on)
      .map(([code]) => code)
    if (config.intervals && intervals.length === 0) return `${layer.label} · no timeframe chosen`
    return intervals.length > 0 ? `${layer.label} ${intervals.join(' ')}` : layer.label
  }

  return {
    id: options.id,
    // `/levels` is as old as the chart; a layer that needs more says so in its legend.
    feature: null,
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      const items = options.layers.map(({ controller, description }) => {
        registerTemplate(controller.template, controller.layer.label)
        return { name: controller.template, label: controller.layer.label, description }
      })
      return items.length > 0 ? [{ label: options.group, main: true, items }] : []
    },
    matches: (name) => byTemplate.has(name),
    signature: (ctx) => revs.get(revKey(ctx.indicator.name, ctx.paneIndex)) ?? 0,
    bind(ctx: BindContext): BindingSpec | null {
      const entry = byTemplate.get(ctx.indicator.name)
      if (!entry) return null
      const precision = ctx.symbol.pricePrecision
      return {
        sources: [],
        label: () => legend(entry, ctx),
        overrides: typeof precision === 'number' ? { precision } : undefined
      }
    },
    handleSettings(request: SettingsRequest): boolean {
      const entry = byTemplate.get(request.indicatorName)
      return entry ? openPanel(entry, request.paneId) : false
    },
    ownsSettings: (templateName) => byTemplate.has(templateName),
    settings: (templateName) => {
      const entry = byTemplate.get(templateName)
      return entry ? settingsFor(entry) : null
    },
    paneState: {
      // By pane index, then by layer id: `{ 0: { levels: {...}, levels2: {...} } }`.
      hydrate(initial) {
        for (const { controller } of options.layers) {
          const mine: Record<number, unknown> = {}
          for (const [index, layers] of Object.entries(initial)) {
            const stored = (layers as Record<string, unknown> | null)?.[controller.layer.id]
            if (stored !== undefined) mine[Number(index)] = stored
          }
          controller.hydrate(mine)
        }
      },
      snapshot() {
        const out: Record<number, Record<string, unknown>> = {}
        for (const { controller } of options.layers) {
          for (const [index, stored] of Object.entries(controller.snapshot())) {
            out[Number(index)] = { ...out[Number(index)], [controller.layer.id]: stored }
          }
        }
        return out
      }
    },
    dispose() {
      panel?.close()
      panel = null
    }
  }
}
