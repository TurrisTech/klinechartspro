import type { ChartProPane } from '../../src'
import { createLayerController, type LayerController } from '../chartlayers/controller'
import { createLayerPlugin } from '../chartlayers/plugin'
import { levels2Layer } from '../levels2/layer'
import type { IndicatorPlugin } from '../plugins/types'
import { levelsLayer } from './layer'

// Levels and Zones, the two chart layers, as indicators in the picker's "Levels" group on the
// price pane (chartlayers/plugin.ts). Built by the caller rather than inside the plugin
// registry because the replay drives the Levels controller directly (a day boundary
// invalidates it), and because the controllers follow the wall's panes themselves.

/** Saved walls name their indicators by template, so these names are a compatibility surface:
 * never rename one. The suffix is the layer id, which is also the server's route. */
export const LEVELS_TEMPLATE = 'LEVELS:levels'
export const ZONES_TEMPLATE = 'LEVELS:levels2'

export interface LevelsIndicators {
  plugin: IndicatorPlugin
  levels: LayerController
  zones: LayerController
  /** Both controllers, from `ChartProOptions.onPanesChange`; `sync([])` at teardown. */
  sync(panes: ChartProPane[]): void
}

export function createLevelsIndicators(): LevelsIndicators {
  const levels = createLayerController(levelsLayer, LEVELS_TEMPLATE)
  const zones = createLayerController(levels2Layer, ZONES_TEMPLATE)
  const plugin = createLayerPlugin({
    id: 'levels',
    group: 'Levels',
    layers: [
      {
        controller: levels,
        description:
          'Support and resistance lines computed on weekly and monthly bars, each drawn from where it was confirmed and a shade darker after every test. Timeframes, spent levels, line style and emphasis on the gear.'
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
    sync(panes) {
      levels.sync(panes)
      zones.sync(panes)
    }
  }
}
