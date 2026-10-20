import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

// The overlay's graph SETTINGS: how a stored config carries the roots, the step, the filter and
// the star's look, and how a graph line is drawn. The graph itself is built by the server since
// wdashboard-server 0.56.0 (services/mtfgraph.py; its rules are tested there, case for case as
// they were here).
installWindow()
const { MTF_DEFAULTS, fromStoredMtfConfig, graphLineStyle, graphRoots, toStoredMtfConfig } = await import('./config')
const { MTF_INTERVALS } = await import('./api')
const { resolutionDurationMs } = await import('../periods')

describe('how a graph line is drawn', () => {
  test('solid and full width into 3m and 5m, thinner and more broken the higher it reaches', () => {
    const at = (interval: string) => graphLineStyle(interval, 1.5)
    // The set width is what the lowest timeframes draw at, solid.
    expect(at('3m')).toEqual({ width: 1.5, dash: [] })
    expect(at('5m')).toEqual({ width: 1.5, dash: [] })
    // Everything above is dashed, and the gap grows while the width shrinks.
    const ladder = ['15m', '30m', '1h', '4h', '1D']
    const widths = ladder.map((interval) => at(interval).width)
    const gaps = ladder.map((interval) => at(interval).dash[1])
    expect(widths).toEqual([...widths].sort((a, b) => b - a))
    expect(gaps).toEqual([...gaps].sort((a, b) => a - b))
    expect(widths[0]).toBeLessThan(1.5)
    expect(at('1D').dash[0]).toBeLessThan(at('1D').dash[1])
  })

  test('a dash keeps its proportions at any width, and a line never thins away to nothing', () => {
    expect(graphLineStyle('1D', 3).dash).toEqual(graphLineStyle('1D', 1.5).dash.map((d) => d * 2))
    expect(graphLineStyle('1D', 0.5).width).toBeGreaterThanOrEqual(0.6)
    // A timeframe the table does not know draws solid at the set width rather than vanishing.
    expect(graphLineStyle('1W', 1.5)).toEqual({ width: 1.5, dash: [] })
  })
})

describe('the timeframes the overlay offers', () => {
  test('every one is a different length, which is what lets the step rule stand alone', () => {
    // The server's graph picks a cross-timeframe parent with no timeframe test of its own: the
    // step rule refuses a HIGHER timeframe, and a different interval of the SAME length would
    // slip through it as though it were the superseding step. None is offered, and this is
    // what says so.
    const lengths = MTF_INTERVALS.map((interval) => resolutionDurationMs(interval))
    expect(new Set(lengths).size).toBe(MTF_INTERVALS.length)
    expect(lengths.every((ms) => Number.isFinite(ms) && ms > 0)).toBe(true)
  })
})

describe('graph roots', () => {
  test('the roots switched on, longest first', () => {
    const config = structuredClone(MTF_DEFAULTS)
    config.graph.roots['4h'] = true
    config.graph.roots['1D'] = false
    config.graph.roots['8h'] = true
    expect(graphRoots(config)).toEqual(['8h', '4h'])
    expect(graphRoots(MTF_DEFAULTS)).toEqual(['1D'])
  })
})

describe('graph settings in the stored config', () => {
  test('on the defaults nothing is stored; a change round-trips as a diff', () => {
    expect(toStoredMtfConfig(structuredClone(MTF_DEFAULTS))).toBeUndefined()
    const config = structuredClone(MTF_DEFAULTS)
    config.graph.roots['8h'] = true
    config.graph.maxStep = 4
    const stored = toStoredMtfConfig(config)
    expect(stored).toEqual({ graph: { roots: { '8h': true }, maxStep: 4 } })
    const back = fromStoredMtfConfig(JSON.parse(JSON.stringify(stored)))
    expect(back?.graph).toEqual({ ...MTF_DEFAULTS.graph, roots: { ...MTF_DEFAULTS.graph.roots, '8h': true }, maxStep: 4 })
  })

  test('the hide-the-rest switch round-trips, and defaults to off', () => {
    expect(MTF_DEFAULTS.graph.onlyGraph).toBe(false)
    const config = structuredClone(MTF_DEFAULTS)
    config.graph.onlyGraph = true
    expect(toStoredMtfConfig(config)).toEqual({ graph: { onlyGraph: true } })
    expect(fromStoredMtfConfig({ graph: { onlyGraph: true } })?.graph.onlyGraph).toBe(true)
    // A bad value falls back to the default; a document holding nothing else usable reads as
    // no config at all, which is what `undefined` says.
    expect(fromStoredMtfConfig({ graph: { onlyGraph: 'yes' }, '4h': { enabled: false } })?.graph.onlyGraph).toBe(false)
    expect(fromStoredMtfConfig({ graph: { onlyGraph: 'yes' } })).toBeUndefined()
  })

  test('the entry star: timeframe colour and a white outline by default, both settable', () => {
    expect(MTF_DEFAULTS.graph.starTimeframeColour).toBe(true)
    expect(MTF_DEFAULTS.graph.starOutline).toBe('#FFFFFF')
    const config = structuredClone(MTF_DEFAULTS)
    config.graph.starTimeframeColour = false
    config.graph.starColor = '#ff0000'
    config.graph.starOutline = '#000000'
    const stored = toStoredMtfConfig(config)
    expect(stored).toEqual({ graph: { starTimeframeColour: false, starColor: '#ff0000', starOutline: '#000000' } })
    expect(fromStoredMtfConfig(JSON.parse(JSON.stringify(stored)))?.graph).toEqual(config.graph)
  })

  test('the colour input writes lower case, and white in lower case is still the default', () => {
    const config = structuredClone(MTF_DEFAULTS)
    config.graph.starOutline = '#ffffff'
    expect(toStoredMtfConfig(config)).toBeUndefined()
  })

  test('a colour that is not #rrggbb falls back to the default rather than reaching the canvas', () => {
    const back = fromStoredMtfConfig({
      graph: { starColor: 'gold', starOutline: '#fff', starTimeframeColour: 'no' },
      '1h': { enabled: false }
    })
    expect(back?.graph.starColor).toBe(MTF_DEFAULTS.graph.starColor)
    expect(back?.graph.starOutline).toBe(MTF_DEFAULTS.graph.starOutline)
    expect(back?.graph.starTimeframeColour).toBe(true)
  })

  test('a config from before the star settings stores and reads as the defaults', () => {
    const config = structuredClone(MTF_DEFAULTS) as { graph: Partial<typeof MTF_DEFAULTS.graph> }
    delete config.graph.starTimeframeColour
    delete config.graph.starColor
    delete config.graph.starOutline
    expect(toStoredMtfConfig(config as typeof MTF_DEFAULTS)).toBeUndefined()
  })

  test('the single root client-a2c8f6c saved reads as that one root on, and nothing else', () => {
    expect(graphRoots(fromStoredMtfConfig({ graph: { from: '8h' } }))).toEqual(['8h'])
    expect(graphRoots(fromStoredMtfConfig({ graph: { from: 'off' } }))).toEqual([])
    // A document that states roots is read by them, whatever else it says.
    expect(graphRoots(fromStoredMtfConfig({ graph: { from: '8h', roots: { '4h': true } } }))).toEqual(['1D', '4h'])
  })

  test('a bad value falls back to its default, and a document from before the graph reads unchanged', () => {
    const back = fromStoredMtfConfig({
      graph: { from: '3m', roots: { '1D': 'yes', '2h': true, '3m': true }, maxStep: 1, lineWidth: 2 },
      '4h': { color: '#000000' }
    })
    expect(back?.graph).toEqual({ ...MTF_DEFAULTS.graph, roots: { ...MTF_DEFAULTS.graph.roots, '2h': true }, lineWidth: 2 })
    expect(back?.timeframes['4h'].color).toBe('#000000')
    expect(fromStoredMtfConfig({ '1h': { enabled: false } })?.graph).toEqual(MTF_DEFAULTS.graph)
  })
})
