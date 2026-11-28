import type { ChartProPane, KLineChartPro } from '../../src'
import type { MtfConfig } from '../mtf/config'
import type { EditorContext } from './editor'
import { defaultGraphSettings, graphOverlays, graphSettingsOf } from './graphentry'
import { periodToResolution } from '../time/intervals'
import { symbolKey } from '../instrumentkey'

// THE ALERT EDITOR'S CONTEXT ON A WALL: where a new alert starts and what it may copy, read off
// the wall as it stands each time the editor asks (`mountAlertManager`'s `context`). Until
// 2026-11-28 it was written inline where client/index.ts mounts the alert manager.

/** A pane's settings for one indicator template, as the plugin host keeps them
 * (`PluginHost.settingsModel(template)?.read(paneId)`): null when the pane has none, or the
 * template has no settings. */
export type PaneSettingsReader = (template: string, paneId: string) => object | null

/** The editor's context on `chartPro`'s wall: a new alert starts on the active pane's
 * instrument and timeframe, its instrument field offers the wall's instruments, and a graph
 * entry condition copies an overlay's graph settings from the panes (`paneSettings`). */
export function wallEditorContext(chartPro: KLineChartPro | null, paneSettings: PaneSettingsReader): EditorContext {
  const panes = chartPro?.getPanes() ?? []
  const active = chartPro?.getPane(chartPro.getActivePaneId()) ?? panes[0]
  return {
    symbol: active ? symbolKey(active.getSymbol()) : '',
    interval: active ? periodToResolution(active.getPeriod()) : '1h',
    symbols: [...new Set(panes.map((p) => symbolKey(p.getSymbol())))],
    // A graph entry condition copies an overlay's graph settings from the active pane when
    // that pane carries the overlay, else from the first pane that does, else its defaults.
    graphSettings: (overlayId) => {
      const overlay = graphOverlays().find((o) => o.id === overlayId)
      const carries = (pane: ChartProPane | undefined): boolean =>
        !!overlay && (pane?.getChart()?.getIndicators({ name: overlay.templateName }).length ?? 0) > 0
      const pane = [active, ...panes].find(carries)
      if (!overlay || !pane) return defaultGraphSettings()
      const config = paneSettings(overlay.templateName, pane.id) as MtfConfig | null
      return graphSettingsOf(config ?? undefined, `pane ${panes.indexOf(pane) + 1}`)
    }
  }
}
