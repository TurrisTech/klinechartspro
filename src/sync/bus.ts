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
import { isTimestampVisible, resolveSeekTarget, seekToTimestamp } from './seek'

export interface SyncPane {
  id: string
  getChart(): Nullable<Chart>
  // Nominal period length, in ms. Used to classify a seek's direction (lower timeframe ->
  // higher, or the reverse) against the SOURCE pane's own period -- see resolveSeekTarget
  // (src/sync/seek.ts).
  getPeriodMs(): number
  // Reloads this pane's data anchored on `timestamp` instead of "now" -- see
  // ChartPane.svelte's seekTo. What seekPane calls when the target is outside this pane's
  // own loaded history, replacing the old scroll-and-page walk (see git history on this
  // file for that approach and why it fell short at distance). `timestamp`/`fraction` are
  // where the VIEW lands (resolveSeekTarget's span-centring case computes these as a span's
  // midpoint, which is not necessarily an instant that exists); `crosshair` is what to mark
  // once landed -- usually the same instant, but not always, so kept separate rather than
  // assumed equal. Carried through so the implementation can apply it once its own reload
  // lands -- resetData() wipes klinecharts' internal crosshair state, so without this the
  // target pane would jump to the right place but show no crosshair marking it.
  seekTo(timestamp: number, fraction: number, crosshair: CrosshairPoint): void
}

export interface SyncOptions {
  crosshair: boolean
  time: boolean
}

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

  register(pane: SyncPane): void {
    this.panes.set(pane.id, pane)
  }

  unregister(id: string): void {
    this.panes.delete(id)
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
  // calls collapses to the latest target instead of seeking every pane once per call. `point`
  // (not a bare timestamp) so a reload can restore the crosshair afterwards -- see seekPane.
  broadcastSeek(sourceId: string, point: CrosshairPoint, fraction: number): void {
    if (!this.options.time) {
      console.debug('[sync] seek skipped: time sync is off')
      return
    }
    if (this.seekRaf !== 0) cancelAnimationFrame(this.seekRaf)
    this.seekRaf = requestAnimationFrame(() => {
      this.seekRaf = 0
      // Looked up once per dispatch, not per target: every target in this broadcast is
      // judged against the SAME source pane and instant. A source that's since unregistered
      // (torn down mid-rAF) falls back to every target reproducing the click's own on-screen
      // fraction, exactly as if this cross-timeframe positioning didn't exist.
      const source = this.panes.get(sourceId)
      const sourceChart = source?.getChart() ?? null
      const sourcePeriodMs = source?.getPeriodMs() ?? null
      console.debug('[sync] seek dispatch', { sourceId, targets: [...this.panes.keys()].filter((id) => id !== sourceId) })
      for (const [id, pane] of this.panes) {
        if (id === sourceId) continue
        const chart = pane.getChart()
        if (!chart) continue
        this.seekPane(chart, pane, point, fraction, sourceChart, sourcePeriodMs)
      }
    })
  }

  private seekPane(
    chart: Chart,
    pane: SyncPane,
    point: CrosshairPoint,
    fraction: number,
    sourceChart: Nullable<Chart>,
    sourcePeriodMs: number | null
  ): void {
    const dataList = chart.getDataList()
    if (dataList.length === 0) {
      console.debug('[sync] seekPane skipped: no data loaded yet', { pane: pane.id })
      return
    }

    // Cross-timeframe positioning (centre / align-span / anchor-near-left -- see
    // resolveSeekTarget) needs the source's own chart and period; without them (source
    // unregistered) this degrades to reproducing the click's own on-screen fraction.
    const target =
      sourceChart && sourcePeriodMs !== null
        ? resolveSeekTarget(chart, sourceChart, point, sourcePeriodMs, pane.getPeriodMs(), fraction)
        : { timestamp: point.timestamp, fraction, crosshairTimestamp: point.timestamp }
    // Same price, wherever resolveSeekTarget decided to mark the crosshair -- applyCrosshairAt
    // already re-derives the on-screen position on THIS pane's own scale from the raw value.
    // Deliberately NOT target.timestamp: the span-centring case scrolls to a midpoint but the
    // crosshair still marks the instant that was actually clicked (crosshairTimestamp).
    const crosshairTarget: CrosshairPoint = { timestamp: target.crosshairTimestamp, value: point.value }

    // Skips the SCROLL for a pane that already shows the resolved target instead of
    // re-centring it on every click -- but the crosshair still needs to land there: the
    // ordinary hover-driven sync (broadcastCrosshair, from the mousemove that preceded this
    // click) last placed this pane's crosshair at the RAW click point, which resolveSeekTarget
    // may have deliberately moved away from (centred/aligned). Skipping this would leave a
    // stale, wrong crosshair sitting here until the next unrelated mouse move happened to
    // paper over it -- not something to skip.
    if (isTimestampVisible(chart, target.timestamp)) {
      console.debug('[sync] seekPane: target already visible, re-applying crosshair only', { pane: pane.id, target })
      applyCrosshairAt(chart, crosshairTarget)
      return
    }

    const oldest = dataList[0].timestamp
    const newest = dataList[dataList.length - 1].timestamp

    // Inside this pane's own loaded history -- a direct seek reaches it exactly, no fetch.
    if (target.timestamp >= oldest && target.timestamp <= newest) {
      console.debug('[sync] seekPane: direct seek (within loaded history)', { pane: pane.id, target })
      seekToTimestamp(chart, target.timestamp, target.fraction, SEEK_ANIMATION_MS)
      applyCrosshairAt(chart, crosshairTarget)
      return
    }

    // Outside the loaded range in either direction -- reload this pane's data anchored on
    // the target instead of trying to scroll/page there. seekToTimestamp for the actual
    // on-screen placement, and re-applying the crosshair, both happen inside that reload once
    // the target is loaded (resetData() wipes any crosshair this pane had).
    console.debug('[sync] seekPane: reloading pane at target', { pane: pane.id, target })
    pane.seekTo(target.timestamp, target.fraction, crosshairTarget)
  }

  dispose(): void {
    if (this.crosshairRaf !== 0) cancelAnimationFrame(this.crosshairRaf)
    if (this.seekRaf !== 0) cancelAnimationFrame(this.seekRaf)
    this.panes.clear()
  }
}
