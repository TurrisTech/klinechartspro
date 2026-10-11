import type { ChartProSlot, KLineChartPro } from '../../src'

// Puts `element` in one of the library's slots (src/types.ts ChartProSlot) and keeps it
// there. Every slot stays wall-global, not per-pane. There are two separate timing
// problems here, and conflating them is what silently detaches a control for good.
//
// Getting it there the first time is a WAIT, not a mutation. Every caller runs in the same
// tick as the KLineChartPro constructor, and at that point every slot is null: slots are
// `bind:this` targets, and `mount()` inserts their elements into the DOM synchronously but
// only SCHEDULES the effect that assigns them. So the first attempt always misses, and
// there is no later mutation of that DOM to wait for — it is already built. Poll until
// getSlot() resolves, the same answer whenChartReady gave the identical problem for
// getChart(), and never make anything below conditional on that first attempt succeeding.
//
// Keeping it there is the mutation half: 'rail-footer''s own element is destroyed and
// recreated every time the drawing toolbar toggles off and back on — it lives inside
// ChartPro.svelte's `{#if drawingBarVisible}` — so re-parent into whichever instance of the
// slot currently exists rather than attaching once, or the control vanishes for good the
// first time someone hides the drawing tools instead of merely hiding with it.
/** Returns a disposer. Switching workspaces tears the chart down and builds a new one against
 * the SAME container element, so an observer left running would accumulate one per switch,
 * all watching the same live element -- and the element it re-attaches would be one belonging
 * to a chart that no longer exists. */
export function attachToSlot(
  chartPro: KLineChartPro,
  slotName: ChartProSlot,
  element: HTMLElement
): () => void {
  let detached = false
  const tryAttach = (): boolean => {
    if (detached) return true
    const slot = chartPro.getSlot(slotName)
    if (!slot) return false
    if (element.parentElement !== slot) slot.appendChild(element)
    return true
  }

  if (!tryAttach()) {
    // Give up rather than spin forever if the component genuinely failed to build.
    const deadline = performance.now() + 5_000
    const poll = (): void => {
      if (tryAttach() || performance.now() > deadline) return
      requestAnimationFrame(poll)
    }
    requestAnimationFrame(poll)
  }

  // The container, not a root reached through the slot: it exists from the moment the
  // constructor returns, so this is registered unconditionally rather than only once some
  // attempt has already found a slot to navigate up from.
  const observer = new MutationObserver(() => {
    tryAttach()
  })
  observer.observe(chartPro.getContainer(), { childList: true, subtree: true })

  return () => {
    detached = true
    observer.disconnect()
    element.remove()
  }
}
