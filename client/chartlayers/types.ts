import type { Chart, OverlayCreate } from 'klinecharts'
import type { SymbolInfo } from '../../src'
import type { SettingsField } from './settings'

// What a layer's fetch/toOverlays get to work with — the slice of chart state every
// server-derived overlay layer needs, computed once per redraw and handed to whichever
// layer is active. `to` doubles as the "now" reference for age-style metrics: measuring age
// against the visible range's right edge, not wall-clock time, means "how old is this" reads
// correctly when panning through history and collapses to the obvious answer at the live edge.
export interface LayerContext {
  chart: Chart
  symbol: SymbolInfo
  vendor: string
  priceMin: number
  priceMax: number
  from: number
  to: number
}

// One server-derived, price-anchored chart layer: fetch data for the current view, turn it
// into overlays, and (optionally) expose settings a user can change without refetching.
// `client/levels/layer.ts` is the reference implementation; a second layer is a new module
// shaped like it, not a fork of the mounting/caching code in controller.ts.
export interface ChartLayer<TDatum, TConfig> {
  /** Also the overlay groupId and the persisted-settings key — must be stable and unique. */
  id: string
  /** The single toolbar button's text — click opens the settings panel, whose first row is
   * always the enable/disable switch regardless of what `fields` adds below it. */
  label: string
  available(symbol: SymbolInfo, vendor: string): boolean
  defaults: TConfig
  /** Layer-specific settings, shown below the enable/disable switch. May be empty. */
  fields: SettingsField[]
  /** Refetch only when this changes between redraws; otherwise restyle from the cache. */
  queryKey(ctx: LayerContext, config: TConfig): string
  fetch(ctx: LayerContext, config: TConfig): Promise<TDatum[]>
  toOverlays(data: TDatum[], ctx: LayerContext, config: TConfig): OverlayCreate[]
  /** Defaults to the controller's own redraw debounce when omitted. */
  debounceMs?: number
}
