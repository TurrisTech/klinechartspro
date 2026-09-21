import { afterAll, describe, expect, test } from 'bun:test'
import type { KLineData } from 'klinecharts'
import { installWindow } from '../plugins/testing'
import type { ArevPoint } from '../arev/api'
import type { BindContext, PluginFacilities } from '../plugins/types'

installWindow()

// The registry the plugin reads at register time.
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
const registry: unknown[] = [row('arev19'), row('arev21')]
const realFetch = globalThis.fetch
globalThis.fetch = (async () => new Response(JSON.stringify({ indicators: registry }))) as unknown as typeof fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

const { PRICE_TEMPLATE, SUB_TEMPLATE, buildTemplate, computeValues, isDivergenceIndicator } = await import('./templates')
const { createArev21DivergencePlugin } = await import('./plugin')
const { storedSource } = await import('../tsregistry/plugin')
const { DIV_DEFAULTS, normaliseDivConfig } = await import('./config')
import type { DivConfig } from './config'

// Bars and arev21 points on one clock, as the chart and the store hold them.
const T0 = 1_700_000_000_000
const STEP = 3_600_000

function chart(lows: number[], ps: Array<number | null>, n = 200) {
  const bars: KLineData[] = lows.map((low, i) => ({ timestamp: T0 + i * STEP, open: low + 1, high: low + 2, low, close: low + 1, volume: 0 }))
  const points = new Map<number, ArevPoint>()
  ps.forEach((p, i) => {
    if (p != null) points.set(T0 + i * STEP, { date: T0 + i * STEP, p, n, prediction: 0, atCross: true } as unknown as ArevPoint)
  })
  return { bars, points }
}

/** A lower low at bar 12 than at bar 5, with p higher there: one bullish divergence confirmed at
 * 12 + right. The rest of the lows sit well above both, so nothing else is a swing low; every
 * high is `low + 2`, so the swing highs are wherever the lows are flat -- none, being equal. */
function bullish(left = 3, right = 2) {
  const lows = new Array<number>(30).fill(2)
  lows[5] = 1
  lows[12] = 0.9
  const ps = new Array<number | null>(30).fill(0.5)
  ps[5] = 0.4
  ps[12] = 0.45
  const config: DivConfig = normaliseDivConfig({ ...DIV_DEFAULTS, rule: { left, right, minGap: 5, maxGap: 60, minDp: 0, hidden: false } })
  return { ...chart(lows, ps), config }
}

describe('what the two panes compute', () => {
  test('the prediction pane draws p and joins p at the two swings, on the confirming bar', () => {
    const { bars, points, config } = bullish()
    const values = computeValues(bars, points, config.rule, 'sub')
    expect(values[14].__div).toEqual([{ side: 'low', label: 'bull', from: { index: 5, value: 0.4 }, to: { index: 12, value: 0.45 } }])
    expect(values.filter((v) => v.__div).length).toBe(1)
    expect(values[3]).toEqual({ p: 0.5, mid: 0.5 })
  })

  test('the price pane joins the two swing lows, and holds no figure value at all', () => {
    const { bars, points, config } = bullish()
    const values = computeValues(bars, points, config.rule, 'price')
    expect(values[14].__div?.[0].from).toEqual({ index: 5, value: 1 })
    expect(values[14].__div?.[0].to).toEqual({ index: 12, value: 0.9 })
    // Nothing but the marks: a value on a figure key would enter the candles' y-axis.
    expect(values.every((v) => Object.keys(v).every((k) => k === '__div'))).toBe(true)
  })

  test('a swing whose vote had too few neighbours is not compared', () => {
    const { bars, points, config } = bullish()
    const thin = new Map(points)
    thin.set(T0 + 5 * STEP, { ...(points.get(T0 + 5 * STEP) as ArevPoint), n: 30 })
    expect(computeValues(bars, thin, config.rule, 'sub').some((v) => v.__div)).toBe(false)
  })

  test('with no store yet, p is absent and nothing is marked, rather than a throw', () => {
    const { bars, config } = bullish()
    const values = computeValues(bars, undefined, config.rule, 'sub')
    expect(values.every((v) => v.p === undefined && !v.__div)).toBe(true)
  })
})

describe('drawing', () => {
  const recorder = () => {
    const calls: Array<[string, ...unknown[]]> = []
    const ctx = new Proxy(
      {},
      {
        get: (_t, prop) => (typeof prop === 'string' ? (...args: unknown[]) => calls.push([prop, ...args]) : undefined),
        // Property writes too (`lineWidth = 3`), recorded as `=lineWidth`, so a test can read
        // the stroke a line was drawn with.
        set: (_t, prop, value) => {
          calls.push([`=${String(prop)}`, value])
          return true
        }
      }
    ) as CanvasRenderingContext2D
    return { calls, ctx }
  }

  const draw = (kind: 'sub' | 'price', visibleTo?: number, fixture = bullish()) => {
    const { bars, points, config } = fixture
    const { calls, ctx } = recorder()
    const result = computeValues(bars, points, config.rule, kind)
    // The template's own draw, as klinecharts would call it.
    const cover = buildTemplate(kind).draw?.({
      ctx,
      chart: {
        getDataList: () => bars,
        getVisibleRange: () => ({ realFrom: 0, realTo: visibleTo ?? bars.length - 1 }),
        getBarSpace: () => ({ bar: 10 })
      },
      indicator: { result, calcParams: [], extendData: { seriesKey: '', rev: 0, config } },
      xAxis: { convertToPixel: (i: number) => i * 10 },
      yAxis: { convertToPixel: (v: number) => 100 - v * 100 }
    } as never)
    return { calls, cover }
  }

  test('the line joins the two swings before the arrow is drawn on the confirming bar', () => {
    const { calls, cover } = draw('sub')
    const moves = calls.filter(([name]) => name === 'moveTo' || name === 'lineTo')
    expect(moves[0]).toEqual(['moveTo', 50, 100 - 40])
    expect(moves[1]).toEqual(['lineTo', 120, 100 - 45])
    expect(moves[2]).toEqual(['moveTo', 140, 50]) // the arrow's tip, at p on bar 14
    // FALSE: klinecharts draws the declared figures (the p line) only when draw returns false.
    expect(cover).toBe(false)
  })

  test('the price pane puts the arrow under the confirming candle and draws no figures', () => {
    const { calls, cover } = draw('price')
    const moves = calls.filter(([name]) => name === 'moveTo' || name === 'lineTo')
    expect(moves[0]).toEqual(['moveTo', 50, 100 - 100])
    expect(moves[2]).toEqual(['moveTo', 140, 100 - 200 + 4]) // under bar 14's low of 2
    expect(cover).toBe(true)
  })

  /** The stroke state in force at the divergence line's `stroke()`: the last write of each. */
  const strokeOf = (calls: Array<[string, ...unknown[]]>) => {
    const at = calls.findIndex(([name]) => name === 'stroke')
    const last = (name: string) => calls.slice(0, at).findLast(([n]) => n === name)?.slice(1)
    return { width: last('=lineWidth'), cap: last('=lineCap'), dash: last('setLineDash'), alpha: last('=globalAlpha'), color: last('=strokeStyle') }
  }
  const withLine = (line: Partial<DivConfig['line']>, fixture = bullish()) => ({
    ...fixture,
    config: normaliseDivConfig({ ...fixture.config, line: { ...fixture.config.line, ...line } })
  })

  test('by default every divergence line is thick and dotted, in both panes', () => {
    const dotted = { width: [3], cap: ['round'], dash: [[0, 7.5]], alpha: [1], color: ['#26A69A'] }
    expect(strokeOf(draw('sub').calls)).toEqual(dotted)
    expect(strokeOf(draw('price').calls)).toEqual(dotted)
  })

  test('the style, width and colours are the pane settings', () => {
    expect(strokeOf(draw('sub', undefined, withLine({ style: 'dashed', width: 2, bullColor: '#00ff00' })).calls)).toEqual({
      width: [2],
      cap: ['butt'],
      dash: [[6, 4]],
      alpha: [1],
      color: ['#00ff00']
    })
    expect(strokeOf(draw('price', undefined, withLine({ style: 'solid', width: 5 })).calls).dash).toEqual([[]])
    // The arrow takes the line's colour too.
    const calls = draw('sub', undefined, withLine({ bullColor: '#abcdef' })).calls
    expect(calls.filter(([name, value]) => name === '=fillStyle' && value === '#abcdef').length).toBeGreaterThan(0)
  })

  test('a hidden divergence is the same line at the hidden opacity', () => {
    // A higher low with a lower p, with hidden divergences switched on.
    const hidden = bullish()
    hidden.bars[12].low = 1.1
    hidden.points.set(T0 + 12 * STEP, { ...(hidden.points.get(T0 + 12 * STEP) as ArevPoint), p: 0.35 })
    hidden.config = normaliseDivConfig({ ...hidden.config, rule: { ...hidden.config.rule, hidden: true } })
    expect(strokeOf(draw('sub', undefined, hidden).calls)).toEqual({ width: [3], cap: ['round'], dash: [[0, 7.5]], alpha: [0.5], color: ['#26A69A'] })
    expect(strokeOf(draw('sub', undefined, withLine({ hiddenOpacity: 0.8 }, hidden)).calls).alpha).toEqual([0.8])
  })

  test('a line-style edit redraws; only a rule edit recomputes', () => {
    const template = buildTemplate('sub')
    const indicator = (config: DivConfig) => ({ extendData: { seriesKey: 'k', rev: 1, config } }) as never
    const base = bullish().config
    expect(template.shouldUpdate?.(indicator(base), indicator(withLine({ width: 7 }).config))).toEqual({ calc: false, draw: true })
    const ruled = normaliseDivConfig({ ...base, rule: { ...base.rule, right: 3 } })
    expect(template.shouldUpdate?.(indicator(base), indicator(ruled))).toEqual({ calc: true, draw: true })
  })

  test('a confirming bar just right of the view still draws the line reaching into it', () => {
    // Visible to bar 12: both swings are on screen, the confirming bar (14) is not.
    const { calls } = draw('sub', 12)
    expect(calls.filter(([name]) => name === 'setLineDash')).toHaveLength(1)
  })
})

describe('the plugin', () => {
  const facilities = (): PluginFacilities =>
    ({
      hasFeature: () => true,
      points: async () => ({ points: [], nextFrom: null }),
      resolutionDurationMs: () => STEP,
      stream: {}
    }) as unknown as PluginFacilities

  const ctx = { vendor: 'oanda', ticker: 'EURUSD', interval: '1h', paneIndex: 0, indicator: { name: SUB_TEMPLATE, calcParams: [] }, siblings: [] } as unknown as BindContext

  test('offers both panes, in groups a picker can tell apart', async () => {
    const plugin = createArev21DivergencePlugin()
    const groups = await plugin.register(facilities())
    expect(groups.map((g) => [g.label, g.main, g.items.map((i) => i.name)])).toEqual([
      ['AREV21 divergence', false, [SUB_TEMPLATE]],
      ['AREV21 divergence · price pane', true, [PRICE_TEMPLATE]]
    ])
    expect(isDivergenceIndicator(SUB_TEMPLATE) && isDivergenceIndicator(PRICE_TEMPLATE)).toBe(true)
    expect(isDivergenceIndicator('AREV:arev21')).toBe(false)
  })

  test("reads exactly the AREV21 pane's store -- same key, same factory -- so beside one it costs nothing", async () => {
    const f = facilities()
    const plugin = createArev21DivergencePlugin()
    await plugin.register(f)
    const spec = plugin.bind(ctx)
    const arev21 = storedSource(f, row('arev21') as never, ctx)
    expect(spec?.sources).toHaveLength(1)
    const source = spec?.sources[0]
    expect(source?.key).toBe(arev21.key)
    expect(source?.key).toBe('arev21|oanda:EURUSD|1h')
    expect(source?.createStore).toBe(arev21.createStore)
    expect(source?.resolution).toBe('1h')
  })

  test('the gear on either template opens one panel, and an edit reaches both through the rebind', async () => {
    const opened: Array<{ title: string; onChange: (next: DivConfig) => void; config: DivConfig }> = []
    const persisted: number[] = []
    const reconciled: string[] = []
    const f = {
      ...facilities(),
      paneInfo: (paneId: string) =>
        paneId === 'p0'
          ? {
              paneIndex: 0,
              chart: { getDom: () => ({ getBoundingClientRect: () => ({ top: 0, left: 0 }) }) },
              pane: { getSymbol: () => ({ ticker: 'EURUSD' }), getPeriod: () => ({ text: '1h' }) }
            }
          : null,
      periodToResolution: (p: { text: string }) => p.text,
      openSettingsPanel: (options: never) => {
        opened.push(options)
        return { close() {} }
      },
      requestPersist: () => persisted.push(1),
      requestReconcile: (paneId?: string) => reconciled.push(paneId ?? '')
    } as unknown as PluginFacilities
    const plugin = createArev21DivergencePlugin()
    await plugin.register(f)
    const request = (indicatorName: string) => ({ indicatorName, paneId: 'p0', chartPaneId: 'x', calcParams: [] })
    expect(plugin.handleSettings?.(request('AREV:arev21'))).toBe(false)
    expect(plugin.handleSettings?.(request(PRICE_TEMPLATE))).toBe(true)
    expect(plugin.handleSettings?.(request(SUB_TEMPLATE))).toBe(true)
    expect(opened[1].title).toBe('AREV21 divergence · EURUSD 1h')
    expect(opened[1].config).toEqual(DIV_DEFAULTS)

    const before = plugin.signature?.(ctx)
    opened[1].onChange({ ...DIV_DEFAULTS, line: { ...DIV_DEFAULTS.line, style: 'solid', width: 99 } })
    expect(plugin.signature?.(ctx)).not.toEqual(before)
    expect(persisted.length).toBe(1)
    expect(reconciled).toEqual(['p0'])
    // Clamped on the way in, and handed to every binding on the pane.
    const extend = plugin.bind(ctx)?.extendData?.({ sources: [], chartInterval: '1h' }) as { config: DivConfig }
    expect(extend.config.line).toEqual({ ...DIV_DEFAULTS.line, style: 'solid', width: 10 })
    const priceCtx = { ...ctx, indicator: { name: PRICE_TEMPLATE, calcParams: [] } } as unknown as BindContext
    const priceExtend = plugin.bind(priceCtx)?.extendData?.({ sources: [], chartInterval: '1h' }) as { config: DivConfig } | undefined
    expect(priceExtend?.config).toEqual(extend.config)
    // And it is what the wall document saves for pane 0.
    expect(plugin.paneState?.snapshot()).toEqual({ 0: extend.config })
  })

  test("a pane's saved settings come back through hydrate, normalised", async () => {
    const plugin = createArev21DivergencePlugin()
    await plugin.register(facilities())
    plugin.paneState?.hydrate({ 0: { ...DIV_DEFAULTS, line: { ...DIV_DEFAULTS.line, bearColor: '#010203', width: -4 } } })
    const extend = plugin.bind(ctx)?.extendData?.({ sources: [], chartInterval: '1h' }) as { config: DivConfig }
    expect(extend.config.line.bearColor).toBe('#010203')
    expect(extend.config.line.width).toBe(1)
  })

  test('offers nothing where the server serves no arev21', async () => {
    const without = createArev21DivergencePlugin(async () => [row('arev19'), row('arev21', { enabled: false })] as never)
    expect(await without.register(facilities())).toEqual([])
    expect(without.bind(ctx)).toBeNull()
  })
})
