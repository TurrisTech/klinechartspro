import type { Chart } from 'klinecharts'
import type { ChartProPane, IndicatorSettingsModel } from '../../src'
import { openSettingsPanel as openPanel, setByPath, type SettingsPanelHandle } from '../chartlayers/settings'
import { type PaneConfig, PaneConfigStore, type PaneDoc } from './paneconfig'
import type { BindContext, IndicatorPlugin, PluginFacilities, SettingsRequest } from './types'

// Every pane's plugin settings, for the host (host.ts): which templates' settings are which
// (`PaneConfig`, paneconfig.ts), what each pane holds (`PaneConfigStore`), the legend gear's
// panel, the indicator manager's fields, a binding's own edit (`BindContext.editConfig`), the
// wall document and panes changing places. The host asks two things of it when it binds --
// the revision that goes into a binding's signature, and the config and edit the binding is
// handed -- and it asks the host to rebind a pane whose settings were edited.
//
// Owned for the plugins that registered, carried verbatim for the rest, so a server that cannot
// draw an overlay does not cost a pane its settings at the next save.

/** Rough height of one klinecharts legend row: a settings panel hangs just below the legend
 * the gear sits in. */
const LEGEND_ROW_HEIGHT = 24

/** What the settings need of a wired pane. */
export interface SettingsPane {
  readonly pane: ChartProPane
  /** Its position on the wall, which its settings are kept under. */
  readonly paneIndex: number
  readonly chart: Chart
}

interface PaneSettingsOptions {
  /** The plugins that registered: their settings are owned. */
  registered: readonly IndicatorPlugin[]
  /** Every plugin of this build, registered or not: what the others declare is carried. */
  all: readonly IndicatorPlugin[]
  /** Each pane's plugin settings as the wall document stored them, by pane index. */
  paneDocs?: Record<number, PaneDoc | undefined>
  /** Ask the app to save the wall: a pane's settings were edited. */
  requestPersist?: () => void
  /** The settings panel; a test passes a recorder. */
  openSettingsPanel?: typeof openPanel
  facilities: Pick<PluginFacilities, 'periodToResolution'>
  /** The pane wired under a ChartProPane id at the moment of asking, if any. */
  paneOf(paneId: string): SettingsPane | undefined
  /** That pane's settings were edited: rebind it. */
  rebind(paneId: string): void
}

export interface PaneSettings {
  /** The revision of the pane's settings for `templateName`, or null when its plugin declares
   * none. Part of every binding's signature, so an edit rebinds. */
  rev(templateName: string, paneIndex: number): number | null
  /** What a binding of `templateName` on the pane is handed: the pane's config, and the edit of
   * one of its fields. Both undefined when its plugin declares no settings for it. */
  bindConfig(templateName: string, paneId: string, paneIndex: number): Pick<BindContext, 'config' | 'editConfig'>
  /** ChartProOptions.indicatorSettingsHandler. */
  handleSettings(request: SettingsRequest): boolean
  /** ChartProOptions.indicatorSettingsOwned. */
  ownsSettings(templateName: string): boolean
  /** ChartProOptions.indicatorSettingsModel: the plugin's settings, addressed by wall pane. */
  settingsModel(templateName: string): IndicatorSettingsModel | null
  /** Every pane's plugin settings as the wall document stores them, by pane index. */
  paneDocs(): Record<number, PaneDoc>
  /** Panes changed places (`order[newIndex] = oldIndex`): every pane's settings move with it. */
  reorderPanes(order: readonly number[]): void
  /** Close the panel, if one is open. */
  close(): void
}

export function createPaneSettings(options: PaneSettingsOptions): PaneSettings {
  const configByTemplate = new Map<string, PaneConfig>()
  for (const plugin of options.registered) for (const config of plugin.paneConfigs ?? []) for (const name of config.templates) configByTemplate.set(name, config)
  const paneConfigs = new PaneConfigStore(
    [...new Set(configByTemplate.values())],
    options.all.flatMap((plugin) => (plugin.paneConfigs ?? []).map((config) => config.doc))
  )
  paneConfigs.hydrate(options.paneDocs ?? {})
  const openSettingsPanel = options.openSettingsPanel ?? openPanel
  let panel: SettingsPanelHandle | null = null

  /** A pane's settings edited, from its panel or from the indicator manager: kept, the wall
   * saved, and only that pane rebound -- the settings belong to it, so another pane showing the
   * same instrument keeps whatever it was set to. */
  const writeConfig = (config: PaneConfig, paneIndex: number, paneId: string, next: object): void => {
    paneConfigs.write(config, paneIndex, next)
    options.requestPersist?.()
    options.rebind(paneId)
  }

  /** One field of a pane's settings, by its dotted key: the indicator manager's edit, and a
   * binding's own (`BindContext.editConfig`). The pane is looked up at the moment of the edit,
   * so one that has since moved on the wall is written at its new index. */
  const editField = (config: PaneConfig, paneId: string, key: string, value: unknown): void => {
    const entry = options.paneOf(paneId)
    if (!entry) return
    const next = structuredClone(paneConfigs.read(config, entry.paneIndex))
    setByPath(next, key, value)
    writeConfig(config, entry.paneIndex, paneId, next)
  }

  const openConfigPanel = (config: PaneConfig, paneId: string): boolean => {
    const entry = options.paneOf(paneId)
    if (!entry) return false
    // The gear is drawn on the chart's CANVAS, not in the DOM, so there is no element to point
    // at. The chart container is what the panel must live inside (it carries the theme class
    // the panel's tokens resolve against), but it is the full height of the pane, so its own
    // rect is the wrong place to hang the panel from -- under its bottom edge is below the
    // fold. Hence an explicit rect: just under the legend row at the chart's top left, which is
    // where the gear that opened it is drawn.
    let anchor: HTMLElement | null = null
    try {
      anchor = entry.chart.getDom() as HTMLElement | null
    } catch {
      anchor = null
    }
    if (!anchor) return false
    const rect = anchor.getBoundingClientRect()
    const paneIndex = entry.paneIndex
    panel?.close()
    panel = openSettingsPanel<object>({
      anchor,
      anchorRect: { top: rect.top, bottom: rect.top + LEGEND_ROW_HEIGHT, left: rect.left + 8 },
      // Names the pane, because the settings are that pane's alone and a wall can have twelve
      // of them open on different instruments.
      title: `${config.title} · ${entry.pane.getSymbol().ticker} ${options.facilities.periodToResolution(entry.pane.getPeriod())}`,
      fields: config.fields,
      config: paneConfigs.read(config, paneIndex),
      defaults: config.defaults,
      onChange: (next) => writeConfig(config, paneIndex, paneId, next),
      onClose: () => {
        panel = null
      }
    })
    return true
  }

  return {
    rev(templateName: string, paneIndex: number): number | null {
      const config = configByTemplate.get(templateName)
      return config ? paneConfigs.rev(config, paneIndex) : null
    },
    bindConfig(templateName: string, paneId: string, paneIndex: number): Pick<BindContext, 'config' | 'editConfig'> {
      const config = configByTemplate.get(templateName)
      return {
        config: config && paneConfigs.read(config, paneIndex),
        editConfig: config ? (key: string, value: unknown) => editField(config, paneId, key, value) : undefined
      }
    },
    handleSettings(request: SettingsRequest): boolean {
      const config = configByTemplate.get(request.indicatorName)
      return config ? openConfigPanel(config, request.paneId) : false
    },
    ownsSettings(templateName: string): boolean {
      return configByTemplate.has(templateName)
    },
    settingsModel(templateName: string): IndicatorSettingsModel | null {
      const config = configByTemplate.get(templateName)
      if (!config) return null
      // Settings are kept by pane INDEX (what the wall document stores them under); the library
      // addresses panes by id. Only a wired pane has an index, and only a wired pane can be
      // holding the indicator.
      return {
        fields: config.fields,
        read: (paneId) => {
          const entry = options.paneOf(paneId)
          return entry ? paneConfigs.read(config, entry.paneIndex) : null
        },
        write: (paneId, key, value) => editField(config, paneId, key, value)
      }
    },
    paneDocs(): Record<number, PaneDoc> {
      return paneConfigs.snapshot()
    },
    reorderPanes(order: readonly number[]): void {
      paneConfigs.reorder(order)
    },
    close(): void {
      panel?.close()
      panel = null
    }
  }
}
