import { afterAll, describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { BindContext, PluginFacilities, SourceSpec } from '../plugins/types'
import type { LabConfig } from './config'
import type { GenerationResult } from './compute'
import type { LabPoint } from './rules'

installWindow()

// The registry the plugin reads at register time: every AREV generation but arev20, plus a
// row that is not an AREV generation at all and must be ignored.
const row = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  template: `AREV:${name}`,
  title: name.toUpperCase(),
  enabled: true,
  feature: 'arev',
  source: { kind: 'table', fold_by: null },
  wire: { plugin: 'arev', variant: name },
  ...extra
})
const registry = [
  row('arev19'),
  row('arev20', { enabled: false }),
  row('arev21'),
  row('arev22'),
  row('arev23'),
  row('krev01', { wire: { plugin: 'krev', variant: 'krev01' } })
]
const realFetch = globalThis.fetch
globalThis.fetch = (async () => new Response(JSON.stringify({ indicators: registry }))) as unknown as typeof fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

const { LAB_DEFAULTS, normaliseLabConfig } = await import('./config')
const { figureKeys, labValues } = await import('./compute')
const { barsSourceKey, createArevLabPlugin, leadInMs, widen, windowTruncatedDays } = await import('./plugin')
const { BARS_SOURCE_ID, LAB_TEMPLATE_NAME, labFigures } = await import('./templates')
const { storedSource } = await import('../tsregistry/plugin')
const { loadRegistry } = await import('../tsregistry/api')

const HOUR = 3_600_000
const DAY = 86_400_000

function facilities(): PluginFacilities {
  return {
    api: { get: async () => ({}) as never, url: () => new URL('http://test/') },
    stream: {} as PluginFacilities['stream'],
    hasFeature: () => true,
    points: async () => ({ points: [], nextFrom: null }),
    periodToResolution: (p) => p.text,
    resolutionDurationMs: () => HOUR,
    symbolVendor: () => 'oanda',
    openSettingsPanel: () => ({ close() {} }) as never,
    paneInfo: () => null,
    requestReconcile: () => {},
    requestPersist: () => {},
    maxValuesPerRequest: 5000,
    signals: { catalogue: async () => [], points: async () => ({ points: [], nextFrom: null }) }
  }
}

const ctx = (paneIndex = 0): BindContext =>
  ({
    paneIndex,
    vendor: 'oanda',
    ticker: 'EURUSD',
    interval: '1h',
    indicator: { name: LAB_TEMPLATE_NAME, calcParams: [] },
    siblings: []
  }) as unknown as BindContext

const configWith = (mutate: (c: LabConfig) => void): LabConfig => {
  const c = structuredClone(LAB_DEFAULTS)
  mutate(c)
  return c
}

async function mounted(configs: Record<number, LabConfig> = {}) {
  const plugin = createArevLabPlugin()
  plugin.paneState?.hydrate(configs)
  const f = facilities()
  const groups = await plugin.register(f)
  return { plugin, f, groups }
}

describe('register', () => {
  test('offers the lab when the registry serves any AREV generation', async () => {
    const { groups, plugin } = await mounted()
    expect(groups.flatMap((g) => g.items.map((i) => i.name))).toEqual([LAB_TEMPLATE_NAME])
    expect(plugin.matches(LAB_TEMPLATE_NAME)).toBe(true)
    expect(plugin.matches('AREV:arev21')).toBe(false)
  })
})

describe('bind', () => {
  test("reads each generation through the registry's own source, so it shares the AREV pane's store", async () => {
    const config = configWith((c) => {
      c.generations.arev19.enabled = true
    })
    const { plugin, f } = await mounted({ 0: config })
    const spec = plugin.bind(ctx())
    const entries = await loadRegistry()
    expect(spec?.sources.map((s) => s.id)).toEqual(['arev19', 'arev21'])
    for (const source of spec?.sources ?? []) {
      const entry = entries.find((e) => e.name === source.id)
      const registry = storedSource(f, entry as never, ctx())
      expect(source.key).toBe(registry.key)
      expect(source.createStore).toBe(registry.createStore)
      expect(source.resolution).toBe(registry.resolution)
    }
  })

  test('a generation the server does not serve is never fetched', async () => {
    const config = configWith((c) => {
      c.generations.arev20.enabled = true
    })
    const { plugin } = await mounted({ 0: config })
    expect(plugin.bind(ctx())?.sources.map((s) => s.id)).toEqual(['arev21'])
  })

  test('the fixed rule reads the chart range; an adaptive one reaches back exactly its window', async () => {
    const range = { from: 10_000 * HOUR, to: 20_000 * HOUR }
    const fixed = (await mounted()).plugin.bind(ctx())?.sources[0] as SourceSpec
    expect(fixed.window).toBeUndefined()
    const rank = configWith((c) => {
      c.generations.arev21.signals = 'rank'
      c.generations.arev21.rank.bars = 200
    })
    const widened = (await mounted({ 0: rank })).plugin.bind(ctx())?.sources[0] as SourceSpec
    const lead = leadInMs('arev21', rank.generations.arev21, HOUR)
    // rank counts bars: its window, and one bar so the first drawn bar has a predecessor.
    expect(lead).toBe(201 * HOUR)
    expect(widened.window?.(range)).toEqual({ from: range.from - lead, to: range.to })
  })

  test('a bar source exists only while some generation uses the prior', async () => {
    const withoutPrior = (await mounted()).plugin.bind(ctx())
    expect(withoutPrior?.sources.some((s) => s.id === BARS_SOURCE_ID)).toBe(false)
    const prior = configWith((c) => {
      c.generations.arev19.enabled = true
      c.generations.arev19.signals = 'prior'
    })
    const spec = (await mounted({ 0: prior })).plugin.bind(ctx())
    const bars = spec?.sources.find((s) => s.id === BARS_SOURCE_ID)
    expect(bars?.key).toBe(barsSourceKey('oanda', 'EURUSD', '1h'))
    expect(bars?.resolution).toBe('1h')
  })

  test('sets the figures its config draws', async () => {
    const config = configWith((c) => {
      c.generations.arev23.enabled = true
      c.generations.arev23.lines = true
      c.generations.arev23.signals = 'median'
    })
    const spec = (await mounted({ 0: config })).plugin.bind(ctx())
    const figures = (spec?.overrides?.figures ?? []) as Array<{ key: string; title?: string }>
    expect(figures.map((fig) => fig.key)).toEqual(['arev21_p', 'arev23_p', 'arev23_hi', 'arev23_lo', 'arev23_c'])
    // Only the p lines are titled, so the legend lists generations and not thresholds.
    expect(figures.filter((fig) => fig.title).map((fig) => fig.key)).toEqual(['arev21_p', 'arev23_p'])
  })

  test('settings are per pane', async () => {
    const config = configWith((c) => {
      c.generations.arev22.enabled = true
    })
    const { plugin } = await mounted({ 1: config })
    expect(plugin.bind(ctx(0))?.sources.map((s) => s.id)).toEqual(['arev21'])
    expect(plugin.bind(ctx(1))?.sources.map((s) => s.id)).toEqual(['arev21', 'arev22'])
    expect(plugin.paneState?.snapshot()).toEqual({ 1: config })
  })

  test('a hydrated config is normalised before any binding reads it', async () => {
    const bad = configWith((c) => {
      c.generations.arev21.rank.bars = -3
    })
    const { plugin } = await mounted({ 0: bad })
    const snapshot = plugin.paneState?.snapshot() as Record<number, LabConfig>
    expect(snapshot[0].generations.arev21.rank.bars).toBe(20)
    expect(snapshot[0]).toEqual(normaliseLabConfig(bad))
  })
})

describe('leadInMs, the cap and widen', () => {
  test('no history for rules that look back at nothing', () => {
    expect(leadInMs('arev19', { ...LAB_DEFAULTS.generations.arev19, signals: 'fixed' }, HOUR)).toBe(0)
    expect(leadInMs('arev19', { ...LAB_DEFAULTS.generations.arev19, signals: 'none' }, HOUR)).toBe(0)
  })

  test("arev22's prior also waits for the bar its label is stamped at", () => {
    const g = { ...LAB_DEFAULTS.generations.arev22, signals: 'prior' as const, prior: { days: 30, width: 0.02 } }
    expect(leadInMs('arev22', g, HOUR)).toBe(30 * DAY + 10 * HOUR + HOUR)
    expect(leadInMs('arev21', g, HOUR)).toBe(30 * DAY + HOUR)
  })

  test('a SPAN longer than a pane can hold is capped, and says so', () => {
    const g = { ...LAB_DEFAULTS.generations.arev19, signals: 'median' as const, median: { days: 3650, width: 0.075 } }
    const minute = 60_000
    expect(leadInMs('arev19', g, minute)).toBe(40_000 * minute)
    // 40,000 minutes is ~27 days of the 3,650 asked for, and the legend carries that number.
    expect(windowTruncatedDays(g, minute)).toBe(27)
    // On a daily chart the same window fits, so nothing is said.
    expect(windowTruncatedDays(g, DAY)).toBeNull()
    // A count of bars is bounded by its own lever and is never cut.
    const counted = { ...LAB_DEFAULTS.generations.arev19, signals: 'rank' as const, rank: { bars: 5000, q: 0.9 } }
    expect(windowTruncatedDays(counted, minute)).toBeNull()
    expect(leadInMs('arev19', counted, minute)).toBe(5001 * minute)
    expect(windowTruncatedDays({ ...LAB_DEFAULTS.generations.arev19, signals: 'none' }, minute)).toBeNull()
  })

  test('never below zero', () => {
    expect(widen({ from: 10, to: 20 }, 100 * DAY)).toEqual({ from: 0, to: 20 })
  })
})

describe('labValues', () => {
  const points: LabPoint[] = [
    { date: 1, p: 0.6, n: 100, atCross: true },
    { date: 2, p: Number.NaN, n: 100, atCross: true },
    { date: 4, p: 0.4, n: 100, atCross: true }
  ]
  const result: GenerationResult = {
    points,
    lines: { centre: Float64Array.from([0.5, 0.5, 0.5]), hi: Float64Array.from([Number.NaN, 0.55, 0.55]), lo: Float64Array.from([0.45, 0.45, 0.45]) },
    sides: Int8Array.from([1, 0, -1])
  }

  test('maps each point onto its bar, blank where it has none, lines only when asked for', () => {
    const keys = figureKeys('arev21')
    const plain = labValues([1, 2, 3, 4], LAB_DEFAULTS, { arev21: result })
    expect(plain[0][keys.p]).toBe(0.6)
    expect(plain[0][keys.hi]).toBeUndefined()
    expect(plain[1][keys.p]).toBeUndefined() // NaN is not drawn
    expect(plain[2]).toEqual({})
    expect(plain[0].__marks).toEqual([{ generation: 'arev21', side: 1, p: 0.6 }])
    expect(plain[3].__marks).toEqual([{ generation: 'arev21', side: -1, p: 0.4 }])

    const lined = configWith((c) => {
      c.generations.arev21.lines = true
    })
    const withLines = labValues([1, 2, 3, 4], lined, { arev21: result })
    expect(withLines[0][keys.hi]).toBeUndefined() // a NaN line is a gap, not a zero
    expect(withLines[0][keys.lo]).toBe(0.45)
    expect(withLines[1][keys.hi]).toBe(0.55)
  })

  test('a switched-off generation draws nothing even if a result is held for it', () => {
    const off = configWith((c) => {
      c.generations.arev21.enabled = false
    })
    expect(labValues([1, 4], off, { arev21: result })).toEqual([{}, {}])
  })
})

describe('labFigures', () => {
  test('rule lines are not drawn for the rule that has none', () => {
    const config = configWith((c) => {
      c.generations.arev21.lines = true
      c.generations.arev21.signals = 'none'
    })
    expect(labFigures(config).map((f) => f.key)).toEqual(['arev21_p'])
  })
})
