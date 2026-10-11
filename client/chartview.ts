import type { Chart } from 'klinecharts'

// klinecharts raises `onVisibleRangeChange` on EVERY data update, a live tick that only moves the
// forming bar's prices included: it re-adjusts the visible range whatever changed. Anything that
// hangs work off that event therefore runs once per tick per pane, where what it wants to know
// is whether the VIEW moved -- a pan, a zoom, a resize, a page of history, a new bar. This is
// that question, asked once, for the subscribers that should not pay per tick.

/** Calls `handler` when the chart's visible bars change -- which bars are on screen, or which
 * bars it holds -- and not when a tick merely updates the forming one. Returns the release. */
export function onViewMoved(chart: Chart, handler: () => void): () => void {
  let last = ''
  const listener = (): void => {
    const range = chart.getVisibleRange()
    const data = chart.getDataList()
    const view = `${range.from}|${range.to}|${range.realFrom}|${range.realTo}|${data.length}|${data[0]?.timestamp}|${data.at(-1)?.timestamp}`
    if (view === last) return
    last = view
    handler()
  }
  chart.subscribeAction('onVisibleRangeChange', listener)
  return () => {
    try {
      chart.unsubscribeAction('onVisibleRangeChange', listener)
    } catch {
      // chart already disposed
    }
  }
}
