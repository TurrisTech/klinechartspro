import type { IndicatorGroup } from '../../src'
import { paneConfig } from '../plugins/paneconfig'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities } from '../plugins/types'
import { loadRegistry, type RegistryIndicator } from '../tsregistry/api'
import { storedSource } from '../tsregistry/plugin'
import { DIV_DEFAULTS, DIV_FIELDS, fromStoredDivConfig, normaliseDivConfig, toStoredDivConfig, type DivConfig } from './config'
import { isDivergenceIndicator, PRICE_TEMPLATE, registerDivergenceIndicators, SUB_TEMPLATE } from './templates'
import { phaseLabel } from '../plugins/legend'

// The arev21 divergence as a client plugin: computed entirely in the browser, from the bars the
// pane holds and arev21's stored p. Its one source IS the registry's arev21 source -- same key,
// same factory, same tiles-first fetch -- so beside an AREV21 pane it costs no request at all,
// and without one it costs exactly what an AREV21 pane would. The rule and the drawing are
// divergence.ts and templates.ts; this says what to read, and what its settings are.
//
// Settings are per chart pane and shared by both templates (the prediction-pane row and the
// price-pane row in the indicator manager edit the same settings), kept by the host and
// persisted in the wall document as `PersistedPane.dv`. An edit rebinds, and the rebind hands
// both templates the new config through extendData.

/** The registry row whose p this reads. */
export const SOURCE_NAME = 'arev21'

export const DIV_PANE_CONFIG = paneConfig<DivConfig>({
  templates: [SUB_TEMPLATE, PRICE_TEMPLATE],
  doc: 'dv',
  title: 'AREV21 divergence',
  fields: DIV_FIELDS,
  defaults: DIV_DEFAULTS,
  normalise: normaliseDivConfig,
  toStored: toStoredDivConfig,
  fromStored: fromStoredDivConfig
})

export function createArev21DivergencePlugin(load: () => Promise<RegistryIndicator[]> = loadRegistry): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  let entry: RegistryIndicator | null = null

  const label = (state: BindingState): string => phaseLabel('AREV21 DIVERGENCE', [state.sources[0]?.store]) ?? 'AREV21 DIVERGENCE'

  return {
    id: 'arev21div',
    // Reads arev21's stored series, so it is gated on the capability that serves it.
    feature: 'arev',
    paneConfigs: [DIV_PANE_CONFIG],
    async register(f: PluginFacilities): Promise<IndicatorGroup[]> {
      facilities = f
      // Offered only where this server serves arev21; the registry says so and says how to
      // read it.
      const rows = await load()
      entry = rows.find((r) => r.enabled && r.name === SOURCE_NAME && r.wire.plugin === 'arev') ?? null
      return entry ? registerDivergenceIndicators() : []
    },
    matches: isDivergenceIndicator,
    bind(ctx: BindContext): BindingSpec | null {
      if (!facilities || !entry) return null
      const config = ctx.config as DivConfig
      // No params on the source: the settings are applied in `calc` and `draw`, so an edit
      // recomputes without refetching and the store stays the AREV21 pane's.
      return { sources: [storedSource(facilities, entry, ctx)], label, extendData: () => ({ config }) }
    }
  }
}
