/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 * http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Chart, Nullable } from 'klinecharts'

import { applyCrosshairAt, clearCrosshair, type CrosshairPoint } from './crosshair'
import { isTimestampVisible, seekToTimestamp } from './seek'

export interface SyncPane {
  id: string
  getChart(): Nullable<Chart>
  getPeriodMs(): number
}

export interface SyncOptions {
  crosshair: boolean
  time: boolean
}

// Klinecharts pages 500 bars per forward-load touch (ChartPane's own history window,
// mirrored on the server side by wdashboard-server's default page size). A seek target more
// than this many pages away is clamped instead of paged toward -- see seekPane below.
const PAGE_BARS = 500
const MAX_SEEK_PAGES = 3
// Comfortably longer than a slow /getbars round trip; if the page never lands (fetch failed,
// pane disposed mid-retry), this is what stops the retry subscription from living forever.
const SEEK_RETRY_DEADLINE_MS = 3_000
// Jump, don't pan: an animated scrollByDistance drives onVisibleRangeChange on every frame,
// which multiplies into a lot of redundant work (e.g. the client's levels redraw) across
// every OTHER pane's own debounce. Instantaneous is also the more honest affordance for
// "someone else clicked a date", which is a teleport, not a drag.
const SEEK_ANIMATION_MS = 0

// The wall's crosshair + click-to-scroll registry. One instance per ChartPro shell, created
// in ChartPro.svelte and threaded down to every ChartPane. Panes register/unregister
// themselves from their own onMount/cleanup, so the live set here is always exactly the
// currently-mounted panes -- the bus never reaches out to discover panes on its own.
export class SyncBus {
  private readonly panes = new Map<string, SyncPane>()
  private options: SyncOptions = { crosshair: true, time: true }

  private crosshairRaf = 0
  private pendingCrosshair: { sourceId: string; point: CrosshairPoint } | null = null
  // Guards against re-entrant dispatch: applyCrosshairAt/clearCrosshair on a target never
  // re-fires that target's own onCrosshairChange subscribers (klinecharts dispatches with
  // notExecuteAction: true).
  private dispatchingCrosshair = false

  private seekRaf = 0
  private readonly seekRetryCleanup = new Map<string, () => void>()

  register(pane: SyncPane): void {
    this.panes.set(pane.id, pane)
  }

  unregister(id: string): void {
    this.panes.delete(id)
    this.cancelSeekRetry(id)
    if (this.pendingCrosshair?.sourceId === id) this.pendingCrosshair = null
    // A pane being torn down while it was the crosshair source would otherwise leave every
    // other pane showing a line with no owner left to move or clear it.
    this.clearCrosshair(id)
  }

  setOptions(options: SyncOptions): void {
    this.options = options
  }

  // --- Crosshair -----------------------------------------------------------------------

  broadcastCrosshair(sourceId: string, point: CrosshairPoint): void {
    if (!this.options.crosshair) return
    this.pendingCrosshair = { sourceId, point }
    if (this.crosshairRaf !== 0) return
    this.crosshairRaf = requestAnimationFrame(() => {
      this.crosshairRaf = 0
      this.flushCrosshair()
    })
  }

  // Synchronous, unlike broadcastCrosshair -- a leave must never be overtaken by a stale
  // coalesced move still waiting for its rAF.
  clearCrosshair(sourceId: string): void {
    if (this.crosshairRaf !== 0) {
      cancelAnimationFrame(this.crosshairRaf)
      this.crosshairRaf = 0
    }
    this.pendingCrosshair = null
    this.dispatchCrosshair(sourceId, null)
  }

  private flushCrosshair(): void {
    const pending = this.pendingCrosshair
    this.pendingCrosshair = null
    if (!pending) return
    this.dispatchCrosshair(pending.sourceId, pending.point)
  }

  private dispatchCrosshair(sourceId: string, point: CrosshairPoint | null): void {
    if (this.dispatchingCrosshair) return
    this.dispatchingCrosshair = true
    try {
      for (const [id, pane] of this.panes) {
        if (id === sourceId) continue
        const chart = pane.getChart()
        if (!chart) continue
        if (point === null) clearCrosshair(chart)
        else applyCrosshairAt(chart, point)
      }
    } finally {
      this.dispatchingCrosshair = false
    }
  }

  // --- Click to scroll -------------------------------------------------------------------

  // Coalesced to one rAF per animation frame, same as broadcastCrosshair: a rapid run of
  // calls collapses to the latest target instead of seeking every pane once per call.
  broadcastSeek(sourceId: string, timestamp: number, fraction: number): void {
    if (!this.options.time) {
      console.debug('[sync] seek skipped: time sync is off')
      return
    }
    if (this.seekRaf !== 0) cancelAnimationFrame(this.seekRaf)
    this.seekRaf = requestAnimationFrame(() => {
      this.seekRaf = 0
      console.debug('[sync] seek dispatch', { sourceId, targets: [...this.panes.keys()].filter((id) => id !== sourceId) })
      for (const [id, pane] of this.panes) {
        if (id === sourceId) continue
        const chart = pane.getChart()
        if (!chart) continue
        this.seekPane(chart, pane, timestamp, fraction, 0)
      }
    })
  }

  private seekPane(
    chart: Chart,
    pane: SyncPane,
    timestamp: number,
    fraction: number,
    attempt: number
  ): void {
    const dataList = chart.getDataList()
    if (dataList.length === 0) {
      console.debug('[sync] seekPane skipped: no data loaded yet', { pane: pane.id })
      return
    }

    // Skips a pane that already shows the target instead of re-centring it on every click.
    // Re-checked on each paging retry too: a page landing can bring the target into view
    // without the final scroll ever running.
    if (isTimestampVisible(chart, timestamp)) {
      console.debug('[sync] seekPane skipped: target already visible', { pane: pane.id, timestamp })
      return
    }

    const oldest = dataList[0].timestamp
    const periodMs = pane.getPeriodMs()

    // Already within (or newer than) this pane's loaded history -- a direct seek reaches it.
    // (Seeking to something NEWER than what's loaded isn't specially handled: klinecharts
    // never backward-pages here, live streaming keeps every pane current instead, so a click
    // timestamp is realistically always at or before "now".)
    if (periodMs <= 0 || timestamp >= oldest) {
      console.debug('[sync] seekPane: direct seek (within loaded history)', { pane: pane.id, timestamp, fraction })
      seekToTimestamp(chart, timestamp, fraction, SEEK_ANIMATION_MS)
      return
    }

    const barsAway = (oldest - timestamp) / periodMs
    if (barsAway > MAX_SEEK_PAGES * PAGE_BARS || attempt >= MAX_SEEK_PAGES) {
      // Too far, or the retry budget is spent -- land on the oldest bar this pane actually
      // has rather than triggering an unbounded string of forward-page fetches.
      console.debug('[sync] seekPane: target too far, clamping to oldest loaded bar', { pane: pane.id, oldest, barsAway, attempt })
      seekToTimestamp(chart, oldest, fraction, SEEK_ANIMATION_MS)
      return
    }

    // Scroll toward the (still out of reach) target. convertToPixel extrapolates past the
    // loaded range using this chart's own period, so the distance genuinely points at the
    // older data -- which touches the left (oldest) edge and triggers klinecharts' own
    // forward-page fetch. Retry once that page lands.
    console.debug('[sync] seekPane: seeking toward target, scheduling paging retry', { pane: pane.id, timestamp, attempt })
    seekToTimestamp(chart, timestamp, fraction, SEEK_ANIMATION_MS)
    this.scheduleSeekRetry(chart, pane, timestamp, fraction, attempt)
  }

  private scheduleSeekRetry(
    chart: Chart,
    pane: SyncPane,
    timestamp: number,
    fraction: number,
    attempt: number
  ): void {
    this.cancelSeekRetry(pane.id)
    const onRangeChange = () => {
      this.cancelSeekRetry(pane.id)
      this.seekPane(chart, pane, timestamp, fraction, attempt + 1)
    }
    chart.subscribeAction('onVisibleRangeChange', onRangeChange)
    const timer = setTimeout(() => this.cancelSeekRetry(pane.id), SEEK_RETRY_DEADLINE_MS)
    this.seekRetryCleanup.set(pane.id, () => {
      chart.unsubscribeAction('onVisibleRangeChange', onRangeChange)
      clearTimeout(timer)
    })
  }

  private cancelSeekRetry(paneId: string): void {
    this.seekRetryCleanup.get(paneId)?.()
    this.seekRetryCleanup.delete(paneId)
  }

  dispose(): void {
    if (this.crosshairRaf !== 0) cancelAnimationFrame(this.crosshairRaf)
    if (this.seekRaf !== 0) cancelAnimationFrame(this.seekRaf)
    for (const cleanup of this.seekRetryCleanup.values()) cleanup()
    this.seekRetryCleanup.clear()
    this.panes.clear()
  }
}
