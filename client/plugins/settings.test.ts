import { describe, expect, test } from 'bun:test'
import { installWindow } from './testing'
import type { PluginFacilities } from './types'

installWindow()

// The indicator manager edits the AREV21 MTF overlay's, the AREV21 divergence's and the AREV
// lab's settings inline (IndicatorPlugin.settings). What it writes has to land exactly where the plugin's own
// panel writes: the same per-pane config, persisted, and only that pane redrawn.

const { createMtfPlugin } = await import('../mtf/plugin')
const { AREV21_MTF, AREV21_OUTLIER_RANK_85_MTF } = await import('../mtf/overlays')
const { MTF_DEFAULTS } = await import('../mtf/config')
const { createArev21DivergencePlugin } = await import('../arev21div/plugin')
const { PRICE_TEMPLATE, SUB_TEMPLATE } = await import('../arev21div/templates')
const { DIV_DEFAULTS } = await import('../arev21div/config')
const { createArevLabPlugin } = await import('../arevlab/plugin')
const { LAB_DEFAULTS, LAB_FIELDS } = await import('../arevlab/config')
const { LAB_TEMPLATE_NAME } = await import('../arevlab/templates')
const { lineApplies, settingLines } = await import('../../src/state/indicatorMatrix')
import type { LabConfig } from '../arevlab/config'
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

describe('the AREV lab', () => {
  test('a write lands in that pane, made legal by the lab\'s own normaliser', async () => {
    const { calls, facilities } = recorder()
    const plugin = createArevLabPlugin()
    // Offline: the registry read fails and the lab registers nothing, but the settings are the
    // plugin's own and do not depend on what the server serves.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch
    try {
      await plugin.register(facilities)
    } finally {
      globalThis.fetch = realFetch
    }
    const settings = plugin.settings?.(LAB_TEMPLATE_NAME)
    expect(settings?.fields).toBe(LAB_FIELDS)
    settings?.write(0, 'p1', 'generations.arev21.signals', 'rank')
    settings?.write(0, 'p1', 'generations.arev21.rank.q', 7)
    const config = settings?.read(0) as LabConfig
    expect(config.generations.arev21.signals).toBe('rank')
    expect(config.generations.arev21.rank.q).toBe(1)
    expect(settings?.read(1)).toEqual(LAB_DEFAULTS)
    expect(calls.reconcile).toEqual(['p1', 'p1'])
    expect(plugin.settings?.('MA')).toBeNull()
  })

  test("the manager offers each pane only its own rule's levers, and only for a generation it shows", () => {
    const lines = settingLines(LAB_FIELDS)
    const field = (key: string) => {
      const line = lines.find((l) => l.kind === 'field' && l.field.key === key)
      if (!line) throw new Error(`no line for ${key}`)
      return line
    }
    const onRank = structuredClone(LAB_DEFAULTS)
    onRank.generations.arev21.signals = 'rank'
    expect(lineApplies(field('generations.arev21.rank.bars'), onRank)).toBe(true)
    expect(lineApplies(field('generations.arev21.rank.bars'), LAB_DEFAULTS)).toBe(false)
    expect(lineApplies(field('generations.arev21.fixed.confidence'), LAB_DEFAULTS)).toBe(true)
    // arev19 is off by default: its Show is offered, its settings are not.
    expect(lineApplies(field('generations.arev19.enabled'), LAB_DEFAULTS)).toBe(true)
    expect(lineApplies(field('generations.arev19.color'), LAB_DEFAULTS)).toBe(false)
  })
})
