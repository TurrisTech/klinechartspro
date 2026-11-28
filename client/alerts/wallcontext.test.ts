import { describe, expect, test } from 'bun:test'
import type { Chart, Indicator } from 'klinecharts'
import type { ChartProPane, KLineChartPro, Period } from '../../src'
import { installWindow } from '../plugins/testing'

installWindow()
const { wallEditorContext } = await import('./wallcontext')
const { defaultGraphSettings, graphOverlays } = await import('./graphentry')

// The alert editor's context as a wall gives it: the active pane's instrument and timeframe, the
// wall's instruments, and an overlay's graph settings copied from the pane that carries it.

const HOUR: Period = { multiplier: 1, timespan: 'hour', text: '1h' }
const FOUR_HOURS: Period = { multiplier: 4, timespan: 'hour', text: '4h' }

function pane(id: string, ticker: string, period: Period, templates: string[] = []): ChartProPane {
  const indicators = templates.map((name) => ({ name }) as Indicator)
  const chart = {
    getIndicators: (filter?: { name?: string }) => indicators.filter((indicator) => !filter?.name || indicator.name === filter.name)
  } as unknown as Chart
  const symbol = { ticker, exchange: 'oanda', pricePrecision: 5 }
  return { id, getChart: () => chart, getSymbol: () => symbol, getPeriod: () => period } as unknown as ChartProPane
}

function wall(panes: ChartProPane[], active: string): KLineChartPro {
  return {
    getPanes: () => panes,
    getPane: (id: string) => panes.find((p) => p.id === id) ?? null,
    getActivePaneId: () => active
  } as unknown as KLineChartPro
}

const overlay = graphOverlays()[0]

describe('the alert editor on a wall', () => {
  test("a new alert starts on the active pane's instrument and timeframe; the wall's instruments are offered once each", () => {
    const panes = [pane('p1', 'EURUSD', HOUR), pane('p2', 'GBPUSD', FOUR_HOURS), pane('p3', 'EURUSD', FOUR_HOURS)]
    const context = wallEditorContext(wall(panes, 'p2'), () => null)
    expect(context.symbol).toBe('oanda:GBPUSD')
    expect(context.interval).toBe('4h')
    expect(context.symbols).toEqual(['oanda:EURUSD', 'oanda:GBPUSD'])
  })

  test('with no chart there is no instrument, and the timeframe is 1h', () => {
    const context = wallEditorContext(null, () => null)
    expect(context).toMatchObject({ symbol: '', interval: '1h', symbols: [] })
  })

  test('graph settings come from the active pane when it carries the overlay, else the first that does', () => {
    const read: string[] = []
    const reader = (template: string, paneId: string) => {
      read.push(`${template}@${paneId}`)
      return null
    }
    const panes = [pane('p1', 'EURUSD', HOUR), pane('p2', 'EURUSD', HOUR, [overlay.templateName]), pane('p3', 'EURUSD', HOUR, [overlay.templateName])]
    expect(wallEditorContext(wall(panes, 'p3'), reader).graphSettings?.(overlay.id).from).toBe('pane 3')
    expect(wallEditorContext(wall(panes, 'p1'), reader).graphSettings?.(overlay.id).from).toBe('pane 2')
    expect(read).toEqual([`${overlay.templateName}@p3`, `${overlay.templateName}@p2`])
  })

  test('no pane carrying it, or an id that names no graph overlay, gives the defaults and reads nothing', () => {
    const read: string[] = []
    const reader = (template: string) => {
      read.push(template)
      return null
    }
    const context = wallEditorContext(wall([pane('p1', 'EURUSD', HOUR)], 'p1'), reader)
    expect(context.graphSettings?.(overlay.id)).toEqual(defaultGraphSettings())
    expect(context.graphSettings?.('no-such-overlay')).toEqual(defaultGraphSettings())
    expect(read).toEqual([])
  })
})
