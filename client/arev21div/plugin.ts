import type { IndicatorGroup } from '../../src'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities, SettingsRequest } from '../plugins/types'
import { loadRegistry, type RegistryIndicator } from '../tsregistry/api'
import { storedSource } from '../tsregistry/plugin'
import { DIV_DEFAULTS, DIV_FIELDS, normaliseDivConfig, type DivConfig } from './config'
import { isDivergenceIndicator, registerDivergenceIndicators } from './templates'

// The arev21 divergence as a client plugin: computed entirely in the browser, from the bars the
// pane holds and arev21's stored p. Its one source IS the registry's arev21 source -- same key,
// same factory, same tiles-first fetch -- so beside an AREV21 pane it costs no request at all,
// and without one it costs exactly what an AREV21 pane would. The rule and the drawing are
// divergence.ts and templates.ts; this says what to read, and owns the settings.
//
// Settings are per chart pane and shared by both templates, persisted in the wall document
// (client/layout.ts's PersistedPane.dv) the way the AREV lab persists its own: this plugin is
// their only writer, an edit bumps the pane's revision, the revision is part of the binding
// signature, and the rebind hands both templates the new config through extendData.

/** The registry row whose p this reads. */
export const SOURCE_NAME = 'arev21'

const LEGEND_ROW_HEIGHT = 24

export function createArev21DivergencePlugin(load: () => Promise<RegistryIndicator[]> = loadRegistry): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  let entry: RegistryIndicator | null = null
  const configs: Record<number, DivConfig> = {}
  const configRevs: Record<number, number> = {}
  let panel: { close(): void } | null = null

  const configFor = (paneIndex: number): DivConfig => configs[paneIndex] ?? DIV_DEFAULTS

  const label = (state: BindingState): string => {
    const store = state.sources[0]?.store
    if (!store || store.phase === 'idle' || store.phase === 'loading') return 'AREV21 DIVERGENCE · loading'
    if (store.phase === 'error') return 'AREV21 DIVERGENCE · error'
    return 'AREV21 DIVERGENCE'
  }

  const openPanel = (paneId: string): boolean => {
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
    panel?.close()
    panel = f.openSettingsPanel<DivConfig>({
      anchor,
      anchorRect: { top: chartRect.top, bottom: chartRect.top + LEGEND_ROW_HEIGHT, left: chartRect.left + 8 },
      title: `AREV21 divergence · ${info.pane.getSymbol().ticker} ${f.periodToResolution(info.pane.getPeriod())}`,
      fields: DIV_FIELDS,
      config: configFor(paneIndex),
      defaults: DIV_DEFAULTS,
      onChange: (next) => {
        // Clamped before it reaches a binding: the number inputs commit every keystroke.
        configs[paneIndex] = normaliseDivConfig(next)
        configRevs[paneIndex] = (configRevs[paneIndex] ?? 0) + 1
        f.requestPersist()
        f.requestReconcile(paneId)
      },
      onClose: () => {
        panel = null
      }
    })
    return true
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
    signature: (ctx) => [configRevs[ctx.paneIndex] ?? 0],
    bind(ctx: BindContext): BindingSpec | null {
      if (!facilities || !entry) return null
      const config = configFor(ctx.paneIndex)
      // No params on the source: the settings are applied in `calc` and `draw`, so an edit
      // recomputes without refetching and the store stays the AREV21 pane's.
      return { sources: [storedSource(facilities, entry, ctx)], label, extendData: () => ({ config }) }
    },
    handleSettings(request: SettingsRequest): boolean {
      if (!isDivergenceIndicator(request.indicatorName)) return false
      return openPanel(request.paneId)
    },
    ownsSettings: (templateName) => isDivergenceIndicator(templateName),
    paneState: {
      hydrate(initial) {
        for (const [index, config] of Object.entries(initial)) {
          if (config) configs[Number(index)] = normaliseDivConfig(config)
        }
      },
      snapshot: () => ({ ...configs })
    },
    dispose() {
      panel?.close()
      panel = null
    }
  }
}
