import type { KLineData } from 'klinecharts'
import type { ChartProPane } from '../../src'
import { periodToResolution } from '../periods'
import { chartTheme } from './controls'
import { formatClock } from './format'
import { gridFor } from './timeframes'

// GLUE (DOM). Choosing where a replay starts by pointing at the chart: hover a bar, see the
// bars that will be hidden shaded out to its right, click it. The bar clicked is the LAST one
// the replay opens with -- the start is its close, which is exactly "every bar that had closed
// by then", the replay's own rule for what a pane shows.
//
// Nothing is laid over the chart that takes the pointer: the line, the shade and the hint are
// fixed-position and `pointer-events: none`, and the click is read off the chart's own element
// in the capture phase. So a drag still pans and the wheel still zooms while picking -- the
// bar you want is usually not on screen when you start looking for it. Only a CLICK (less
// than klinecharts' 5px of travel) picks, and that click is kept from the chart, whose own
// click would re-centre the rest of the wall on it.

export interface BarPick {
  /** The replay's start: the close of the bar clicked. */
  startAt: number
  /** The interval of the pane it was clicked on. */
  resolution: string
}

const CANDLE_PANE = 'candle_pane'
/** klinecharts' `ManhattanDistance.CancelClick`: more travel than this is a drag. */
const CLICK_SLOP_PX = 5

/** Enter the pick mode over every pane on the wall. `done` gets the pick, or null when it was
 * cancelled (Escape, or the hint's Cancel). Returns a disposer that cancels without calling
 * `done`. */
export function pickBarOnChart(panes: ChartProPane[], done: (pick: BarPick | null) => void): () => void {
  const layer = el('div', 'wd-replay-pick')
  const shade = el('div', 'wd-replay-pick-shade')
  const line = el('div', 'wd-replay-pick-line')
  const tag = el('div', 'wd-replay-pick-tag')
  // A body-level card carries the chart's theme class, or it renders in the light defaults.
  const hint = el('div', `wd-replay-pick-hint ${chartTheme()}`)
  const words = el('span', '')
  words.textContent = 'Click the last bar the replay should show'
  const keys = el('span', 'wd-replay-pick-keys')
  keys.textContent = 'drag to pan · Esc to cancel'
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'kc-button kc-button-outline wd-replay-pick-cancel'
  cancel.textContent = 'Cancel'
  cancel.addEventListener('click', () => finish(null))
  hint.append(words, keys, cancel)
  layer.append(shade, line, tag)
  layer.hidden = true
  document.body.append(layer, hint)

  // The hint sits at the top of the wall, centred on it: the first thing in view and clear of
  // the bars being pointed at.
  const roots = panes.map((p) => p.getChart()?.getDom()).filter((d): d is HTMLElement => !!d)
  if (roots.length > 0) {
    const box = union(roots.map((r) => r.getBoundingClientRect()))
    hint.style.left = `${box.left + box.width / 2}px`
    hint.style.top = `${box.top + 8}px`
  }

  const disposers: Array<() => void> = []
  let finished = false

  for (const pane of panes) {
    const chart = pane.getChart()
    const root = chart?.getDom()
    // A bar's close is a fact of ITS instrument's schedule (a coinbase day closes at UTC
    // midnight). A pane whose instrument has no resolved market hours has no close to offer.
    const grid = gridFor(pane.getSymbol())
    if (!chart || !root || !grid) continue
    let downX = 0
    let downY = 0
    const at = (event: MouseEvent): { bar: KLineData; x: number; main: DOMRect; root: DOMRect } | null => {
      const main = chart.getDom(CANDLE_PANE, 'main')
      if (!main) return null
      const mainRect = main.getBoundingClientRect()
      const x = event.clientX - mainRect.left
      if (x < 0 || x > mainRect.width) return null
      const list = chart.getDataList()
      if (list.length === 0) return null
      const point = chart.convertFromPixel([{ x }], { paneId: CANDLE_PANE })
      const raw = Array.isArray(point) ? point[0]?.dataIndex : point.dataIndex
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
      // Past the newest bar (the empty space klinecharts keeps on the right) is the newest bar.
      const index = Math.min(list.length - 1, Math.max(0, Math.round(raw)))
      const centre = chart.convertToPixel([{ dataIndex: index }], { paneId: CANDLE_PANE })
      const cx = Array.isArray(centre) ? centre[0]?.x : centre.x
      const half = chart.getBarSpace().halfGapBar
      const edge = mainRect.left + (typeof cx === 'number' ? cx + half : x)
      return { bar: list[index], x: edge, main: mainRect, root: root.getBoundingClientRect() }
    }
    const pickOf = (bar: KLineData): BarPick => {
      const resolution = periodToResolution(pane.getPeriod())
      return { startAt: grid.end(resolution, grid.fromWire(resolution, bar.timestamp)), resolution }
    }
    const onMove = (event: PointerEvent): void => {
      const hit = at(event)
      if (!hit) {
        layer.hidden = true
        return
      }
      const right = Math.max(hit.x, hit.main.right)
      layer.hidden = false
      line.style.cssText = `left:${hit.x}px;top:${hit.root.top}px;height:${hit.root.height}px`
      shade.style.cssText = `left:${hit.x}px;top:${hit.root.top}px;height:${hit.root.height}px;width:${Math.max(0, right - hit.x)}px`
      tag.textContent = `Start ${formatClock(pickOf(hit.bar).startAt, grid.schedule.timezone)}`
      // At the foot of the price pane, beside klinecharts' own crosshair date (the bar's OPEN)
      // on the axis below: the two together read "this bar, and the replay starts as it closes".
      tag.style.cssText = `left:${hit.x}px;top:${hit.main.bottom - 26}px`
    }
    const onLeave = (): void => {
      layer.hidden = true
    }
    const onDown = (event: PointerEvent): void => {
      downX = event.clientX
      downY = event.clientY
    }
    // Capture phase on the chart's root: ahead of ChartPane's own click handler (bubble, same
    // element), which would otherwise scroll the rest of the wall to the bar.
    const onClick = (event: MouseEvent): void => {
      if (event.button !== 0) return
      if (Math.abs(event.clientX - downX) + Math.abs(event.clientY - downY) > CLICK_SLOP_PX) return
      const hit = at(event)
      if (!hit) return
      event.stopPropagation()
      finish(pickOf(hit.bar))
    }
    root.addEventListener('pointermove', onMove, { passive: true })
    root.addEventListener('pointerleave', onLeave, { passive: true })
    root.addEventListener('pointerdown', onDown, { capture: true, passive: true })
    root.addEventListener('click', onClick, { capture: true })
    disposers.push(() => {
      root.removeEventListener('pointermove', onMove)
      root.removeEventListener('pointerleave', onLeave)
      root.removeEventListener('pointerdown', onDown, { capture: true })
      root.removeEventListener('click', onClick, { capture: true })
    })
  }

  // Window, capture phase: before the start dialog (hidden meanwhile) or anything else that
  // closes on Escape hears it.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.stopPropagation()
    event.preventDefault()
    finish(null)
  }
  window.addEventListener('keydown', onKey, true)

  function teardown(): void {
    finished = true
    window.removeEventListener('keydown', onKey, true)
    for (const d of disposers) d()
    layer.remove()
    hint.remove()
  }

  function finish(pick: BarPick | null): void {
    if (finished) return
    teardown()
    done(pick)
  }

  return () => {
    if (!finished) teardown()
  }
}

function union(rects: DOMRect[]): { left: number; top: number; width: number } {
  const left = Math.min(...rects.map((r) => r.left))
  const right = Math.max(...rects.map((r) => r.right))
  const top = Math.min(...rects.map((r) => r.top))
  return { left, top, width: right - left }
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}
