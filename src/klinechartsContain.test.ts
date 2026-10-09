import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// patches/klinecharts@10.0.3.patch, "contained drawing": one throw while a chart draws -- an
// indicator's draw, an overlay's figures, a legend row -- must cost that one thing that frame and
// nothing else. klinecharts 10.0.0 re-armed a canvas's repaint only after its listener returned,
// so a single throw left that canvas unpainted for the life of the chart: on the prod wall, candles
// frozen under a live price axis. 10.0.1 re-arms first, but unpatched a throw still blanks the
// whole canvas on every frame it throws, says nothing, and leaves its ctx.save open.
//
// A real chart, drawn by klinecharts itself: happy-dom supplies the DOM, and every canvas gets a
// 2D context that records what is drawn instead of drawing it.

GlobalRegistrator.register({ url: 'http://test/', width: 800, height: 600 })
afterAll(() => GlobalRegistrator.unregister())

interface FakeContext {
  readonly fills: string[]
  depth: number
}

const contexts: FakeContext[] = []
// biome-ignore lint/suspicious/noExplicitAny: a stand-in for CanvasRenderingContext2D
;(HTMLCanvasElement.prototype as any).getContext = (): unknown => {
  const state: FakeContext = { fills: [], depth: 0 }
  contexts.push(state)
  const props: Record<string | symbol, unknown> = {}
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    save: () => {
      state.depth += 1
    },
    restore: () => {
      state.depth -= 1
    },
    fillText: (text: unknown) => {
      state.fills.push(String(text))
    },
    measureText: (text: unknown) => ({ width: String(text).length * 6 }),
    getLineDash: () => [],
    createLinearGradient: () => ({ addColorStop: () => undefined })
  }
  return new Proxy(props, {
    get: (target, key) => (key in target ? target[key] : typeof key === 'string' && key in methods ? methods[key] : typeof key === 'string' ? () => undefined : undefined),
    set: (target, key, value) => {
      target[key] = value
      return true
    },
    has: (target, key) => key in target,
    deleteProperty: (target, key) => delete target[key]
  })
}

const kc = await import('klinecharts')

const frame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
async function frames(n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) await frame()
}

const bars = Array.from({ length: 50 }, (_, i) => ({
  timestamp: Date.UTC(2026, 0, 1) + i * 60_000,
  open: 1 + i / 1000,
  high: 1.002 + i / 1000,
  low: 0.998 + i / 1000,
  close: 1.001 + i / 1000,
  volume: 100 + i
}))

let throwing = false
let probeDraws = 0
let neighbourDraws = 0
kc.registerIndicator({
  name: 'TEST_THROWS',
  figures: [],
  calc: (data) => data.map(() => ({})),
  draw: ({ ctx }) => {
    probeDraws += 1
    if (throwing) {
      // Mid-path, as a real failure would be: a save opened and never closed.
      ctx.save()
      throw new Error('planted draw failure')
    }
    return true
  }
})
kc.registerIndicator({
  name: 'TEST_NEIGHBOUR',
  figures: [],
  calc: (data) => data.map(() => ({})),
  draw: ({ ctx }) => {
    neighbourDraws += 1
    // Leaves nothing open: the throwing neighbour's unclosed save must not shift this one.
    ctx.save()
    ctx.restore()
    return true
  }
})

test('a throwing price-pane indicator costs that indicator one frame, not the canvas', async () => {
  const errors: unknown[][] = []
  const consoleError = console.error
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  try {
    const dom = document.createElement('div')
    Object.defineProperty(dom, 'clientWidth', { value: 800 })
    Object.defineProperty(dom, 'clientHeight', { value: 600 })
    document.body.appendChild(dom)
    const chart = kc.init(dom)
    if (!chart) throw new Error('no chart')
    chart.setSymbol({ ticker: 'TEST', pricePrecision: 5, volumePrecision: 0 })
    chart.setPeriod({ span: 1, type: 'minute' })
    chart.setDataLoader({ getBars: ({ callback }) => callback(bars, false) })
    chart.createIndicator({ name: 'TEST_THROWS', paneId: 'candle_pane' }, true)
    chart.createIndicator({ name: 'TEST_NEIGHBOUR', paneId: 'candle_pane' }, true)
    await frames(4)
    expect(probeDraws).toBeGreaterThan(0)

    // The throw.
    throwing = true
    const throwsBefore = probeDraws
    const neighbourBefore = neighbourDraws
    chart.resize()
    await frames(4)
    expect(probeDraws).toBeGreaterThan(throwsBefore)
    // The indicator drawn AFTER the thrower still drew in the same frames.
    expect(neighbourDraws).toBeGreaterThan(neighbourBefore)

    // Still throwing, still repainting -- the canvas is never left waiting on a frame that
    // already ran -- and reported once, naming what threw, not once per frame.
    const again = probeDraws
    chart.resize()
    await frames(4)
    chart.resize()
    await frames(4)
    expect(probeDraws).toBeGreaterThan(again)
    const reports = errors.filter((args) => String(args[0]).includes('indicator TEST_THROWS on candle_pane'))
    expect(reports.length).toBe(1)

    // Recovered: the next clean draw paints again, and every context is back to no open saves.
    throwing = false
    const clean = probeDraws
    chart.resize()
    await frames(4)
    expect(probeDraws).toBeGreaterThan(clean)
    for (const ctx of contexts) expect(ctx.depth).toBe(0)
    kc.dispose(dom)
  } finally {
    console.error = consoleError
  }
})

test('a throwing overlay costs that overlay one frame, not the crosshair layer', async () => {
  let throwsOverlay = true
  let throwerCalls = 0
  let neighbourCalls = 0
  kc.registerOverlay({
    name: 'TEST_THROWS_OVERLAY',
    totalStep: 2,
    createPointFigures: () => {
      throwerCalls += 1
      if (throwsOverlay) throw new Error('planted overlay failure')
      return []
    }
  })
  kc.registerOverlay({
    name: 'TEST_NEIGHBOUR_OVERLAY',
    totalStep: 2,
    createPointFigures: () => {
      neighbourCalls += 1
      return []
    }
  })
  const consoleError = console.error
  const errors: unknown[][] = []
  console.error = (...args: unknown[]) => {
    errors.push(args)
  }
  try {
    const dom = document.createElement('div')
    Object.defineProperty(dom, 'clientWidth', { value: 800 })
    Object.defineProperty(dom, 'clientHeight', { value: 600 })
    document.body.appendChild(dom)
    const chart = kc.init(dom)
    if (!chart) throw new Error('no chart')
    chart.setSymbol({ ticker: 'TEST', pricePrecision: 5, volumePrecision: 0 })
    chart.setPeriod({ span: 1, type: 'minute' })
    chart.setDataLoader({ getBars: ({ callback }) => callback(bars, false) })
    await frames(2)
    const point = { timestamp: bars[20].timestamp, value: bars[20].close }
    chart.createOverlay({ name: 'TEST_THROWS_OVERLAY', points: [point] })
    chart.createOverlay({ name: 'TEST_NEIGHBOUR_OVERLAY', points: [point] })
    await frames(4)
    expect(throwerCalls).toBeGreaterThan(0)
    expect(neighbourCalls).toBeGreaterThan(0)

    // The overlay layer keeps repainting -- what the crosshair is drawn on -- and the overlay
    // after the thrower keeps drawing.
    const thrower = throwerCalls
    const neighbour = neighbourCalls
    chart.resize()
    await frames(4)
    chart.resize()
    await frames(4)
    expect(throwerCalls).toBeGreaterThan(thrower)
    expect(neighbourCalls).toBeGreaterThan(neighbour)
    expect(errors.filter((args) => String(args[0]).includes('overlay TEST_THROWS_OVERLAY')).length).toBe(1)

    throwsOverlay = false
    chart.resize()
    await frames(4)
    for (const ctx of contexts) expect(ctx.depth).toBe(0)
    kc.dispose(dom)
  } finally {
    console.error = consoleError
  }
})
