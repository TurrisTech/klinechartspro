import type { Chart, OverlayCreate } from 'klinecharts'
import type { SymbolInfo } from '../../src'
import type { SettingsField } from './settings'

// One rectangle of the price/time plane. A pane fetches these, not "whatever is on screen":
// the controller remembers which window each pane already holds and asks only for the parts
// of a bigger window it is missing (controller.ts's missingWindows), so panning or rescaling
// the price axis extends the loaded set instead of re-requesting it.
export interface LayerWindow {
  priceMin: number
  priceMax: number
  from: number
  to: number
}

// What a layer's fetch/toOverlays get to work with — the slice of chart state every
// server-derived overlay layer needs, computed once per redraw and handed to whichever
// layer is active. Its own window is the one currently *on screen* (the price axis's band,
// padded, and the visible bars' time span), which is what toOverlays should paint; a fetch
// is separately told which window to request. `to` doubles as the "now" reference for
// age-style metrics: measuring age against the visible range's right edge, not wall-clock
// time, means "how old is this" reads correctly when panning through history and collapses
// to the obvious answer at the live edge.
export interface LayerContext extends LayerWindow {
  chart: Chart
  symbol: SymbolInfo
  vendor: string
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
  /** Everything that identifies a request EXCEPT its price/time window. A change here
   * throws a pane's accumulated data away; a window change only fetches what is missing,
   * so the window must NOT be part of this. */
  cacheKey(ctx: LayerContext, config: TConfig): string
  /** Stable identity of one datum, used to drop duplicates when a freshly fetched window is
   * merged into what a pane already holds — adjacent windows share their edges. */
  datumKey(datum: TDatum): string
  /** Fetch exactly `window`, which is a sub-window of the view, not necessarily the view. */
  fetch(ctx: LayerContext, config: TConfig, window: LayerWindow): Promise<TDatum[]>
  toOverlays(data: TDatum[], ctx: LayerContext, config: TConfig): OverlayCreate[]
  /** Defaults to the controller's own redraw debounce when omitted. */
  debounceMs?: number
}
