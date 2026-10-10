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

import type { SymbolInfo } from '../types'
import { type PaneClock, translateTimestamp } from './clock'
import type { CrosshairPoint } from './crosshair'
import {
  isTimestampVisible,
  resolveSeekTarget,
  seekToTimestamp,
  visibleMidpointTimestamp
} from './seek'

export interface SyncPane {
  id: string
  getChart(): Nullable<Chart>
  // Nominal period length, in ms. Used to classify a seek's direction (lower timeframe ->
  // higher, or the reverse) against the SOURCE pane's own period -- see resolveSeekTarget
  // (src/sync/seek.ts).
  getPeriodMs(): number
  // What a timestamp on this pane's bar axis means (src/sync/clock.ts). Every instant the bus
  // carries between panes -- a crosshair, a click, a pan's midpoint -- is read on the source's
  // clock and restated on each target's before the target sees it, so a daily bar's session
  // date reaches an intraday pane as the instant the candle opened. Everything a pane is handed
  // through this interface is therefore already on its OWN axis.
  getClock(): PaneClock
  // Reloads this pane's data anchored on `timestamp` instead of "now" -- see
  // ChartPane.svelte's seekTo. What seekPane calls when the target is outside this pane's
  // own loaded history, replacing the old scroll-and-page walk (see git history on this
  // file for that approach and why it fell short at distance). A target past the LIVE EDGE
  // reloads nothing: the pane keeps its current bar where it is, or brings it back on
  // screen -- resolveSeekReach (src/sync/seek.ts) is the whole rule.
  //
  // `timestamp`/`fraction` are where the VIEW lands (resolveSeekTarget's span-centring case
  // computes these as a span's midpoint, which is not necessarily an instant that exists);
  // `crosshair` is what to mark once landed -- usually the same instant, but not always, so
  // kept separate rather than assumed equal. Carried through so the implementation can apply
  // it once its own reload lands -- resetData() wipes klinecharts' internal crosshair state,
  // so without this the target pane would jump to the right place but show no crosshair
  // marking it. `null` for an auto-sync pan (broadcastPan below): a pan is not a pointing
  // gesture, so there is no instant to mark, and the pane should land carrying no crosshair
  // rather than one at an arbitrary point of its new view.
  seekTo(timestamp: number, fraction: number, crosshair: CrosshairPoint | null): void
  // Draws the wall's ruler measurement if this pane is on its instrument, and takes away
  // whatever copy it drew before otherwise -- including when `measurement` is null. Called for
  // the source pane too, so the box being dragged and its copies can never disagree.
  showMeasurement(measurement: Measurement | null): void
  // Marks a synced instant with this pane's crosshair, or clears it (`null`, the source's
  // pointer left). The pane, not the bus, decides how: only it knows whether its data is parked
  // in history, and an instant it does not hold is shown at its edge instead of by a crosshair
  // clamped onto its first or last bar (crosshairReach, src/sync/crosshair.ts).
  showCrosshair(point: CrosshairPoint | null): void
}

export interface MeasurePoint {
  timestamp: number
  value: number
}

// The wall's ruler (Shift + drag on a price pane, see ChartPane.svelte): one measurement at a
// time, made on one pane and shown on every pane on the same instrument, whatever its
// timeframe. Only the same instrument: the box spans two prices, which mean nothing on another.
export interface Measurement {
  sourceId: string
  symbol: SymbolInfo | undefined
  points: [MeasurePoint, MeasurePoint]
  // The clock `points` are on: the source pane's. A copy on another timeframe restates them on
  // its own (translateTimestamp), so a box measured on 1D starts on 1h at the candle's open.
  clock: PaneClock
}

export interface SyncOptions {
  crosshair: boolean
  // Click-to-scroll: a click on one pane scrolls every other one to that instant. Mutually
  // exclusive with `auto` -- see broadcastSeek.
  time: boolean
  // Auto time sync: every pane follows whichever one the user is panning or zooming, keeping
  // the same instant under all their midpoints. While this is on, click-to-scroll is off: with
  // the wall already following the pan there is nothing left for a click to do, and the click
  // that ENDS a pan-drag would immediately re-seek the wall away from where the drag landed.
  auto: boolean
}

// Jump, don't pan: an animated scrollByDistance drives onVisibleRangeChange on every frame,
// which multiplies into a lot of redundant work (e.g. the client's levels redraw) across
// every OTHER pane's own debounce. Instantaneous is also the more honest affordance for
// "someone else clicked a date", which is a teleport, not a drag.
const SEEK_ANIMATION_MS = 0

// Where an auto-sync pan puts the source pane's midpoint instant on every other pane: its own
// midpoint. See visibleMidpointTimestamp (src/sync/seek.ts) for why the middle and not an edge.
const PAN_FRACTION = 0.5

// How long a pan must stand still before a pane that cannot reach the target by scrolling is
// reloaded around it. Scrolling is free, so an in-range pane follows every frame; a reload is a
// round trip to the server, so dragging across a year must not fire one per frame on the way.
const PAN_RELOAD_DEBOUNCE_MS = 200

// The wall's crosshair + click-to-scroll registry. One instance per ChartPro shell, created
// in ChartPro.svelte and threaded down to every ChartPane. Panes register/unregister
// themselves from their own onMount/cleanup, so the live set here is always exactly the
// currently-mounted panes -- the bus never reaches out to discover panes on its own.
export class SyncBus {
  private readonly panes = new Map<string, SyncPane>()
  private options: SyncOptions = { crosshair: true, time: true, auto: false }

  private crosshairRaf = 0
  private pendingCrosshair: { sourceId: string; point: CrosshairPoint; clock: PaneClock | null } | null = null
  // Guards against re-entrant dispatch: a target's showCrosshair (applyCrosshairAt /
  // clearCrosshair) never re-fires that target's own onCrosshairChange subscribers
  // (klinecharts dispatches with notExecuteAction: true).
  private dispatchingCrosshair = false

  private seekRaf = 0

  private panRaf = 0
  private pendingPan: { sourceId: string; timestamp: number; clock: PaneClock | null } | null = null
  // Re-entrancy only. Unlike the crosshair action, klinecharts has no notExecuteAction escape
  // for onVisibleRangeChange: the scroll this bus applies to a target pane dispatches that
  // pane's OWN range-change subscriber synchronously, from inside the loop below.
  //
  // What actually stops a wall of N panes echoing one pan around itself is upstream of here --
  // ChartPane broadcasts only while a real pointer or wheel gesture is driving THAT pane, and a
  // pane the bus scrolled has no such gesture. This flag cannot substitute for that (a pane's
  // reaction reaches broadcastPan a frame later, by which time it is false again); it is here
  // so that a synchronous broadcast from inside a dispatch cannot recurse.
  private dispatchingPan = false
  // Per-pane debounced reload, keyed by pane id -- see PAN_RELOAD_DEBOUNCE_MS. Holds the most
  // recent target, so the reload that eventually fires lands where the pan actually ended
  // rather than where it first left this pane's loaded range.
  private readonly panReloads = new Map<string, { timer: ReturnType<typeof setTimeout>; timestamp: number }>()

  private measurement: Measurement | null = null

  register(pane: SyncPane): void {
    this.panes.set(pane.id, pane)
    // A pane added to the wall while a measurement is up shows it like the rest.
    if (this.measurement) pane.showMeasurement(this.measurement)
  }

  unregister(id: string): void {
    this.panes.delete(id)
    this.cancelPanReload(id)
    if (this.pendingCrosshair?.sourceId === id) this.pendingCrosshair = null
    // A pane being torn down while it was the crosshair source would otherwise leave every
    // other pane showing a line with no owner left to move or clear it.
    this.clearCrosshair(id)
    // Likewise its measurement: the pane that made it is the one whose changes put it away.
    if (this.measurement?.sourceId === id) this.setMeasurement(null)
  }

  setOptions(options: SyncOptions): void {
    const wasAuto = this.options.auto
    this.options = options
    // A pan already coalesced (or a reload already scheduled) when auto sync was switched off
    // must not still land afterwards -- the user turned following off, and a pane jumping one
    // beat later is exactly the thing they just asked to stop.
    if (wasAuto && !options.auto) this.cancelPan()
  }

  // --- Crosshair -----------------------------------------------------------------------

  broadcastCrosshair(sourceId: string, point: CrosshairPoint): void {
    if (!this.options.crosshair) return
    // The source's clock as of the hover, not the flush: the point was read on that axis.
    this.pendingCrosshair = { sourceId, point, clock: this.clockOf(sourceId) }
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
    this.dispatchCrosshair(sourceId, null, null)
  }

  private flushCrosshair(): void {
    const pending = this.pendingCrosshair
    this.pendingCrosshair = null
    if (!pending) return
    this.dispatchCrosshair(pending.sourceId, pending.point, pending.clock)
  }

  private dispatchCrosshair(sourceId: string, point: CrosshairPoint | null, clock: PaneClock | null): void {
    if (this.dispatchingCrosshair) return
    this.dispatchingCrosshair = true
    try {
      for (const [id, pane] of this.panes) {
        if (id === sourceId) continue
        pane.showCrosshair(point && restatePoint(point, clock, pane))
      }
    } finally {
      this.dispatchingCrosshair = false
    }
  }

  // --- Ruler ---------------------------------------------------------------------------

  getMeasurement(): Measurement | null {
    return this.measurement
  }

  // Not gated on any sync option, unlike the crosshair: a measurement is made deliberately and
  // read across the wall, and every pane on its instrument shows it. Synchronous -- a drag
  // updates it once per mousemove, and each pane only moves the two points of one overlay.
  setMeasurement(measurement: Measurement | null): void {
    if (measurement === null && this.measurement === null) return
    this.measurement = measurement
    for (const pane of this.panes.values()) pane.showMeasurement(measurement)
  }

  // --- Click to scroll -------------------------------------------------------------------

  // Coalesced to one rAF per animation frame, same as broadcastCrosshair: a rapid run of
  // calls collapses to the latest target instead of seeking every pane once per call. `point`
  // (not a bare timestamp) so a reload can restore the crosshair afterwards -- see seekPane.
  broadcastSeek(sourceId: string, point: CrosshairPoint, fraction: number): void {
    // Auto sync owns the time axis while it is on -- see SyncOptions.auto. Checked before
    // `time` so that turning auto on disables click-to-scroll whatever that switch says,
    // rather than leaving the two fighting over the same panes.
    if (this.options.auto) {
      console.debug('[sync] seek skipped: auto time sync owns the time axis')
      return
    }
    if (!this.options.time) {
      console.debug('[sync] seek skipped: time sync is off')
      return
    }
    if (this.seekRaf !== 0) cancelAnimationFrame(this.seekRaf)
    // Taken now, while the source is certainly registered: even the degraded path below, for a
    // source torn down before the frame, must restate the click on each target's clock.
    const sourceClock = this.clockOf(sourceId)
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
        this.seekPane(chart, pane, point, fraction, sourceChart, sourcePeriodMs, sourceClock)
      }
    })
  }

  private seekPane(
    chart: Chart,
    pane: SyncPane,
    point: CrosshairPoint,
    fraction: number,
    sourceChart: Nullable<Chart>,
    sourcePeriodMs: number | null,
    sourceClock: PaneClock | null
  ): void {
    const dataList = chart.getDataList()
    if (dataList.length === 0) {
      console.debug('[sync] seekPane skipped: no data loaded yet', { pane: pane.id })
      return
    }

    // Cross-timeframe positioning (centre / align-span / anchor-near-left -- see
    // resolveSeekTarget) needs the source's own chart and period; without them (source
    // unregistered) this degrades to reproducing the click's own on-screen fraction. Either way
    // the instant is restated on this pane's clock first (SyncPane.getClock).
    const toTarget = (timestamp: number): number => restateTimestamp(timestamp, sourceClock, pane)
    const target =
      sourceChart && sourcePeriodMs !== null
        ? resolveSeekTarget(chart, sourceChart, point, sourcePeriodMs, pane.getPeriodMs(), fraction, toTarget)
        : { timestamp: toTarget(point.timestamp), fraction, crosshairTimestamp: toTarget(point.timestamp) }
    // Same price, wherever resolveSeekTarget decided to mark the crosshair -- the pane's
    // showCrosshair (applyCrosshairAt) already re-derives the on-screen position on THIS
    // pane's own scale from the raw value.
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
      pane.showCrosshair(crosshairTarget)
      return
    }

    const oldest = dataList[0].timestamp
    const newest = dataList[dataList.length - 1].timestamp

    // Inside this pane's own loaded history -- a direct seek reaches it exactly, no fetch.
    if (target.timestamp >= oldest && target.timestamp <= newest) {
      console.debug('[sync] seekPane: direct seek (within loaded history)', { pane: pane.id, target })
      seekToTimestamp(chart, target.timestamp, target.fraction, SEEK_ANIMATION_MS)
      pane.showCrosshair(crosshairTarget)
      return
    }

    // Outside the loaded range in either direction -- hand the target to the pane, which
    // reloads its data anchored on it instead of trying to scroll/page there. seekToTimestamp
    // for the actual on-screen placement, and re-applying the crosshair, both happen inside
    // that reload once the target is loaded (resetData() wipes any crosshair this pane had).
    // Not every such target IS reachable, though: past the live edge there is nothing to
    // fetch, and only the pane can tell that from a tail merely parked in the past -- see
    // resolveSeekReach (src/sync/seek.ts).
    console.debug('[sync] seekPane: handing the target to the pane', { pane: pane.id, target })
    pane.seekTo(target.timestamp, target.fraction, crosshairTarget)
  }

  // --- Auto time sync (pan) --------------------------------------------------------------

  // The source pane's midpoint moved: bring every other pane's midpoint to the same instant.
  // Called by ChartPane from klinecharts' onVisibleRangeChange, but ONLY while a real
  // pointer/wheel gesture is driving that pane -- see ChartPane's `panGesture`. That, plus
  // `dispatchingPan`, is what keeps a wall of N panes from echoing one pan around itself.
  //
  // Coalesced to one rAF, like the other two broadcasts: a drag fires a range change per
  // frame and there is no value in dispatching more often than the display refreshes.
  broadcastPan(sourceId: string, timestamp: number): void {
    if (!this.options.auto) return
    if (this.dispatchingPan) return
    this.pendingPan = { sourceId, timestamp, clock: this.clockOf(sourceId) }
    if (this.panRaf !== 0) return
    this.panRaf = requestAnimationFrame(() => {
      this.panRaf = 0
      const pending = this.pendingPan
      this.pendingPan = null
      if (!pending) return
      this.dispatchPan(pending.sourceId, pending.timestamp, pending.clock)
    })
  }

  // Aligns the wall to `sourceId`'s current view without waiting for a pan. What ChartPro
  // calls the moment auto sync is switched on: the panes are wherever their own history left
  // them, and a mode called "sync" that changes nothing until the next drag would look broken.
  alignTo(sourceId: string): void {
    if (!this.options.auto) return
    const source = this.panes.get(sourceId)
    const chart = source?.getChart()
    if (!chart) return
    const timestamp = visibleMidpointTimestamp(chart)
    if (timestamp === null) return
    this.dispatchPan(sourceId, timestamp, source?.getClock() ?? null)
  }

  private dispatchPan(sourceId: string, timestamp: number, clock: PaneClock | null): void {
    this.dispatchingPan = true
    try {
      for (const [id, pane] of this.panes) {
        if (id === sourceId) continue
        const chart = pane.getChart()
        if (!chart) continue
        this.panPane(chart, pane, restateTimestamp(timestamp, clock, pane))
      }
    } finally {
      this.dispatchingPan = false
    }
  }

  private panPane(chart: Chart, pane: SyncPane, timestamp: number): void {
    const dataList = chart.getDataList()
    if (dataList.length === 0) return

    // Reachable by scrolling: this pane already holds a bar on each side of the target, so
    // seekToTimestamp lands on it exactly with no fetch. Also cancels any reload this pane had
    // pending -- a pan that wanders out of the loaded range and back again should end up
    // scrolled, not reloaded a beat later around a target it has since left.
    if (timestamp >= dataList[0].timestamp && timestamp <= dataList[dataList.length - 1].timestamp) {
      this.cancelPanReload(pane.id)
      seekToTimestamp(chart, timestamp, PAN_FRACTION, SEEK_ANIMATION_MS)
      return
    }

    // Past either end of what this pane has loaded -- it can only get there by reloading
    // around the target, which is a round trip, so it waits for the pan to settle first. The
    // pane stays where it is until then; it does not creep toward the edge in the meantime,
    // which would be motion that never arrives anywhere.
    this.schedulePanReload(pane, timestamp)
  }

  private schedulePanReload(pane: SyncPane, timestamp: number): void {
    const existing = this.panReloads.get(pane.id)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      const pending = this.panReloads.get(pane.id)
      this.panReloads.delete(pane.id)
      // Re-read the pane from the registry rather than trusting the captured reference: a
      // layout shrink between scheduling and firing tears its chart down, and reloading a
      // pane that is no longer on the wall would fetch a page nothing will ever draw.
      if (!pending || !this.panes.has(pane.id) || !pane.getChart()) return
      pane.seekTo(pending.timestamp, PAN_FRACTION, null)
    }, PAN_RELOAD_DEBOUNCE_MS)
    this.panReloads.set(pane.id, { timer, timestamp })
  }

  private cancelPanReload(id: string): void {
    const pending = this.panReloads.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.panReloads.delete(id)
  }

  private cancelPan(): void {
    if (this.panRaf !== 0) {
      cancelAnimationFrame(this.panRaf)
      this.panRaf = 0
    }
    this.pendingPan = null
    for (const { timer } of this.panReloads.values()) clearTimeout(timer)
    this.panReloads.clear()
  }

  private clockOf(id: string): PaneClock | null {
    return this.panes.get(id)?.getClock() ?? null
  }

  dispose(): void {
    if (this.crosshairRaf !== 0) cancelAnimationFrame(this.crosshairRaf)
    if (this.seekRaf !== 0) cancelAnimationFrame(this.seekRaf)
    this.cancelPan()
    this.measurement = null
    this.panes.clear()
  }
}

// A source timestamp on `pane`'s own axis. A source whose clock is unknown (it left the wall
// before its broadcast was dispatched) is passed through as it came, which is what the bus did
// before panes had clocks.
function restateTimestamp(timestamp: number, from: PaneClock | null, pane: SyncPane): number {
  return from ? translateTimestamp(timestamp, from, pane.getClock()) : timestamp
}

function restatePoint(point: CrosshairPoint, from: PaneClock | null, pane: SyncPane): CrosshairPoint {
  const timestamp = restateTimestamp(point.timestamp, from, pane)
  return timestamp === point.timestamp ? point : { ...point, timestamp }
}
