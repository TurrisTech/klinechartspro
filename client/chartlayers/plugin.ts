import { type IndicatorTemplate, registerIndicator } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import type { Feature } from '../capabilities'
import { timestampCalc } from '../plugins/calc'
import { paneConfig } from '../plugins/paneconfig'
import type { BindContext, BindingSpec, IndicatorPlugin, PluginFacilities } from '../plugins/types'
import type { LayerController } from './controller'

// The chart layers as indicators: a binding of a layer's template attaches that layer's view to
// the pane (controller.ts), which draws its overlays for as long as the binding lives, and this
// plugin is everything else an indicator has -- the picker entry and the legend -- plus what the
// layer's settings are, which the host keeps per pane (the gear's panel, the indicator manager,
// the wall document's `ly`).
//
// One plugin for every layer, not one each: the picker keys a group by its label, so two
// plugins could not both put an entry under "Levels".
//
// The template draws nothing. A layer's objects are price-anchored overlays with lifespans
// that predate the loaded bars (chartlayers/README.md), drawn by its view; the template exists
// to be added, hidden, removed and configured like any other indicator. It reads nothing
// through the host's sources either -- a layer fetches by price band as well as time, which a
// source cannot express -- so a binding has no sources, names the layer in the legend, and
// attaches the view.

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
    calc: timestampCalc((dataList) => dataList.map(() => ({}))),
    regenerateFigures: null,
    createTooltipDataSource: null,
    draw: () => true
  }
  registerIndicator(template)
  registered.add(name)
}

export function createLayerPlugin(options: { id: string; group: string; layers: LayerIndicator[] }): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  const byTemplate = new Map(options.layers.map((entry) => [entry.controller.template, entry]))

  // The legend: the layer's name and the timeframes it is drawing, or why it draws nothing.
  // Coverage is per instrument, and the old toolbar button said so by greying out; a legend
  // that reads only "Zones" over an empty chart would leave the user wondering.
  const legend = (entry: LayerIndicator, ctx: BindContext, config: { intervals?: Record<string, boolean> }): string => {
    const { layer } = entry.controller
    if (entry.feature && !facilities?.hasFeature(entry.feature)) return `${layer.label} · not served here`
    if (!layer.available(ctx.symbol, ctx.vendor)) return `${layer.label} · none for ${ctx.ticker}`
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
    // Per pane and per layer, as the pane's `ly` stores them: `{ levels: {...}, levels2: {...} }`,
    // each the differences from the layer's defaults (persist.ts). A pane never configured starts
    // from what the user last chose under the old toolbar button (store.ts).
    paneConfigs: options.layers.map(({ controller }) =>
      paneConfig<object>({
        templates: [controller.template],
        doc: ['ly', controller.layer.id],
        title: controller.layer.label,
        fields: controller.layer.fields,
        defaults: controller.layer.defaults,
        normalise: (config) => controller.codec.normalise(config),
        toStored: (config) => controller.codec.toStored(config),
        fromStored: (stored) => controller.codec.fromStored(stored),
        fallback: () => controller.baseline()
      })
    ),
    async register(f: PluginFacilities): Promise<IndicatorGroup[]> {
      facilities = f
      // A pane is drawn only once the baseline its unconfigured panes start from is known.
      await Promise.all(options.layers.map(({ controller }) => controller.ready))
      const items = options.layers.map(({ controller, description }) => {
        registerTemplate(controller.template, controller.layer.label)
        return { name: controller.template, label: controller.layer.label, description }
      })
      return items.length > 0 ? [{ label: options.group, main: true, items }] : []
    },
    matches: (name) => byTemplate.has(name),
    bind(ctx: BindContext): BindingSpec | null {
      const entry = byTemplate.get(ctx.indicator.name)
      if (!entry) return null
      const config = ctx.config as object
      const precision = ctx.symbol.pricePrecision
      return {
        sources: [],
        label: () => legend(entry, ctx, config),
        overrides: typeof precision === 'number' ? { precision } : undefined,
        attach: () => entry.controller.attach(ctx.pane, ctx.indicator.id, config)
      }
    }
  }
}
