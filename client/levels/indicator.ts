import { PriceAlerts } from '../chartlayers/alerts/hub'
import { createLayerController, type LayerController } from '../chartlayers/controller'
import { createLayerPlugin } from '../chartlayers/plugin'
import { levels2Layer } from '../levels2/layer'
import type { IndicatorPlugin } from '../plugins/types'
import { levelsLayer } from './layer'

// Levels and Zones, the two chart layers, as indicators in the picker's "Levels" group on the
// price pane (chartlayers/plugin.ts). Built by the caller rather than inside the plugin
// registry because the replay drives the Levels controller directly (a day boundary
// invalidates it).

/** Saved walls name their indicators by template, so these names are a compatibility surface:
 * never rename one. The suffix is the layer id, which is also the server's route. */
export const LEVELS_TEMPLATE = 'LEVELS:levels'
export const ZONES_TEMPLATE = 'LEVELS:levels2'

export interface LevelsIndicators {
  plugin: IndicatorPlugin
  levels: LayerController
  zones: LayerController
  /** The price alerts the Levels layer offers its levels to, waiting for the wall's watch
   * backend (`connect`). */
  alerts: PriceAlerts
  /** Lets go of the backend. */
  dispose(): void
}

export function createLevelsIndicators(): LevelsIndicators {
  const alerts = new PriceAlerts()
  const levels = createLayerController(levelsLayer, LEVELS_TEMPLATE, alerts)
  const zones = createLayerController(levels2Layer, ZONES_TEMPLATE)
  const plugin = createLayerPlugin({
    id: 'levels',
    group: 'Levels',
    layers: [
      {
        controller: levels,
        description:
          'Support and resistance lines computed on weekly and monthly bars, each drawn from where it was confirmed and a shade darker after every test. Click a live level to be alerted when price comes within its zone. Timeframes, spent levels, line style, emphasis and the default alert zone on the gear.'
      },
      {
        controller: zones,
        feature: 'levels2',
        description:
          'Support and resistance zones from sparse swing pivots: a price band from when each came into force until it retired, coloured by the side it acts on now. Timeframes, retired zones and band style on the gear.'
      }
    ]
  })
  return {
    plugin,
    levels,
    zones,
    alerts,
    dispose(): void {
      alerts.connect(null)
    }
  }
}
