import { afterEach, describe, expect, test } from 'bun:test'
import { fakeChart, fakeFacilities, fakeIndicator, fakePane, installWindow } from './testing'
import type { IndicatorPlugin } from './types'

installWindow()

// The indicator manager edits the AREV21 MTF overlay's, the AREV21 divergence's and the AREV
// lab's settings inline (IndicatorPlugin.paneConfigs, through the host). What it writes has to
// land exactly where the plugin's own panel writes: the same per-pane config, persisted, and
// only that pane redrawn.

const { createPluginHost } = await import('./host')
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

const ROW = {
  name: 'arev21',
  template: 'AREV:arev21',
  title: 'AREV21',
  enabled: true,
  feature: 'arev',
  source: { kind: 'table', fold_by: null },
  wire: { plugin: 'arev', variant: 'arev21' }
} as unknown as RegistryIndicator

const hosts: Array<{ teardown(): void }> = []
afterEach(() => {
  for (const host of hosts.splice(0)) host.teardown()
})

/** The plugin on a host over a two-pane wall carrying `template` on its second pane, with the
 * persists and rebinds it causes counted. */
async function onHost(plugin: IndicatorPlugin, template: string) {
  const calls = { persist: 0, binds: 0 }
  const host = await createPluginHost({
    plugins: [
      {
        ...plugin,
        bind: (ctx) => {
          calls.binds++
          return plugin.bind(ctx)
        }
      }
    ],
    facilities: fakeFacilities(),
    requestPersist: () => {
      calls.persist++
    }
  })
  hosts.push(host)
  const charts = [fakeChart(), fakeChart()]
  charts[1].indicators = [fakeIndicator(template, 'i1')]
  host.sync(charts.map((c, i) => fakePane(`p${i + 1}`, c.chart)))
  calls.binds = 0
  return { host, calls }
}

describe('the MTF overlay', () => {
  test('offers its panel fields for its own template only, the graph group only where it draws one', async () => {
    const plain = await onHost(createMtfPlugin(AREV21_MTF), AREV21_MTF.templateName)
    expect(plain.host.settingsModel(AREV21_MTF.templateName)?.fields.map((f) => f.label).slice(0, 2)).toEqual(['3m', '5m'])
    expect(plain.host.settingsModel('MA')).toBeNull()
    const graphed = await onHost(createMtfPlugin(AREV21_OUTLIER_RANK_85_MTF), AREV21_OUTLIER_RANK_85_MTF.templateName)
    expect(graphed.host.settingsModel(AREV21_OUTLIER_RANK_85_MTF.templateName)?.fields.map((f) => f.label).slice(0, 2)).toEqual(['Graph', '3m'])
    expect(graphed.host.settingsModel(AREV21_MTF.templateName)).toBeNull()
  })

  test('a write changes that pane alone, persists, and redraws that pane', async () => {
    const { host, calls } = await onHost(createMtfPlugin(AREV21_OUTLIER_RANK_85_MTF), AREV21_OUTLIER_RANK_85_MTF.templateName)
    const settings = host.settingsModel(AREV21_OUTLIER_RANK_85_MTF.templateName)
    settings?.write('p2', 'timeframes.4h.color', '#123456')
    settings?.write('p2', 'graph.roots.8h', true)
    const written = settings?.read('p2') as typeof MTF_DEFAULTS
    expect(written.timeframes['4h'].color).toBe('#123456')
    expect(written.graph.roots['8h']).toBe(true)
    expect(settings?.read('p1')).toEqual(MTF_DEFAULTS)
    expect(MTF_DEFAULTS.timeframes['4h'].color).not.toBe('#123456')
    expect(calls.persist).toBe(2)
    expect(calls.binds).toBe(2)
    // And it is what the wall document stores for that pane, under `mx` by plugin id.
    expect(host.paneDocs()[1]).toEqual({ mx: { [AREV21_OUTLIER_RANK_85_MTF.id]: { '4h': { color: '#123456' }, graph: { roots: { '8h': true } } } } })
  })
})

describe('the AREV21 divergence', () => {
  test('both templates edit one config per pane, clamped by its own normaliser', async () => {
    const { host, calls } = await onHost(createArev21DivergencePlugin(async () => [ROW]), SUB_TEMPLATE)
    const sub = host.settingsModel(SUB_TEMPLATE)
    const price = host.settingsModel(PRICE_TEMPLATE)
    expect(sub?.fields.map((f) => f.label)).toEqual(['Swings', 'Lines'])
    sub?.write('p1', 'rule.left', 5000)
    price?.write('p1', 'line.style', 'dashed')
    const config = price?.read('p1') as typeof DIV_DEFAULTS
    expect(config.rule.left).toBe(100)
    expect(config.line.style).toBe('dashed')
    expect(sub?.read('p1')).toEqual(config)
    expect(sub?.read('p2')).toEqual(DIV_DEFAULTS)
    expect(calls.persist).toBe(2)
    expect(host.settingsModel('AREV:arev21')).toBeNull()
  })
})

describe('the AREV lab', () => {
  test("a write lands in that pane, made legal by the lab's own normaliser", async () => {
    // Offline: the registry read fails and the lab registers nothing, but the settings are the
    // plugin's own and do not depend on what the server serves.
    const realFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch
    let host: Awaited<ReturnType<typeof onHost>>['host']
    try {
      ;({ host } = await onHost(createArevLabPlugin(), LAB_TEMPLATE_NAME))
    } finally {
      globalThis.fetch = realFetch
    }
    const settings = host.settingsModel(LAB_TEMPLATE_NAME)
    expect(settings?.fields).toBe(LAB_FIELDS)
    settings?.write('p1', 'generations.arev21.signals', 'rank')
    settings?.write('p1', 'generations.arev21.rank.q', 7)
    const config = settings?.read('p1') as LabConfig
    expect(config.generations.arev21.signals).toBe('rank')
    expect(config.generations.arev21.rank.q).toBe(1)
    expect(settings?.read('p2')).toEqual(LAB_DEFAULTS)
    expect(host.settingsModel('MA')).toBeNull()
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
