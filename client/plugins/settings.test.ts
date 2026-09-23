import { describe, expect, test } from 'bun:test'
import { installWindow } from './testing'
import type { PluginFacilities } from './types'

installWindow()

// The indicator manager edits the AREV21 MTF overlay's and the AREV21 divergence's settings
// inline (IndicatorPlugin.settings). What it writes has to land exactly where the plugin's own
// panel writes: the same per-pane config, persisted, and only that pane redrawn.

const { createMtfPlugin } = await import('../mtf/plugin')
const { AREV21_MTF, AREV21_OUTLIER_RANK_85_MTF } = await import('../mtf/overlays')
const { MTF_DEFAULTS } = await import('../mtf/config')
const { createArev21DivergencePlugin } = await import('../arev21div/plugin')
const { PRICE_TEMPLATE, SUB_TEMPLATE } = await import('../arev21div/templates')
const { DIV_DEFAULTS } = await import('../arev21div/config')
import type { RegistryIndicator } from '../tsregistry/api'

function recorder() {
  const calls = { persist: 0, reconcile: [] as Array<string | undefined> }
  const facilities = {
    requestPersist: () => {
      calls.persist++
    },
    requestReconcile: (paneId?: string) => {
      calls.reconcile.push(paneId)
    }
  } as unknown as PluginFacilities
  return { calls, facilities }
}

const ROW = {
  name: 'arev21',
  template: 'AREV:arev21',
  title: 'AREV21',
  enabled: true,
  feature: 'arev',
  source: { kind: 'table', fold_by: null },
  wire: { plugin: 'arev', variant: 'arev21' }
} as unknown as RegistryIndicator

describe('the MTF overlay', () => {
  test('offers its panel fields for its own template only, the graph group only where it draws one', async () => {
    const plain = createMtfPlugin(AREV21_MTF)
    await plain.register(recorder().facilities)
    const settings = plain.settings?.(AREV21_MTF.templateName)
    expect(settings?.fields.map((f) => f.label).slice(0, 2)).toEqual(['3m', '5m'])
    expect(plain.settings?.('MA')).toBeNull()
    const graphed = createMtfPlugin(AREV21_OUTLIER_RANK_85_MTF)
    await graphed.register(recorder().facilities)
    expect(graphed.settings?.(AREV21_OUTLIER_RANK_85_MTF.templateName)?.fields.map((f) => f.label).slice(0, 2)).toEqual(['Graph', '3m'])
    expect(graphed.settings?.(AREV21_MTF.templateName)).toBeNull()
  })

  test('a write changes that pane alone, persists, and redraws that pane', async () => {
    const { calls, facilities } = recorder()
    const plugin = createMtfPlugin(AREV21_OUTLIER_RANK_85_MTF)
    await plugin.register(facilities)
    const settings = plugin.settings?.(AREV21_OUTLIER_RANK_85_MTF.templateName)
    settings?.write(1, 'p2', 'timeframes.4h.color', '#123456')
    settings?.write(1, 'p2', 'graph.roots.8h', true)
    const written = settings?.read(1) as typeof MTF_DEFAULTS
    expect(written.timeframes['4h'].color).toBe('#123456')
    expect(written.graph.roots['8h']).toBe(true)
    expect(settings?.read(0)).toEqual(MTF_DEFAULTS)
    expect(MTF_DEFAULTS.timeframes['4h'].color).not.toBe('#123456')
    expect(calls.persist).toBe(2)
    expect(calls.reconcile).toEqual(['p2', 'p2'])
    // And it is what the wall document stores for that pane.
    expect(plugin.paneState?.snapshot()[1]).toEqual(settings?.read(1))
  })
})

describe('the AREV21 divergence', () => {
  test('both templates edit one config per pane, clamped by its own normaliser', async () => {
    const { calls, facilities } = recorder()
    const plugin = createArev21DivergencePlugin(async () => [ROW])
    await plugin.register(facilities)
    const sub = plugin.settings?.(SUB_TEMPLATE)
    const price = plugin.settings?.(PRICE_TEMPLATE)
    expect(sub?.fields.map((f) => f.label)).toEqual(['Swings', 'Lines'])
    sub?.write(0, 'p1', 'rule.left', 5000)
    price?.write(0, 'p1', 'line.style', 'dashed')
    const config = price?.read(0) as typeof DIV_DEFAULTS
    expect(config.rule.left).toBe(100)
    expect(config.line.style).toBe('dashed')
    expect(sub?.read(0)).toEqual(config)
    expect(sub?.read(1)).toEqual(DIV_DEFAULTS)
    expect(calls.reconcile).toEqual(['p1', 'p1'])
    expect(plugin.settings?.('AREV:arev21')).toBeNull()
  })
})
