import { describe, expect, test } from 'bun:test'
import { installWindow } from './testing'

installWindow()
const { createPaneSettings } = await import('./panesettings')
const { paneConfig } = await import('./paneconfig')
const { fakeChart, fakePane } = await import('./testing')
import type { SettingsPanelOptions } from '../chartlayers/settings'
import type { PaneConfig, PaneDoc } from './paneconfig'
import type { SettingsPane } from './panesettings'
import type { IndicatorPlugin } from './types'

// Every pane's settings on their own, without a host: the pane lookup and the rebind are the two
// things they ask of one.

type Size = { size: number }

const SIZE_SPEC: PaneConfig<Size> = {
  templates: ['SZ', 'SZ:price'],
  doc: 'sz',
  title: 'Size',
  fields: [{ kind: 'number', key: 'size', label: 'Size', min: 1, max: 9, step: 1 }],
  defaults: { size: 1 },
  normalise: (config) => ({ size: Math.min(9, Math.max(1, Math.round(config.size))) }),
  toStored: (config) => (config.size === 1 ? undefined : { size: config.size }),
  fromStored: (stored) => {
    const size = (stored as Partial<Size> | undefined)?.size
    return typeof size === 'number' ? { size } : undefined
  }
}
const SIZE = paneConfig(SIZE_SPEC)

function plugin(id: string, paneConfigs = [SIZE]): IndicatorPlugin {
  return { id, feature: null, paneConfigs, register: () => [], matches: () => false, bind: () => null }
}

/** Settings over a wall of `ids` (wall position = index), recording rebinds, saves and panels. */
function setup(options: { paneDocs?: Record<number, PaneDoc | undefined>; registered?: IndicatorPlugin[]; all?: IndicatorPlugin[]; ids?: string[] } = {}) {
  const sized = plugin('sized')
  const wall = new Map<string, SettingsPane>()
  for (const [i, id] of (options.ids ?? ['p1', 'p2']).entries()) {
    const fc = fakeChart()
    ;(fc.chart as unknown as { getDom: () => unknown }).getDom = () => ({ getBoundingClientRect: () => ({ top: 10, left: 20 }) })
    wall.set(id, { pane: fakePane(id, fc.chart), paneIndex: i, chart: fc.chart })
  }
  const rebound: string[] = []
  const opened: SettingsPanelOptions<object>[] = []
  let closed = 0
  let persisted = 0
  const settings = createPaneSettings({
    registered: options.registered ?? [sized],
    all: options.all ?? options.registered ?? [sized],
    paneDocs: options.paneDocs,
    requestPersist: () => void persisted++,
    openSettingsPanel: (panel) => {
      opened.push(panel as unknown as SettingsPanelOptions<object>)
      return {
        close() {
          closed++
        }
      }
    },
    facilities: { periodToResolution: (p) => p.text },
    paneOf: (id) => wall.get(id),
    rebind: (id) => rebound.push(id)
  })
  return { settings, wall, rebound, opened, closed: () => closed, persisted: () => persisted }
}

describe('createPaneSettings', () => {
  test("a template's revision is part of the signature only where its plugin declares settings", () => {
    const { settings } = setup({ paneDocs: { 1: { sz: { size: 3 } } } })
    expect(settings.rev('MA', 0)).toBeNull()
    // Every template a config names shares it.
    expect(settings.rev('SZ', 1)).toBe(settings.rev('SZ:price', 1))
    const before = settings.rev('SZ', 1)
    settings.bindConfig('SZ', 'p2', 1).editConfig?.('size', 4)
    expect(settings.rev('SZ', 1)).toBe((before as number) + 1)
  })

  test("a binding is handed its pane's config and an edit of it: kept, saved, and only that pane rebound", () => {
    const { settings, rebound, persisted } = setup({ paneDocs: { 1: { sz: { size: 3 } } } })
    expect(settings.bindConfig('MA', 'p1', 0)).toEqual({ config: undefined, editConfig: undefined })
    expect(settings.bindConfig('SZ', 'p1', 0).config).toEqual({ size: 1 })
    const second = settings.bindConfig('SZ', 'p2', 1)
    expect(second.config).toEqual({ size: 3 })
    second.editConfig?.('size', 42)
    expect(rebound).toEqual(['p2'])
    expect(persisted()).toBe(1)
    expect(settings.paneDocs()).toEqual({ 1: { sz: { size: 9 } } })
  })

  test('an edit is written at the pane\'s position when it is made, and not at all for a pane gone', () => {
    const { settings, wall, rebound } = setup()
    const edit = settings.bindConfig('SZ', 'p1', 0).editConfig
    // The pane moved to the second position after its binding was made.
    wall.set('p1', { ...(wall.get('p1') as SettingsPane), paneIndex: 1 })
    edit?.('size', 5)
    expect(settings.paneDocs()).toEqual({ 1: { sz: { size: 5 } } })
    wall.delete('p1')
    edit?.('size', 6)
    expect(rebound).toEqual(['p1'])
  })

  test("the gear opens one panel at a time, titled with its pane, and an edit there is that pane's", () => {
    const { settings, opened, closed, rebound } = setup({ paneDocs: { 0: { sz: { size: 2 } } } })
    expect(settings.ownsSettings('SZ:price')).toBe(true)
    expect(settings.ownsSettings('MA')).toBe(false)
    expect(settings.handleSettings({ indicatorName: 'MA', paneId: 'p1', chartPaneId: 'candle_pane', calcParams: [] })).toBe(false)
    expect(settings.handleSettings({ indicatorName: 'SZ', paneId: 'p9', chartPaneId: 'candle_pane', calcParams: [] })).toBe(false)
    expect(settings.handleSettings({ indicatorName: 'SZ', paneId: 'p1', chartPaneId: 'candle_pane', calcParams: [] })).toBe(true)
    expect(opened[0].title).toBe('Size · EURUSD 1h')
    expect(opened[0].config).toEqual({ size: 2 })
    expect(opened[0].anchorRect).toEqual({ top: 10, bottom: 34, left: 28 })
    opened[0].onChange({ size: 7 })
    expect(rebound).toEqual(['p1'])
    expect(settings.paneDocs()).toEqual({ 0: { sz: { size: 7 } } })
    // A second gear closes the first panel.
    settings.handleSettings({ indicatorName: 'SZ', paneId: 'p2', chartPaneId: 'candle_pane', calcParams: [] })
    expect(closed()).toBe(1)
    settings.close()
    expect(closed()).toBe(2)
    settings.close()
    expect(closed()).toBe(2)
  })

  test('the manager reads and writes by wall pane; a pane not wired reads nothing', () => {
    const { settings } = setup({ paneDocs: { 1: { sz: { size: 3 } } } })
    expect(settings.settingsModel('MA')).toBeNull()
    const model = settings.settingsModel('SZ')
    expect(model?.fields).toBe(SIZE.fields)
    expect(model?.read('p2')).toEqual({ size: 3 })
    expect(model?.read('p9')).toBeNull()
    model?.write('p1', 'size', 4)
    model?.write('p9', 'size', 5)
    expect(settings.paneDocs()).toEqual({ 0: { sz: { size: 4 } }, 1: { sz: { size: 3 } } })
  })

  test("panes changing places take their settings; a plugin not registered keeps its panes' through a save", () => {
    const other = plugin('other', [paneConfig({ ...SIZE_SPEC, templates: ['OT'], doc: ['mx', 'other'] })])
    const { settings } = setup({
      registered: [plugin('sized')],
      all: [plugin('sized'), other],
      paneDocs: { 0: { sz: { size: 3 }, mx: { other: { size: 8 } } }, 1: { junk: 1 } }
    })
    expect(settings.ownsSettings('OT')).toBe(false)
    expect(settings.paneDocs()).toEqual({ 0: { sz: { size: 3 }, mx: { other: { size: 8 } } } })
    settings.reorderPanes([1, 0])
    expect(settings.paneDocs()).toEqual({ 1: { sz: { size: 3 }, mx: { other: { size: 8 } } } })
  })
})
