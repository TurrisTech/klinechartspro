import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// A chart canvas must never stop repainting because it was resized while a repaint was queued.
//
// klinecharts 10.0.0's Canvas applied a resize from its ResizeObserver by queueing the resize
// inside the next repaint -- but only when no repaint was queued already. If one was (the
// crosshair moving, a tick arriving), the resize was dropped: the canvas kept its old `_width`,
// every later update() saw `_width !== w`, set the CSS size and returned without queueing a
// repaint, and that layer never drew again. On the prod wall that was a crosshair frozen on one
// pane (EURUSD 2h, 2026-10-09: 11 of its 22 canvases 2px stale) while its candles kept drawing.
// 10.0.1 fixed it upstream (Canvas._scheduleDraw ORs a resize into a pending flag, and update()
// stores the new size at once); this pins that behaviour.
//
// A real chart, drawn by klinecharts itself: happy-dom supplies the DOM, every canvas gets a 2D
// context that counts its repaints, and the ResizeObserver is a stand-in this test fires by hand,
// so a resize can be delivered while a repaint is queued -- the order a browser can produce.

GlobalRegistrator.register({ url: 'http://test/', width: 800, height: 600 })
afterAll(() => GlobalRegistrator.unregister())

const repaints = new WeakMap<HTMLCanvasElement, { count: number }>()
// biome-ignore lint/suspicious/noExplicitAny: a stand-in for CanvasRenderingContext2D
;(HTMLCanvasElement.prototype as any).getContext = function (this: HTMLCanvasElement): unknown {
  const state = { count: 0 }
  repaints.set(this, state)
  const props: Record<string | symbol, unknown> = {}
  const methods: Record<string, (...args: unknown[]) => unknown> = {
    // Every repaint starts by clearing the canvas.
    clearRect: () => {
      state.count += 1
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
    has: (target, key) => key in target
  })
}

// happy-dom does no layout, so a canvas's client box is its CSS box -- which is what a browser
// reports for these absolutely sized canvases, and what 10.0.0 read when applying a resize.
for (const [client, css] of [
  ['clientWidth', 'width'],
  ['clientHeight', 'height']
] as const) {
  Object.defineProperty(HTMLCanvasElement.prototype, client, {
    configurable: true,
    get(this: HTMLCanvasElement) {
      return Math.round(Number.parseFloat(this.style[css]) || 0)
    }
  })
}

// The device-pixel-content-box ResizeObserver, delivered only when `deliverResizes` says so. It
// reports a canvas's CSS size (devicePixelRatio is 1 here) whenever that differs from what it
// last reported, as a browser does after layout. Other targets are never reported.
const observers = new Set<FakeResizeObserver>()
class FakeResizeObserver {
  private readonly reported = new Map<Element, string>()
  constructor(private readonly callback: (entries: unknown[], observer: unknown) => void) {
    observers.add(this)
  }
  observe(target: Element): void {
    if (target === document.body) {
      // klinecharts' feature probe: answer that device-pixel-content-box is supported.
      queueMicrotask(() => this.callback([{ target, devicePixelContentBoxSize: [{ inlineSize: 800, blockSize: 600 }] }], this))
      return
    }
    this.reported.set(target, '0x0')
  }
  unobserve(target: Element): void {
    this.reported.delete(target)
  }
  disconnect(): void {
    this.reported.clear()
    observers.delete(this)
  }
  deliver(): void {
    const entries: unknown[] = []
    for (const [target, last] of this.reported) {
      if (!(target instanceof HTMLCanvasElement)) continue
      const inlineSize = Math.round(Number.parseFloat(target.style.width) || 0)
      const blockSize = Math.round(Number.parseFloat(target.style.height) || 0)
      const size = `${inlineSize}x${blockSize}`
      if (size === last) continue
      this.reported.set(target, size)
      entries.push({ target, devicePixelContentBoxSize: [{ inlineSize, blockSize }] })
    }
    if (entries.length > 0) this.callback(entries, this)
  }
}
// biome-ignore lint/suspicious/noExplicitAny: replacing the global for this file
;(globalThis as any).ResizeObserver = FakeResizeObserver
// biome-ignore lint/suspicious/noExplicitAny: replacing the global for this file
;(window as any).ResizeObserver = FakeResizeObserver
function deliverResizes(): void {
  for (const observer of [...observers]) observer.deliver()
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

async function resizeAndRedraw(repaintQueued: boolean): Promise<void> {
  const size = { width: 800, height: 600 }
  const dom = document.createElement('div')
  document.body.appendChild(dom)
  const chart = kc.init(dom)
  if (!chart) throw new Error('no chart')
  // happy-dom does no layout: the chart measures the container it creates inside `dom`.
  const container = dom.firstElementChild as HTMLElement
  Object.defineProperty(container, 'clientWidth', { get: () => size.width })
  Object.defineProperty(container, 'clientHeight', { get: () => size.height })
  chart.setSymbol({ ticker: 'TEST', pricePrecision: 5, volumePrecision: 0 })
  chart.setPeriod({ span: 1, type: 'minute' })
  chart.setDataLoader({ getBars: ({ callback }) => callback(bars, false) })
  chart.createIndicator('VOL')
  chart.resize()
  await frames(3)
  deliverResizes()
  await frames(3)

  const canvases = [...dom.querySelectorAll('canvas')]
  expect(canvases.length).toBeGreaterThan(4)
  const describe = (canvas: HTMLCanvasElement): string => `${canvas.width}x${canvas.height} for ${canvas.style.width} x ${canvas.style.height}`
  // A canvas whose backing store is not its CSS box: what the frozen EURUSD 2h pane showed.
  const stale = (): string[] =>
    canvases
      .filter((canvas) => canvas.width !== Math.round(Number.parseFloat(canvas.style.width)) || canvas.height !== Math.round(Number.parseFloat(canvas.style.height)))
      .map(describe)
  expect(stale()).toEqual([])
  const widths = canvases.map((canvas) => canvas.style.width)

  // 1. A repaint is queued at the current size, as the crosshair moving would queue one (the
  //    control lets it run first).
  chart.resize()
  await Promise.resolve()
  if (!repaintQueued) await frames(2)
  // 2. The pane narrows by 2px and the chart lays out again ...
  size.width = 798
  chart.resize()
  await Promise.resolve()
  // 3. ... and the browser reports the canvases' new device-pixel size before the next frame.
  deliverResizes()
  await frames(3)

  // The scenario did resize canvases, and every canvas's backing store follows its CSS box ...
  expect(canvases.filter((canvas, i) => canvas.style.width !== widths[i]).length).toBeGreaterThan(0)
  expect(stale()).toEqual([])

  // ... and every one still repaints: redraw twice more, as the crosshair would.
  const before = canvases.map((canvas) => repaints.get(canvas)?.count ?? 0)
  chart.resize()
  await frames(2)
  chart.resize()
  await frames(2)
  expect(canvases.filter((canvas, i) => (repaints.get(canvas)?.count ?? 0) <= before[i]).map(describe)).toEqual([])
  kc.dispose(dom)
}

test('a canvas resized while a repaint is queued keeps repainting at its new size', async () => {
  await resizeAndRedraw(true)
})

// The control: the same resize with no repaint queued, which 10.0.0 handled too. If this fails,
// the harness is wrong, not the chart.
test('a canvas resized with no repaint queued keeps repainting at its new size', async () => {
  await resizeAndRedraw(false)
})
