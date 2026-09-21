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
const { DEFAULT_PARAMS } = await import('./divergence')

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
  return { ...chart(lows, ps), params: [left, right, 5, 60, 0, 0] }
}

describe('what the two panes compute', () => {
  test('the prediction pane draws p and joins p at the two swings, on the confirming bar', () => {
    const { bars, points, params } = bullish()
    const values = computeValues(bars, points, params, 'sub')
    expect(values[14].__div).toEqual([{ side: 'low', label: 'bull', from: { index: 5, value: 0.4 }, to: { index: 12, value: 0.45 } }])
    expect(values.filter((v) => v.__div).length).toBe(1)
    expect(values[3]).toEqual({ p: 0.5, mid: 0.5 })
  })

  test('the price pane joins the two swing lows, and holds no figure value at all', () => {
    const { bars, points, params } = bullish()
    const values = computeValues(bars, points, params, 'price')
    expect(values[14].__div?.[0].from).toEqual({ index: 5, value: 1 })
    expect(values[14].__div?.[0].to).toEqual({ index: 12, value: 0.9 })
    // Nothing but the marks: a value on a figure key would enter the candles' y-axis.
    expect(values.every((v) => Object.keys(v).every((k) => k === '__div'))).toBe(true)
  })

  test('a swing whose vote had too few neighbours is not compared', () => {
    const { bars, points, params } = bullish()
    const thin = new Map(points)
    thin.set(T0 + 5 * STEP, { ...(points.get(T0 + 5 * STEP) as ArevPoint), n: 30 })
    expect(computeValues(bars, thin, params, 'sub').some((v) => v.__div)).toBe(false)
  })

  test('with no store yet, p is absent and nothing is marked, rather than a throw', () => {
    const { bars, params } = bullish()
    const values = computeValues(bars, undefined, params, 'sub')
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
        set: () => true
      }
    ) as CanvasRenderingContext2D
    return { calls, ctx }
  }

  const draw = (kind: 'sub' | 'price', visibleTo?: number) => {
    const { bars, points, params } = bullish()
    const { calls, ctx } = recorder()
    const result = computeValues(bars, points, params, kind)
    // The template's own draw, as klinecharts would call it.
    const cover = buildTemplate(kind).draw?.({
      ctx,
      chart: {
        getDataList: () => bars,
        getVisibleRange: () => ({ realFrom: 0, realTo: visibleTo ?? bars.length - 1 }),
        getBarSpace: () => ({ bar: 10 })
      },
      indicator: { result, calcParams: params },
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

  const ctx = { vendor: 'oanda', ticker: 'EURUSD', interval: '1h', paneIndex: 0, indicator: { name: SUB_TEMPLATE, calcParams: DEFAULT_PARAMS }, siblings: [] } as unknown as BindContext

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

  test('offers nothing where the server serves no arev21', async () => {
    const without = createArev21DivergencePlugin(async () => [row('arev19'), row('arev21', { enabled: false })] as never)
    expect(await without.register(facilities())).toEqual([])
    expect(without.bind(ctx)).toBeNull()
  })
})
