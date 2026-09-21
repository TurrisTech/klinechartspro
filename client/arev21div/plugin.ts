import type { IndicatorGroup } from '../../src'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities } from '../plugins/types'
import { loadRegistry, type RegistryIndicator } from '../tsregistry/api'
import { storedSource } from '../tsregistry/plugin'
import { isDivergenceIndicator, registerDivergenceIndicators } from './templates'

// The arev21 divergence as a client plugin: computed entirely in the browser, from the bars the
// pane holds and arev21's stored p. Its one source IS the registry's arev21 source -- same key,
// same factory, same tiles-first fetch -- so beside an AREV21 pane it costs no request at all,
// and without one it costs exactly what an AREV21 pane would. The rule and the drawing are
// divergence.ts and templates.ts; this only says what to read.

/** The registry row whose p this reads. */
export const SOURCE_NAME = 'arev21'

export function createArev21DivergencePlugin(load: () => Promise<RegistryIndicator[]> = loadRegistry): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  let entry: RegistryIndicator | null = null

  const label = (state: BindingState): string => {
    const store = state.sources[0]?.store
    if (!store || store.phase === 'idle' || store.phase === 'loading') return 'AREV21 DIVERGENCE · loading'
    if (store.phase === 'error') return 'AREV21 DIVERGENCE · error'
    return 'AREV21 DIVERGENCE'
  }

  return {
    id: 'arev21div',
    // Reads arev21's stored series, so it is gated on the capability that serves it.
    feature: 'arev',
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
      // No params on the source: the rule's numbers are calcParams, applied in `calc`, so a
      // settings edit recomputes without refetching and the store stays the AREV21 pane's.
      return { sources: [storedSource(facilities, entry, ctx)], label }
    }
  }
}
