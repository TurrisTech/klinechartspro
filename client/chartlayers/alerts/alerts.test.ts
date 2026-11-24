import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Chart, Indicator, OverlayCreate } from 'klinecharts'
import type { SymbolInfo } from '../../../src'

// PRICE ALERTS ON A CHART LAYER: the shape an alert is (zone.ts), when it fires -- through the
// real condition language and the real firing policy, in the registry a replay runs -- and what
// a layer's pane does with it: a click enables, a bell marks, a hover shows the zone, the
// editor sets the buffer and removes it. The pane is driven through the real controller over
// a stand-in layer and chart, in a real DOM (happy-dom) for the editor.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { parse, evaluate, sample } = await import('../../alerts/conditions')
const { LocalWatchRegistry } = await import('../../watch/local')
const { WatchStore } = await import('../../watch/store')
const { priceLevel } = await import('../../watch/types')
const { PriceAlerts, PRICE_ALERT_COOLDOWN_MS } = await import('./hub')
const zones = await import('./zone')
const figures = await import('./figures')
const { overlaySignature } = await import('../paint')
const { createLayerController } = await import('../controller')
const { fakePane, flush } = await import('../../plugins/testing')
import type { Observation } from '../../alerts/conditions'
import type { LocalWatchSource } from '../../watch/local'
import type { SourceField, Watch } from '../../watch/types'
import type { ChartLayer, LayerAlerts } from '../types'

const EURUSD = { ticker: 'EURUSD', exchange: 'oanda', pricePrecision: 5, pipSize: 0.0001 } as unknown as SymbolInfo
const FX = zones.zoneUnit(EURUSD)

const price = (value: number, low?: number, high?: number): Observation => ({ price: sample(value, low, high) })

/** `value`, which the test has just made sure exists. */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error('expected a value')
  return value
}

// ------------------------------------------------------------------------------ the shape

describe('the zone', () => {
  test('is counted in pips where the instrument has them, and in its ticks where it does not', () => {
    expect(FX).toEqual({ size: 0.0001, label: 'pips' })
    expect(zones.zoneUnit({ pricePrecision: 2 } as SymbolInfo)).toEqual({ size: 0.01, label: 'ticks' })
  })

  test('its edges reach the wire rounded, so 3 pips is 0.0003 and not 0.00030000000000000003', () => {
    const zone = zones.zoneAround(1.085, 3, FX, 5)
    expect(zone.low).toBe(1.0847)
    expect(zone.high).toBe(1.0853)
    expect(zones.zonePips(zone, FX)).toBe(3)
  })

  test('is a condition the language accepts as it is, and reads back to the same zone', () => {
    const zone = zones.zoneAround(1.08523, 2.5, FX, 5)
    const condition = zones.zoneCondition(zone)
    expect(parse(condition)).toEqual(condition)
    const back = must(zones.zoneOf(watchOf(condition)))
    expect(back.low).toBe(zone.low)
    expect(back.high).toBe(zone.high)
    expect(zones.centredOn(back, 1.08523, 5)).toBe(true)
    // A level one tick away is a different level.
    expect(zones.centredOn(back, 1.08524, 5)).toBe(false)
    expect(zones.zonePips(back, FX)).toBe(2.5)
  })

  test('is never drawn a second time as a price-watch line', () => {
    expect(priceLevel(watchOf(zones.zoneCondition(zones.zoneAround(1.085, 5, FX, 5))))).toBeNull()
    // ...even with no width, which is `crosses` spelled as the pair.
    expect(priceLevel(watchOf(zones.zoneCondition(zones.zoneAround(1.085, 0, FX, 5))))).toBeNull()
  })

  test('nothing else is taken for one', () => {
    expect(zones.zoneOf(watchOf({ field: 'price', op: 'crosses', value: 1.085 }))).toBeNull()
    expect(zones.zoneOf(watchOf({ any: [{ field: 'price', op: 'crosses_below', value: 1.08 }, { field: 'price', op: 'crosses_above', value: 1.09 }] }))).toBeNull()
    expect(zones.zoneOf({ ...watchOf(zones.zoneCondition({ low: 1.08, high: 1.09 })), source: 'bar' })).toBeNull()
  })

  test('is described by its width and its edges', () => {
    expect(zones.describeZone(zones.zoneAround(1.085, 5, FX, 5), FX, 5)).toBe('±5 pips (10 wide) · 1.08450–1.08550')
    expect(zones.describeZone(zones.zoneAround(1.085, 0, FX, 5), FX, 5)).toBe('at the price')
    expect(zones.alertName('EURUSD', { price: 1.085, label: '1W level' }, 5)).toBe('EURUSD 1W level 1.08500')
  })
})

describe('the condition holds when price ENTERS the zone', () => {
  const zone = zones.zoneCondition(zones.zoneAround(1.085, 5, FX, 5)) // 1.08450 – 1.08550

  test('from below and from above', () => {
    expect(evaluate(zone, price(1.0846), price(1.0840))).toBe(true)
    expect(evaluate(zone, price(1.0854), price(1.0860))).toBe(true)
  })

  test('a wick into it counts, as it does for any crossing', () => {
    expect(evaluate(zone, price(1.0840, 1.0838, 1.0846), price(1.0841))).toBe(true)
  })

  test('a move straight through it counts', () => {
    expect(evaluate(zone, price(1.0860), price(1.0840))).toBe(true)
  })

  test('leaving it, either way, does not -- nor does wandering about inside it', () => {
    expect(evaluate(zone, price(1.0860), price(1.0850))).toBe(false)
    expect(evaluate(zone, price(1.0840), price(1.0850))).toBe(false)
    expect(evaluate(zone, price(1.0846), price(1.0853))).toBe(false)
  })

  test('with no width it is a crossing of the price, either way', () => {
    const atLevel = zones.zoneCondition(zones.zoneAround(1.085, 0, FX, 5))
    expect(evaluate(atLevel, price(1.0851), price(1.0849))).toBe(true)
    expect(evaluate(atLevel, price(1.0849), price(1.0851))).toBe(true)
    expect(evaluate(atLevel, price(1.0852), price(1.0851))).toBe(false)
  })
})

// ------------------------------------------------------------------------------ the hub

class PriceSource implements LocalWatchSource {
  readonly id = 'price'
  readonly title = 'Price'
  readonly description = ''
  readonly targetHint = 'oanda:EURUSD'
  seed: Observation | null = price(1.08)
  available(): boolean {
    return true
  }
  fields(): SourceField[] {
    return [{ name: 'price', label: 'Price', kind: 'number', unit: null, description: '', choices: [] }]
  }
  normaliseTarget(target: string): string {
    return target
  }
  async current(): Promise<Observation | null> {
    return this.seed
  }
}

function backend(canWatch?: (target: string) => string | null) {
  const source = new PriceSource()
  const registry = new LocalWatchRegistry({ sources: [source], onChange: () => void store.refresh() })
  const store = new WatchStore(registry)
  const alerts = new PriceAlerts()
  alerts.connect({ store, canWatch })
  return { source, registry, store, alerts }
}

const LEVEL = { price: 1.085, label: '1W level' }

describe('PriceAlerts', () => {
  test('with no backend nothing can be alerted, and nothing is asked', async () => {
    const alerts = new PriceAlerts()
    expect(alerts.available).toBe(false)
    expect(alerts.refusal('oanda:EURUSD')).not.toBeNull()
    expect(await alerts.enable(EURUSD, LEVEL, 5)).toBeNull()
  })

  test('enabling makes one watch that keeps watching, named for the line', async () => {
    const { alerts, store } = backend()
    const watch = await alerts.enable(EURUSD, LEVEL, 5)
    expect(watch).toMatchObject({
      source: 'price',
      target: 'oanda:EURUSD',
      name: 'EURUSD 1W level 1.08500',
      note: 'alert zone ±5 pips (10 wide) · 1.08450–1.08550',
      trigger: 'edge',
      repeat: 'always',
      cooldownMs: PRICE_ALERT_COOLDOWN_MS
    })
    expect(alerts.at('oanda', 'EURUSD', 1.085, 5)?.watch.id).toBe(must(watch).id)
    expect(alerts.at('oanda', 'EURUSD', 1.08501, 5)).toBeNull()
    // A second click, and a double click, find the one there is.
    await Promise.all([alerts.enable(EURUSD, LEVEL, 5), alerts.enable(EURUSD, LEVEL, 5)])
    expect(store.list()).toHaveLength(1)
  })

  test('a new buffer keeps the line\'s price; removing it removes the watch', async () => {
    const { alerts, store } = backend()
    const { id } = must(await alerts.enable(EURUSD, { price: 1.08523, label: '1M level' }, 5))
    await alerts.setPips(id, EURUSD, 12.5)
    const alert = must(alerts.get(id))
    expect(alert.zone.low).toBe(1.08398)
    expect(alert.zone.high).toBe(1.08648)
    expect(zones.centredOn(alert.zone, 1.08523, 5)).toBe(true)
    expect(alert.watch.note).toBe('alert zone ±12.5 pips (25 wide) · 1.08398–1.08648')
    await alerts.remove(id)
    expect(store.list()).toEqual([])
    expect(alerts.forInstrument('oanda', 'EURUSD')).toEqual([])
  })

  test('the wall may refuse an instrument, and says why', async () => {
    const { alerts } = backend((target) => (target === 'oanda:EURUSD' ? null : 'This replay walks EURUSD'))
    expect(alerts.refusal('oanda:EURUSD')).toBeNull()
    expect(alerts.refusal('oanda:GBPUSD')).toBe('This replay walks EURUSD')
  })

  test('a plain price watch is not a price alert', async () => {
    const { alerts, store } = backend()
    await store.create({ source: 'price', target: 'oanda:EURUSD', condition: { field: 'price', op: 'crosses', value: 1.085 } })
    expect(alerts.forInstrument('oanda', 'EURUSD')).toEqual([])
  })

  test('END TO END: it fires on arriving in the zone, not on leaving, and again after the cooldown', async () => {
    const { alerts, registry, source } = backend()
    source.seed = price(1.0830) // armed below the zone
    await alerts.enable(EURUSD, LEVEL, 5)
    const t0 = 1_000_000
    expect(registry.onEvent('price', 'oanda:EURUSD', t0, price(1.0840))).toHaveLength(0)
    expect(registry.onEvent('price', 'oanda:EURUSD', t0 + 1_000, price(1.0847))).toHaveLength(1)
    // Through the level and out of the top: nothing.
    expect(registry.onEvent('price', 'oanda:EURUSD', t0 + 2_000, price(1.0852))).toHaveLength(0)
    expect(registry.onEvent('price', 'oanda:EURUSD', t0 + 3_000, price(1.0860))).toHaveLength(0)
    // Back in from above, inside the cooldown: quiet.
    expect(registry.onEvent('price', 'oanda:EURUSD', t0 + 4_000, price(1.0853))).toHaveLength(0)
    expect(registry.onEvent('price', 'oanda:EURUSD', t0 + 5_000, price(1.0860))).toHaveLength(0)
    // ...and after it, heard.
    const later = t0 + 1_000 + PRICE_ALERT_COOLDOWN_MS
    const fired = registry.onEvent('price', 'oanda:EURUSD', later, price(1.0854))
    expect(fired).toHaveLength(1)
    expect(fired[0].title).toBe('EURUSD 1W level 1.08500')
    await flush()
    expect(alerts.forInstrument('oanda', 'EURUSD')[0].watch.fireCount).toBe(2)
  })
})

// ------------------------------------------------------------------------------ the pane

interface Datum {
  price: number
  live: boolean
}

const TEMPLATE = 'LAYER:alerts'

function alertLayer(data: Datum[], offer: Partial<LayerAlerts<Datum>> = {}): ChartLayer<Datum, { zonePips: number }> {
  return {
    id: 'test',
    label: 'Test',
    defaults: { zonePips: 5 },
    fields: [],
    available: () => true,
    cacheKey: () => 'k',
    datumKey: (datum) => String(datum.price),
    fetch: async () => data,
    toOverlays: (held) =>
      held.map((datum) => ({
        name: 'horizontalRayLine',
        points: [{ value: datum.price }],
        extendData: datum,
        styles: { line: { size: 1 } }
      })),
    alerts: {
      target: (datum) => (datum.live ? { price: datum.price, label: 'test line' } : null),
      zonePipsSetting: 'zonePips',
      ...offer
    }
  }
}

interface PaneChart {
  chart: Chart
  overlays: OverlayCreate[]
  dom: HTMLElement
}

function paneChart(): PaneChart {
  const bars = Array.from({ length: 50 }, (_, i) => ({ timestamp: 1_000_000 + i * 3_600_000, open: 1.08, high: 1.09, low: 1.07, close: 1.08 }))
  const root = document.createElement('div')
  root.className = 'klinecharts-pro'
  const dom = document.createElement('div')
  root.appendChild(dom)
  document.body.appendChild(root)
  const indicators = [{ id: 'ind1', name: TEMPLATE, paneId: 'candle_pane', calcParams: [], visible: true } as unknown as Indicator]
  const state: PaneChart = { chart: null as unknown as Chart, overlays: [], dom }
  state.chart = {
    getIndicators: (filter?: { id?: string }) => indicators.filter((indicator) => !filter?.id || indicator.id === filter.id),
    getDataList: () => bars,
    getVisibleRange: () => ({ from: 0, to: bars.length, realFrom: 0, realTo: bars.length - 1 }),
    getYAxes: () => [{ getRange: () => ({ from: 1.07, to: 1.1 }) }],
    getDom: () => dom,
    convertToPixel: () => ({ y: 100 }),
    createOverlay: (value: OverlayCreate | OverlayCreate[]) => {
      state.overlays.push(...(Array.isArray(value) ? value : [value]))
      return 'id'
    },
    removeOverlay: (filter: { groupId?: string }) => {
      state.overlays = state.overlays.filter((overlay) => overlay.groupId !== filter.groupId)
    },
    subscribeAction: () => {},
    unsubscribeAction: () => {}
  } as unknown as Chart
  return state
}

const click = (overlay: OverlayCreate | undefined) => overlay?.onClick?.({} as never)
const lines = (pane: PaneChart) => pane.overlays.filter((overlay) => overlay.name === 'horizontalRayLine')
const bells = (pane: PaneChart) => pane.overlays.filter((overlay) => overlay.name === 'wdPriceAlert')
/** What the line's bell says beside it: 'once', 'always' or 'off' (figures.ts `bellStyles`). */
const markOf = (bell: OverlayCreate) => (bell.styles as { bellMark?: string } | undefined)?.bellMark
const zoneBand = (pane: PaneChart) => pane.overlays.find((overlay) => overlay.name === 'wdPriceAlertZone')
const editor = () => document.querySelector<HTMLElement>('.wd-price-alert')

let releases: Array<() => void> = []
afterEach(() => {
  for (const release of releases) release()
  releases = []
  editor()?.remove()
  // A confirmation lingers for its own 1.6 s, in the root of the pane that raised it.
  for (const note of document.querySelectorAll('.wd-watch-flash')) note.remove()
})

async function mountPane(
  data: Datum[],
  options: {
    alerts?: InstanceType<typeof PriceAlerts>
    zonePips?: number
    editable?: boolean
    offer?: Partial<LayerAlerts<Datum>>
  } = {}
) {
  const hub = options.alerts ?? backend().alerts
  const controller = createLayerController(alertLayer(data, options.offer), TEMPLATE, hub)
  const pane = paneChart()
  const fake = fakePane('p1', pane.chart, 'EURUSD')
  ;(fake.getSymbol() as { pipSize?: number }).pipSize = 0.0001
  /** What the binding's `editConfig` was asked to write -- the host's half is host.test.ts. */
  const edits: Array<[string, unknown]> = []
  const edit = options.editable === false ? undefined : (key: string, value: unknown) => void edits.push([key, value])
  releases.push(controller.attach(fake, 'ind1', { zonePips: options.zonePips ?? 5 }, edit))
  await flush()
  await flush()
  return { pane, alerts: hub, edits }
}

const flashed = () => document.querySelector('.wd-watch-flash')?.textContent ?? null

/** Clicks and lets the store's answer land. */
async function clickAndSettle(overlay: OverlayCreate | undefined) {
  click(overlay)
  await flush()
  await flush()
}

describe('on a pane', () => {
  test('every overlay a layer paints survives a right-click, with or without alerts', async () => {
    const controller = createLayerController({ ...alertLayer([{ price: 1.085, live: true }]), alerts: undefined }, TEMPLATE)
    const pane = paneChart()
    releases.push(controller.attach(fakePane('p1', pane.chart), 'ind1', { zonePips: 5 }))
    await flush()
    let prevented = false
    lines(pane)[0].onRightClick?.({ preventDefault: () => (prevented = true) } as never)
    expect(prevented).toBe(true)
    // ...and a layer with no alert offer draws no handlers of the alerts' own.
    expect(lines(pane)[0].onClick).toBeUndefined()
  })

  test('clicks step a line round off -> every time -> once -> off -> every time, saying each -- no dialog', async () => {
    const { pane, alerts } = await mountPane([{ price: 1.085, live: true }])
    const alert = () => alerts.forInstrument('oanda', 'EURUSD')
    await clickAndSettle(lines(pane)[0])
    expect(alert()).toHaveLength(1)
    expect(alert()[0].watch.repeat).toBe('always')
    expect(bells(pane)).toHaveLength(1)
    expect(bells(pane)[0].points?.[0]?.value).toBeCloseTo(1.085, 9)
    expect(markOf(bells(pane)[0])).toBe('always')
    expect(editor()).toBeNull()
    expect(flashed()).toBe('Alert every time · test line 1.08500 · ±5 pips (10 wide) · 1.08450–1.08550')

    await clickAndSettle(lines(pane)[0])
    expect(alert()).toHaveLength(1)
    expect(alert()[0].watch.repeat).toBe('once')
    expect(alert()[0].watch.status).toBe('armed')
    expect(markOf(bells(pane)[0])).toBe('once')
    expect(flashed()).toBe('Alert once · test line 1.08500 · ±5 pips (10 wide) · 1.08450–1.08550')

    await clickAndSettle(lines(pane)[0])
    expect(alert()).toEqual([])
    expect(bells(pane)).toHaveLength(0)
    expect(flashed()).toBe('Alert off · test line 1.08500')

    await clickAndSettle(lines(pane)[0])
    expect(alert()).toHaveLength(1)
    expect(alert()[0].watch.repeat).toBe('always')
  })

  test('the hover says how the line is armed and what the next click does', async () => {
    const { pane } = await mountPane([{ price: 1.085, live: true }], { zonePips: 3 })
    const label = () => {
      lines(pane)[0].onMouseEnter?.({} as never)
      const text = (zoneBand(pane)?.extendData as { label?: string } | undefined)?.label
      lines(pane)[0].onMouseLeave?.({} as never)
      return text
    }
    expect(label()).toBe('Click to alert every time · zone ±3 pips (6 wide) · 1.08470–1.08530')
    await clickAndSettle(lines(pane)[0])
    expect(label()).toBe('Alert zone ±3 pips (6 wide) · 1.08470–1.08530 · alert every time · click to alert once')
    await clickAndSettle(lines(pane)[0])
    expect(label()).toBe('Alert zone ±3 pips (6 wide) · 1.08470–1.08530 · alert once · click to turn off')
  })

  test('a double click is one step, never two', async () => {
    const { pane, alerts } = await mountPane([{ price: 1.085, live: true }])
    click(lines(pane)[0])
    click(lines(pane)[0])
    await flush()
    await flush()
    expect(alerts.forInstrument('oanda', 'EURUSD').map((a) => a.watch.repeat)).toEqual(['always'])
  })

  test('armed once, an alert fires the first time and is done; the next click turns it off', async () => {
    const { alerts, registry } = backend()
    const { pane } = await mountPane([{ price: 1.085, live: true }], { alerts })
    await clickAndSettle(lines(pane)[0])
    await clickAndSettle(lines(pane)[0])
    expect(alerts.forInstrument('oanda', 'EURUSD')[0].watch.repeat).toBe('once')
    // Enters the zone from below (armed at 1.08): fires, and once is once.
    expect(registry.onEvent('price', 'oanda:EURUSD', 1, price(1.0846))).toHaveLength(1)
    expect(registry.onEvent('price', 'oanda:EURUSD', 2, price(1.08))).toHaveLength(0)
    expect(registry.onEvent('price', 'oanda:EURUSD', 3, price(1.0846))).toHaveLength(0)
    await flush()
    await flush()
    expect(alerts.forInstrument('oanda', 'EURUSD')[0].watch.status).toBe('fired')
    // Its bell still says 1, in the fired grey.
    expect(markOf(bells(pane)[0])).toBe('once')
    expect(bells(pane)[0].styles?.rect?.color).toBe('#787b86')
    // Spent, it is still once: the cycle goes on to off, then every time, armed afresh.
    await clickAndSettle(lines(pane)[0])
    expect(alerts.forInstrument('oanda', 'EURUSD')).toEqual([])
    await clickAndSettle(lines(pane)[0])
    expect(alerts.forInstrument('oanda', 'EURUSD')[0].watch).toMatchObject({ repeat: 'always', status: 'armed' })
  })

  test('a switched-off alert counts as off: a click arms it every time again', async () => {
    const { alerts, store } = backend()
    const { pane } = await mountPane([{ price: 1.085, live: true }], { alerts })
    await clickAndSettle(lines(pane)[0])
    const [{ watch }] = alerts.forInstrument('oanda', 'EURUSD')
    await store.update(watch.id, { enabled: false })
    await flush()
    expect(markOf(bells(pane)[0])).toBe('off')
    await clickAndSettle(lines(pane)[0])
    expect(alerts.forInstrument('oanda', 'EURUSD')).toHaveLength(1)
    expect(alerts.forInstrument('oanda', 'EURUSD')[0].watch).toMatchObject({ id: watch.id, repeat: 'always', enabled: true, status: 'armed' })
  })

  test('the bell opens the dialog', async () => {
    const { pane } = await mountPane([{ price: 1.085, live: true }])
    await clickAndSettle(lines(pane)[0])
    click(bells(pane)[0])
    expect(editor()?.querySelector('.wd-price-alert-title')?.textContent).toBe('EURUSD test line 1.08500')
    expect(editor()?.querySelector<HTMLInputElement>('input')?.value).toBe('5')
    // The zone it has is shown while the dialog is open.
    expect(zoneBand(pane)?.extendData).toMatchObject({ low: 1.0845, high: 1.0855, preview: false })
  })

  test('a line never rises over its bell, hovered or not', async () => {
    const { pane } = await mountPane([{ price: 1.085, live: true }])
    await clickAndSettle(lines(pane)[0])
    // A hovered overlay is raised over every other unless it holds its level; the bell is the
    // only thing that must win a click where the two overlap.
    expect(lines(pane).every((line) => line.fixedZLevel === true)).toBe(true)
    // ...and klinecharts numbers an overlay without a zLevel by the pane's overlay COUNT, so a
    // layer's own lines reach the hundreds: the bell must be above any count, and below the
    // hover raise (MAX_SAFE_INTEGER) so that a hovered bell still rises.
    const z = bells(pane)[0].zLevel ?? 0
    expect(z).toBeGreaterThan(1_000_000)
    expect(z).toBeLessThan(Number.MAX_SAFE_INTEGER)
  })

  test('a line that cannot have an alert is not clickable', async () => {
    const { pane } = await mountPane([{ price: 1.085, live: false }])
    expect(lines(pane)[0].onClick).toBeUndefined()
  })

  test('hovering shows the zone and what a click on that thing does', async () => {
    const { pane } = await mountPane([{ price: 1.085, live: true }], { zonePips: 3 })
    lines(pane)[0].onMouseEnter?.({} as never)
    expect(zoneBand(pane)?.extendData).toMatchObject({
      low: 1.0847,
      high: 1.0853,
      preview: true,
      label: 'Click to alert every time · zone ±3 pips (6 wide) · 1.08470–1.08530'
    })
    lines(pane)[0].onMouseLeave?.({} as never)
    expect(zoneBand(pane)).toBeUndefined()

    await clickAndSettle(lines(pane)[0])
    lines(pane)[0].onMouseEnter?.({} as never)
    expect(zoneBand(pane)?.extendData).toMatchObject({
      preview: false,
      label: 'Alert zone ±3 pips (6 wide) · 1.08470–1.08530 · alert every time · click to alert once'
    })
    lines(pane)[0].onMouseLeave?.({} as never)
    bells(pane)[0].onMouseEnter?.({} as never)
    expect(zoneBand(pane)?.extendData).toMatchObject({
      label: 'Alert zone ±3 pips (6 wide) · 1.08470–1.08530 · alert every time · click for options'
    })
  })

  test('the bell says once or every time, and going from one to the other repaints it', async () => {
    const { pane } = await mountPane([{ price: 1.085, live: true }])
    await clickAndSettle(lines(pane)[0])
    const always = overlaySignature(bells(pane))
    await clickAndSettle(lines(pane)[0])
    // Both orange: only the mark tells them apart, so the mark must be in what the paint gate sees.
    expect(bells(pane)[0].styles?.rect?.color).toBe('#ff9800')
    expect(overlaySignature(bells(pane))).not.toBe(always)
  })

  test('the dialog sets the buffer -- previewed while typed, applied on Enter -- and removes the alert', async () => {
    const { pane, alerts } = await mountPane([{ price: 1.085, live: true }])
    await clickAndSettle(lines(pane)[0])
    click(bells(pane)[0])
    const input = must(editor()?.querySelector<HTMLInputElement>('input'))
    input.value = '10'
    input.dispatchEvent(new Event('input'))
    expect(zoneBand(pane)?.extendData).toMatchObject({ low: 1.084, high: 1.086 })
    expect(editor()?.querySelector('.wd-price-alert-zone')?.textContent).toBe('±10 pips (20 wide) · 1.08400–1.08600')
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flush()
    expect(editor()).toBeNull()
    const [alert] = alerts.forInstrument('oanda', 'EURUSD')
    expect([alert.zone.low, alert.zone.high]).toEqual([1.084, 1.086])

    // The bell opens it again, at the buffer it has now.
    click(bells(pane)[0])
    expect(editor()?.querySelector<HTMLInputElement>('input')?.value).toBe('10')
    editor()?.querySelector<HTMLButtonElement>('.wd-price-alert-remove')?.click()
    await flush()
    await flush()
    expect(alerts.forInstrument('oanda', 'EURUSD')).toEqual([])
    expect(bells(pane)).toHaveLength(0)
  })

  test('"Make default" writes the layer\'s own setting with the buffer in the box, and gives the alert it too', async () => {
    const { pane, alerts, edits } = await mountPane([{ price: 1.085, live: true }], { zonePips: 3 })
    await clickAndSettle(lines(pane)[0])
    click(bells(pane)[0])
    const button = must(editor()?.querySelector<HTMLButtonElement>('.wd-price-alert-make-default'))
    const said = () => editor()?.querySelector('.wd-price-alert-default-text')?.textContent
    expect(said()).toBe('New alerts: 3 pips each side')
    // The box holds the default already: nothing to make.
    expect(button.disabled).toBe(true)

    const input = must(editor()?.querySelector<HTMLInputElement>('input'))
    input.value = '4'
    input.dispatchEvent(new Event('input'))
    expect(button.disabled).toBe(false)
    button.click()
    await flush()
    expect(edits).toEqual([['zonePips', 4]])
    expect(said()).toBe('New alerts: 4 pips each side')
    expect(button.disabled).toBe(true)
    const [alert] = alerts.forInstrument('oanda', 'EURUSD')
    expect([alert.zone.low, alert.zone.high]).toEqual([1.0846, 1.0854])
  })

  test('with nowhere to write a default, the dialog offers none', async () => {
    const { pane } = await mountPane([{ price: 1.085, live: true }], { editable: false })
    await clickAndSettle(lines(pane)[0])
    click(bells(pane)[0])
    expect(editor()).not.toBeNull()
    expect(editor()?.querySelector('.wd-price-alert-make-default')).toBeNull()
  })

  test('an alert whose line is not drawn keeps its bell, so it can still be removed', async () => {
    const hub = backend().alerts
    await hub.enable(EURUSD, { price: 1.09, label: '1W level' }, 5)
    const { pane } = await mountPane([{ price: 1.085, live: true }], { alerts: hub })
    expect(bells(pane).map((bell) => bell.points?.[0]?.value)).toEqual([1.09])
  })

  test('a wall that refuses the instrument says why and makes nothing', async () => {
    const { alerts } = backend(() => 'This replay walks GBPUSD')
    const { pane } = await mountPane([{ price: 1.085, live: true }], { alerts })
    lines(pane)[0].onMouseEnter?.({} as never)
    expect(zoneBand(pane)).toBeUndefined()
    await clickAndSettle(lines(pane)[0])
    expect(alerts.forInstrument('oanda', 'EURUSD')).toEqual([])
    expect(flashed()).toBe('This replay walks GBPUSD')
  })

  test('taking the layer off the pane takes its zone and its dialog with it', async () => {
    const { pane } = await mountPane([{ price: 1.085, live: true }])
    await clickAndSettle(lines(pane)[0])
    click(bells(pane)[0])
    expect(editor()).not.toBeNull()
    releases.pop()?.()
    expect(editor()).toBeNull()
    expect(pane.overlays).toEqual([])
  })
})

describe('removing many at once, from the dialog\'s foot', () => {
  const THREE = [
    { price: 1.08, live: true },
    { price: 1.085, live: true },
    { price: 1.09, live: true }
  ]
  const button = (selector: string) => editor()?.querySelector<HTMLButtonElement>(selector) ?? null
  const text = (selector: string) => editor()?.querySelector(selector)?.textContent ?? null

  /** A pane with an every-time alert on each line, and the dialog open on the middle one. */
  async function withThree(offer: Partial<LayerAlerts<Datum>> = {}) {
    const mounted = await mountPane(THREE, { offer })
    for (const line of lines(mounted.pane)) await clickAndSettle(line)
    expect(mounted.alerts.forInstrument('oanda', 'EURUSD')).toHaveLength(3)
    click(bells(mounted.pane).find((bell) => bell.points?.[0]?.value === 1.085))
    await flush()
    return mounted
  }

  test('says how many there are on the instrument; Remove all asks first, and Cancel keeps them', async () => {
    const { alerts } = await withThree()
    expect(text('.wd-price-alert-bulk-summary')).toBe('Test alerts on EURUSD: 3')
    // This layer cannot tell stale from live, so it offers Remove all alone.
    expect(button('.wd-price-alert-remove-stale')).toBeNull()
    button('.wd-price-alert-remove-all')?.click()
    expect(text('.wd-price-alert-bulk-question')).toBe('Remove all 3 alerts?')
    expect(alerts.forInstrument('oanda', 'EURUSD')).toHaveLength(3)
    ;[...(editor()?.querySelectorAll<HTMLButtonElement>('.wd-price-alert-bulk-confirm button') ?? [])].find((b) => b.textContent === 'Cancel')?.click()
    expect(button('.wd-price-alert-remove-all')?.textContent).toBe('Remove all (3)')
    expect(alerts.forInstrument('oanda', 'EURUSD')).toHaveLength(3)
  })

  test('Remove all, confirmed, removes every one, closes the dialog and says so', async () => {
    const { pane, alerts } = await withThree()
    button('.wd-price-alert-remove-all')?.click()
    button('.wd-price-alert-remove-all-confirm')?.click()
    expect(editor()).toBeNull()
    await flush()
    await flush()
    expect(alerts.forInstrument('oanda', 'EURUSD')).toEqual([])
    expect(bells(pane)).toHaveLength(0)
    expect(flashed()).toBe('Removed 3 Test alerts on EURUSD')
  })

  test('Remove stale takes only the ones the layer says are stale', async () => {
    let asked: string[] = []
    const { pane, alerts } = await withThree({
      stale: async (held) => {
        asked = held.map((alert) => alert.watch.name)
        return held.filter((alert) => alert.zone.center !== 1.085).map((alert) => alert.watch.id)
      }
    })
    // It is asked about every alert of the layer on the instrument.
    expect(asked.sort()).toEqual(['EURUSD test line 1.08000', 'EURUSD test line 1.08500', 'EURUSD test line 1.09000'])
    expect(button('.wd-price-alert-remove-stale')?.textContent).toBe('Remove stale (2)')
    button('.wd-price-alert-remove-stale')?.click()
    expect(editor()).toBeNull()
    await flush()
    await flush()
    expect(alerts.forInstrument('oanda', 'EURUSD').map((alert) => alert.zone.center)).toEqual([1.085])
    expect(bells(pane)).toHaveLength(1)
    expect(flashed()).toBe('Removed 2 stale Test alerts on EURUSD')
  })

  test('waits for the answer, and says when none are stale or it could not tell', async () => {
    let answer: (ids: string[]) => void = () => {}
    await withThree({ stale: () => new Promise((resolve) => (answer = resolve)) })
    expect(button('.wd-price-alert-remove-stale')).toMatchObject({ textContent: 'Checking for stale…', disabled: true })
    answer([])
    await flush()
    expect(button('.wd-price-alert-remove-stale')).toMatchObject({ textContent: 'None stale', disabled: true })
    editor()?.remove()

    await withThree({ stale: () => Promise.reject(new Error('levels unreachable')) })
    await flush()
    expect(button('.wd-price-alert-remove-stale')).toMatchObject({ textContent: 'Stale: could not check', disabled: true })
  })

  test('counts and removes only the layer\'s own alerts', async () => {
    const { alerts } = await withThree({ owns: (alert) => alert.zone.center !== 1.09 })
    expect(text('.wd-price-alert-bulk-summary')).toBe('Test alerts on EURUSD: 2')
    button('.wd-price-alert-remove-all')?.click()
    button('.wd-price-alert-remove-all-confirm')?.click()
    await flush()
    await flush()
    expect(alerts.forInstrument('oanda', 'EURUSD').map((alert) => alert.zone.center)).toEqual([1.09])
    expect(flashed()).toBe('Removed 2 Test alerts on EURUSD')
  })

  test('one alone is "1 alert"', async () => {
    const { pane } = await mountPane([{ price: 1.085, live: true }], {
      offer: { stale: async (held) => held.map((alert) => alert.watch.id) }
    })
    await clickAndSettle(lines(pane)[0])
    click(bells(pane)[0])
    await flush()
    expect(button('.wd-price-alert-remove-stale')?.title).toBe('Remove the 1 stale alert: its line is no longer live')
    button('.wd-price-alert-remove-all')?.click()
    expect(text('.wd-price-alert-bulk-question')).toBe('Remove the 1 alert?')
    ;[...(editor()?.querySelectorAll<HTMLButtonElement>('.wd-price-alert-bulk-confirm button') ?? [])].find((b) => b.textContent === 'Cancel')?.click()
    button('.wd-price-alert-remove-stale')?.click()
    await flush()
    await flush()
    expect(bells(pane)).toHaveLength(0)
    expect(flashed()).toBe('Removed 1 stale Test alert on EURUSD')
  })
})

describe('the bell', () => {
  const draw = (mark: 'once' | 'always' | 'off') => figures.bellFigures(figures.bellStyles('#ff9800', mark), 800, 100)
  const paths = (mark: 'once' | 'always' | 'off') =>
    draw(mark)
      .filter((figure) => figure.type === 'path')
      .map((figure) => (figure.attrs as { path: string }).path)

  test('is a pill hard against the right edge, the only part that takes the pointer', () => {
    for (const mark of ['once', 'always', 'off'] as const) {
      const [pill, ...marks] = draw(mark)
      expect(pill).toMatchObject({ type: 'rect', attrs: { x: 800 - 4 - 30, y: 92, width: 30, height: 16 } })
      expect(pill.ignoreEvent).toBeUndefined()
      expect(marks.every((figure) => figure.ignoreEvent === true)).toBe(true)
    }
  })

  test('says beside its bell how the alert is armed: 1, a repeat arrow, or struck through', () => {
    const [bell] = paths('once')
    expect(paths('once')).toHaveLength(2)
    expect(paths('always')).toHaveLength(3)
    // Once and every time share the bell and differ in the mark; off is the bell alone, struck.
    expect(paths('always')[0]).toBe(bell)
    expect(paths('once')[1]).not.toBe(paths('always')[1])
    expect(paths('off')).toEqual([bell, expect.any(String)])
    expect(draw('off')[2]).toMatchObject({ styles: { style: 'stroke' } })
  })

  test('without a mark it says every time, the default of a level alert', () => {
    expect(figures.bellFigures({ rect: { color: '#ff9800' } }, 800, 100)).toHaveLength(draw('always').length)
  })
})

describe('across panes', () => {
  /** Three panes on ONE controller, as a wall has them: two on EURUSD, one on GBPUSD. */
  async function wall() {
    const { alerts } = backend()
    const controller = createLayerController(alertLayer([{ price: 1.085, live: true }]), TEMPLATE, alerts)
    const panes = (['EURUSD', 'EURUSD', 'GBPUSD'] as const).map((ticker, index) => {
      const pane = paneChart()
      const fake = fakePane(`p${index}`, pane.chart, ticker)
      ;(fake.getSymbol() as { pipSize?: number }).pipSize = 0.0001
      releases.push(controller.attach(fake, 'ind1', { zonePips: 5 }))
      return pane
    })
    await flush()
    await flush()
    return { alerts, panes }
  }

  test('an alert enabled on one pane is a bell on every pane of its instrument, and on no other', async () => {
    const { alerts, panes } = await wall()
    const [a, b, c] = panes
    await clickAndSettle(lines(a)[0])
    expect(alerts.forInstrument('oanda', 'EURUSD')).toHaveLength(1)
    expect(bells(a)).toHaveLength(1)
    expect(bells(b)).toHaveLength(1)
    expect(bells(c)).toHaveLength(0)
    // The same level on the other instrument is its own question.
    expect(alerts.forInstrument('oanda', 'GBPUSD')).toEqual([])
  })

  test('one editor at a time, its zone on its own pane; an edit or a removal there reaches the others', async () => {
    const { alerts, panes } = await wall()
    const [a, b] = panes
    await clickAndSettle(lines(a)[0])
    click(bells(a)[0])
    expect(zoneBand(a)).toBeDefined()

    // The bell on the other pane opens it there, and closes the first.
    click(bells(b)[0])
    expect(document.querySelectorAll('.wd-price-alert')).toHaveLength(1)
    expect(zoneBand(a)).toBeUndefined()
    expect(zoneBand(b)).toBeDefined()

    const input = must(editor()?.querySelector<HTMLInputElement>('input'))
    input.value = '8'
    input.dispatchEvent(new Event('input'))
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    await flush()
    // Pane a's hover now shows the width set on pane b.
    lines(a)[0].onMouseEnter?.({} as never)
    expect(zoneBand(a)?.extendData).toMatchObject({ low: 1.0842, high: 1.0858, preview: false })
    lines(a)[0].onMouseLeave?.({} as never)

    click(bells(b)[0])
    editor()?.querySelector<HTMLButtonElement>('.wd-price-alert-remove')?.click()
    await flush()
    await flush()
    expect(alerts.forInstrument('oanda', 'EURUSD')).toEqual([])
    expect(bells(a)).toHaveLength(0)
    expect(bells(b)).toHaveLength(0)
  })
})

function watchOf(condition: Watch['condition']): Watch {
  return {
    id: 'w',
    source: 'price',
    target: 'oanda:EURUSD',
    condition,
    name: '',
    note: '',
    enabled: true,
    trigger: 'edge',
    repeat: 'always',
    cooldownMs: 0,
    createdAt: 0,
    updatedAt: 0,
    armedAt: 0,
    status: 'armed',
    lastFiredAt: null,
    fireCount: 0
  }
}
