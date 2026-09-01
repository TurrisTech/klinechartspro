<script lang="ts">
  import { onMount } from 'svelte'
  import {
    dispose,
    init,
    utils,
    type Chart,
    type DataLoader,
    type DeepPartial,
    type FormatDateParams,
    type Indicator,
    type IndicatorTooltipData,
    type KLineData,
    type Nullable,
    type OverlayCreate,
    type OverlayMode,
    type Period as ChartPeriod,
    type Styles,
    type SymbolInfo as ChartSymbolInfo,
    type TooltipFeatureStyle
  } from 'klinecharts'
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle'
  import ChevronsRightIcon from '@lucide/svelte/icons/chevrons-right'

  import i18n from './i18n'

  import type { PaneViewState, PaneYAxisRange, Period, SymbolInfo } from './types'
  import { getOptions } from './config/settings'
  import type { PaneApi, PaneState } from './state/wall.svelte'
  import { clone, setByPath } from './utils/object'
  import { periodDurationMs } from './utils/period'
  import type { SyncBus } from './sync/bus'
  import { applyCrosshairAt, crosshairPoint, type CrosshairPoint } from './sync/crosshair'
  import {
    isTimestampVisible,
    LIVE_EDGE_FRACTION,
    resolveSeekReach,
    seekToTimestamp,
    timestampFraction,
    visibleMidpointTimestamp
  } from './sync/seek'

  type IndicatorFeatureClick = {
    paneId: string
    feature: TooltipFeatureStyle
    indicator: Indicator
  }
  type IndicatorSettingsPayload = {
    paneId: string
    chartPaneId: string
    name: string
    calcParams: unknown[]
  }

  let {
    pane,
    active,
    theme,
    styles,
    locale,
    timezone,
    watermark,
    periods,
    bus,
    onActivate,
    onIndicatorSettings,
    onStateChange
  }: {
    pane: PaneState
    active: boolean
    theme: string
    styles: DeepPartial<Styles>
    locale: string
    timezone: string
    watermark: string | Node
    periods: Period[]
    bus: SyncBus
    onActivate: (paneId: string) => void
    onIndicatorSettings: (payload: IndicatorSettingsPayload) => void
    onStateChange: (paneId: string) => void
  } = $props()

  let paneElement = $state<HTMLDivElement>()
  let widgetElement: HTMLDivElement
  let widget: Nullable<Chart> = null
  let priceUnitElement: HTMLElement | null = null
  let mounted = $state(false)
  let defaultStyles: Styles | null = null

  // Set synchronously by an overlay's own onClick/onPressedMoveStart (below) when a click
  // selects or starts dragging an EXISTING drawing -- klinecharts processes the whole click
  // (candle figure hit-test, then every overlay's hit-test) inside its internal mouseup
  // handler, which always completes before the browser's native 'click' event we listen for
  // below fires. So by the time our click handler runs, this flag already reflects whether
  // the same click also hit a drawing; read-and-clear there.
  let overlayInteracted = false

  // True while the pointer gesture in flight is the one that SELECTED this pane -- set in the
  // root's pointerdown capture handler (below), which runs before any listener on the chart's
  // own DOM because it is an ancestor's capture-phase handler. On a wall, the click that moves
  // the selection to another pane is a selection gesture and nothing more: it must not also
  // seek every other pane to whatever instant it happened to land on. `active` is read there
  // rather than here because by the time the native 'click' fires this pane is already the
  // active one -- onActivate has run. Assigned unconditionally on every pointerdown, so it can
  // never go stale across a gesture that produces no click (a drag, a pointer released
  // elsewhere, a click swallowed by one of the other guards).
  let selectingPointerDown = false

  // Transient name -> klinecharts chartPaneId map for this pane's sub-indicators. Meaningless
  // once this chart is disposed, unlike `pane.subIndicatorNames` (the durable name list),
  // which is why this stays local component state rather than living on PaneState.
  let subIndicatorMap = $state<Record<string, string>>({})

  const settingOptions = $derived(getOptions(locale))

  function createIndicator(
    indicatorName: string,
    isStack?: boolean,
    chartPaneId?: string
  ): Nullable<string> {
    if (!widget) return null
    // Persisted parameters are applied AT CREATION rather than overridden afterwards: an
    // override is a second calculation, and between the two the pane draws the template
    // default -- an MA(50) restored as MA(5) for a frame, and a server indicator fetching a
    // window for params nobody asked for.
    const restoredParams = pane.indicatorParams[indicatorName]
    const indicatorId = widget.createIndicator({
      name: indicatorName,
      paneId: chartPaneId,
      ...(restoredParams ? { calcParams: [...restoredParams] } : {}),
      createTooltipDataSource: ({ indicator }) => {
        const defaultFeatures = widget?.getStyles().indicator.tooltip.features ?? []
        const icons = indicator.visible
          ? defaultFeatures.slice(1, 4)
          : [defaultFeatures[0], ...defaultFeatures.slice(2, 4)].filter(Boolean)
        return { features: icons } as IndicatorTooltipData
      }
    }, isStack)
    if (!indicatorId) return null
    const createdPaneId = widget.getIndicators({ id: indicatorId })[0]?.paneId ?? null
    if (createdPaneId) applyYAxisSettings(createdPaneId)
    return createdPaneId
  }

  // The history window handed to the datafeed for one page of `count` bars ending at
  // `toTimestamp`. Only a bound: the datafeed/server assigns bars to candles and clips the
  // range itself, so nothing here aligns `to` to a calendar edge -- FX candles do not open at
  // local midnight (they open 17:00 America/New_York; a week opens Sunday 17:00), and flooring
  // to one would drop a bar at every page boundary for viewers east of the market. `from` is a
  // generous nominal reach; the server keeps the last `count`.
  function adjustFromTo(currentPeriod: Period, toTimestamp: number, count: number) {
    const to = toTimestamp
    const from = to - count * periodDurationMs(currentPeriod)
    return [from, to] as const
  }

  // The bracketing window a seek reload (see seekTo below) hands the datafeed: nominal reach
  // worth `count` bars on EACH side of `target`, unlike adjustFromTo's "ending at" window --
  // the target must land inside the loaded data regardless of what on-screen fraction the
  // source pane clicked at (src/sync/bus.ts's seekPane picks whichever pane this fires in).
  const SEEK_WINDOW_BARS = 500
  function seekWindow(currentPeriod: Period, target: number, count: number) {
    const span = count * periodDurationMs(currentPeriod)
    // A target in the future has no bars to bracket -- `target - span` can itself be later
    // than the last close, and the window then comes back EMPTY, leaving the pane with no
    // data at all. Bracket the present instead, so the reload still returns the live tail;
    // where the view then lands is the loader's business (see the 'init' branch, which
    // positions a past-the-tail seek at the live edge rather than scrolling into the blank).
    const anchor = Math.min(target, Date.now())
    return [anchor - span, anchor + span] as const
  }

  // One page of newer-in-time bars once a seek has parked this pane's data mid-history --
  // see chartDataLoader.getBars' 'backward' branch. Matches adjustFromTo's own page size.
  const BACKWARD_PAGE_BARS = 500

  // Daily and coarser candles ARRIVE dated by their market session -- the server states
  // them as canonical dates (00:00 of the session on the MARKET'S OWN calendar), not as
  // the opens the store keys them under, so there is nothing to shift here any more.
  // What remains is which clock to READ them on: the instrument's own market timezone,
  // regardless of the display timezone, because a session date is the market's calendar
  // and not the viewer's. For an instrument stating no zone that is New York (FX); a
  // crypto instrument states UTC and its dates read on UTC midnight.
  const sessionDateFormat = $derived(
    new Intl.DateTimeFormat('en', {
      timeZone: pane.symbol?.timezone ?? 'America/New_York',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  )

  // The clock the pane DISPLAYS on: the instrument's own market timezone when it states
  // one (a Coinbase pane reads UTC -- its bars open on the UTC grid, and any other zone
  // splits its days mid-bar), else the app-level timezone prop (New York, the market
  // clock of every FX instrument here).
  const displayTimezone = $derived(pane.symbol?.timezone ?? timezone)

  function formatDate({ dateTimeFormat, timestamp, type }: FormatDateParams) {
    if (pane.period.timespan === 'minute') {
      return utils.formatDate(dateTimeFormat, timestamp, type === 'xAxis'
        ? 'HH:mm' : 'YYYY-MM-DD HH:mm')
    }
    if (pane.period.timespan === 'hour') {
      return utils.formatDate(dateTimeFormat, timestamp, type === 'xAxis'
        ? 'MM-DD HH:mm' : 'YYYY-MM-DD HH:mm')
    }
    if (pane.period.timespan === 'month') {
      return utils.formatDate(sessionDateFormat, timestamp, type === 'xAxis'
        ? 'YYYY-MM' : 'YYYY-MM-DD')
    }
    if (pane.period.timespan === 'year') {
      return utils.formatDate(sessionDateFormat, timestamp, type === 'xAxis'
        ? 'YYYY' : 'YYYY-MM-DD')
    }
    return utils.formatDate(sessionDateFormat, timestamp, 'YYYY-MM-DD')
  }

  function applyIndicatorIcons() {
    if (!widget) return
    const color = theme === 'dark' ? '#a3a3a3' : '#737373'
    const icon = (id: string, glyph: string, marginLeft = 6) => ({
      id,
      position: 'middle' as const,
      marginLeft,
      marginTop: 3,
      marginRight: 0,
      marginBottom: 0,
      paddingLeft: 0,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      type: 'icon_font' as const,
      content: { code: glyph, family: 'icomoon' },
      borderRadius: 0,
      size: 14,
      color,
      activeColor: color,
      backgroundColor: 'transparent',
      activeBackgroundColor: 'color-mix(in srgb, currentColor 12%, transparent)'
    })
    widget.setStyles({
      indicator: {
        tooltip: {
          features: [
            icon('visible', '', 8),
            icon('invisible', '', 8),
            icon('setting', ''),
            icon('close', '')
          ]
        }
      }
    })
  }

  const toChartSymbol = (value: SymbolInfo): ChartSymbolInfo => ({
    ...value,
    pricePrecision: value.pricePrecision ?? 2,
    volumePrecision: value.volumePrecision ?? 0
  })

  const toChartPeriod = (value: Period): ChartPeriod => ({
    span: value.multiplier,
    type: value.timespan as ChartPeriod['type']
  })

  const fromChartPeriod = (value: ChartPeriod): Period => {
    const configured = periods.find((item) =>
      item.multiplier === value.span && item.timespan === value.type
    )
    return {
      multiplier: value.span,
      timespan: value.type,
      text: configured?.text ?? `${value.span} ${value.type}`
    }
  }

  // Set by seekTo below, consumed the moment chartDataLoader.getBars next sees `type ===
  // 'init'`. Distinguishes a click-driven reload from every other init (initial mount,
  // symbol/period change): only a seek anchors on ITS OWN target instead of "now", and only
  // a seek opens backward paging (see the 'backward' branch and the init branch's
  // `more.backward`).
  let pendingSeek: {
    timestamp: number
    fraction: number
    crosshair: CrosshairPoint | null
    // True only for the seek restoreView() opens with, which is the one seek whose target
    // came from storage rather than from something the user just clicked -- and so the one
    // that can name an instant this instrument no longer has bars for.
    restore?: boolean
  } | null = null
  // Bumped on every 'init' load this loader starts, so a load whose result lands after a
  // NEWER 'init' has already started (two seeks fired in quick succession, or a seek racing
  // a symbol/period change) can tell it was superseded and drop its result instead of
  // clobbering the chart with stale data. klinecharts' own single-flight `_loading` guard
  // does not cover this: resetData() unconditionally clears that flag before starting the
  // new load, leaving the old load's promise free to still resolve later.
  let loadGeneration = 0
  // True while this pane's loaded data is parked in the past by a seek, and so cannot take
  // a live bar onto its tail (see subscribeBar). Set by the seek reload itself, cleared as
  // soon as the pane is back at the present -- either because backward paging ran dry, or
  // because a live bar turns out to sit right at the tail after all. Nothing else parks a
  // pane: a plain init loads a window ending at `now`.
  //
  // $state, not a plain local: the jump-to-live control's visibility is derived from it. A
  // parked pane is never showing the live bar, however it happens to be scrolled -- the newest
  // bar it HOLDS is not the newest bar there is.
  let parkedInHistory = $state(false)

  // Set by jumpToLive below and consumed by the very next 'init' load, exactly as pendingSeek
  // is -- the two are mutually exclusive (a seek anchors on its own target, this one on now)
  // and jumpToLive clears any pending seek before setting this. `broadcast` separates the two
  // callers: a user who pressed the control takes the wall with them (see jumpToLive), whereas
  // a pane merely restoring the view it was saved in has moved nothing and must say nothing --
  // a wall of panes each announcing its own restored position would shove them all onto
  // whichever one finished loading last.
  let pendingLive: { broadcast: boolean } | null = null
  // A manually-scaled price axis, waiting for the init load it was restored alongside -- see
  // applyYAxisRange, and restoreView for why it cannot simply be applied at mount.
  let pendingYAxisRange: PaneYAxisRange | null = null

  // Requested by the sync bus (src/sync/bus.ts) when a click lands outside this pane's own
  // loaded data. Reloads the dataset anchored on `timestamp` instead of scrolling/paging
  // toward it, so the target is reached in one round trip at any distance -- see
  // chartDataLoader's 'init' branch, which reads `pendingSeek` the moment klinecharts asks
  // for the reset dataset, and re-applies `crosshair` once that reload lands. `crosshair` is
  // not necessarily at `timestamp`: resolveSeekTarget's span-centring case reloads/scrolls to
  // a span's midpoint but still marks the instant that was actually clicked.
  function seekTo(timestamp: number, fraction: number, crosshair: CrosshairPoint | null): void {
    if (!widget) return
    // A target past the live edge is not somewhere this pane can go -- see resolveSeekReach
    // for the whole rule and why chasing it puts the newest bar two bars from the LEFT edge.
    // No reload, since there is nothing there to fetch: the current bar keeps the position it
    // already had if that is one it can be left in, and otherwise comes back to the default
    // position -- which is also how a pane already sitting jammed at the left gets out of it.
    // The crosshair is still applied: it marks the instant the wall aligned on, wherever on
    // this pane's scale that falls, exactly as the hover sync does.
    const newest = widget.getDataList().at(-1)?.timestamp
    const reach = resolveSeekReach(
      timestamp,
      newest,
      parkedInHistory,
      newest === undefined ? null : timestampFraction(widget, newest)
    )
    if (reach !== 'reload') {
      console.debug('[sync] seek target is past the live edge', { pane: pane.id, reach, timestamp })
      if (reach === 'live-edge') positionAtLive(widget)
      if (crosshair) applyCrosshairAt(widget, crosshair)
      return
    }
    pendingLive = null
    pendingSeek = { timestamp, fraction, crosshair }
    widget.resetData()
  }

  // --- Jump to live ----------------------------------------------------------------------

  // Whether the newest bar there is, is on screen. False in two different ways, both of which
  // the control has to offer to fix: this pane is scrolled away from a tail it does hold, or
  // it is parked in history and does not hold that tail at all. A pane with no data yet is
  // reported as `true` -- there is nothing to jump to, so nothing to offer.
  let atLive = $state(true)
  // The chart's own gutters, so the control sits inside the CANDLE pane's price area rather
  // than on top of the x-axis labels, the y-axis scale, or -- once the pane carries indicator
  // sub-panes -- down in the lowest sub-pane, which is what insetting by the x-axis alone
  // gave. Read from klinecharts rather than guessed: the y-axis width is computed from the
  // tick text it has to hold (so it moves with the price precision and the theme's font), and
  // everything below the candles is a layout the user can add to and drag.
  let priceAreaBottom = $state(0)
  let yAxisWidth = $state(0)

  function positionAtLive(chart: Chart): void {
    const last = chart.getDataList().at(-1)?.timestamp
    if (last === undefined) return
    seekToTimestamp(chart, last, LIVE_EDGE_FRACTION, 0)
  }

  function jumpToLive(): void {
    if (!widget) return
    // Parked panes hold no tail to scroll to: the data itself has to be replaced with a window
    // ending at `now`, and only then positioned. Anything else -- a pane merely scrolled off
    // to the left -- already holds the bar and only needs the scroll.
    if (parkedInHistory || widget.getDataList().length === 0) {
      pendingSeek = null
      pendingLive = { broadcast: true }
      widget.resetData()
      return
    }
    positionAtLive(widget)
    // A pane the user drove to the present should take the wall with it when auto sync is on;
    // the bus drops this when it is off. Explicit rather than relying on the gesture tracking
    // below, which only ever sees pointer and wheel input on the chart itself.
    broadcastPan()
    refreshViewState()
  }

  // --- Auto time sync (pan) source ---------------------------------------------------------

  // A pan is only broadcast while a real gesture on THIS pane is driving it. Every other cause
  // of a visible-range change -- the sync bus scrolling this pane to follow another, a page of
  // history arriving, a live bar, a resize -- must stay silent, or a wall of panes echoes one
  // drag around itself indefinitely. The bus has its own re-entrancy guard; this is the half
  // that makes the source of a movement unambiguous rather than merely non-recursive.
  const WHEEL_TAIL_MS = 250
  let pointerDriving = false
  let wheelDrivingUntil = 0
  const isDriving = () => pointerDriving || Date.now() < wheelDrivingUntil

  function broadcastPan(): void {
    if (!widget) return
    const midpoint = visibleMidpointTimestamp(widget)
    if (midpoint !== null) bus.broadcastPan(pane.id, midpoint)
  }

  // Recomputes what the jump-to-live control shows, from whatever the chart looks like now.
  function refreshViewState(): void {
    if (!widget) return
    const last = widget.getDataList().at(-1)?.timestamp
    atLive = last === undefined || (!parkedInHistory && isTimestampVisible(widget, last))
    // Everything below the candle pane -- its indicator sub-panes, their separators and the
    // x-axis -- as one distance, since pane boundings are measured from the chart container's
    // own top. The x-axis alone is the fallback for the case where either read comes back
    // null, which is the pre-sub-pane answer and right whenever there are none.
    const chartHeight = widget.getSize()?.height ?? 0
    const candlePane = widget.getSize('candle_pane')
    priceAreaBottom =
      candlePane !== null && chartHeight > 0
        ? Math.max(chartHeight - (candlePane.top + candlePane.height), 0)
        : (widget.getSize('x_axis_pane')?.height ?? 0)
    yAxisWidth = widget.getSize('candle_pane', 'yAxis')?.width ?? 0
  }

  // onVisibleRangeChange fires once per animation frame during a drag, and again for every
  // data change, so both of its consumers are coalesced onto one rAF rather than run per
  // dispatch: each does pixel<->timestamp conversions that are pointless to repeat within a
  // frame. `panPending` is latched at DISPATCH time, not read inside the callback -- a drag
  // that ends between the two would otherwise lose its final frame, leaving the wall one pan
  // short of where the user let go.
  let viewRaf = 0
  let panPending = false
  function scheduleViewTick(): void {
    if (viewRaf !== 0) return
    viewRaf = requestAnimationFrame(() => {
      viewRaf = 0
      const pan = panPending
      panPending = false
      refreshViewState()
      if (pan) broadcastPan()
      // Every cause of a range change is worth persisting, not just a gesture on this pane:
      // a wall following an auto-sync pan, a jump to live, a seek. Debounced, so the frames
      // of one drag collapse into a single capture.
      scheduleViewCapture()
    })
  }

  // --- Durable view state -------------------------------------------------------------------
  //
  // What a reload would otherwise throw away: the time axis's zoom and position, whether the
  // pane was following the live candle, and the price axis. Captured onto PaneState (which
  // outlives this component) and handed back by the next mount -- a layout grow, a workspace
  // switch, or the caller restoring a persisted wall.

  // The anchor is read at, and put back at, the horizontal MIDPOINT -- the same point auto
  // time sync carries between panes, for the same reason: it is the one position a pane can
  // reproduce whatever its width, bar count or zoom (see visibleMidpointTimestamp).
  const VIEW_ANCHOR_FRACTION = 0.5
  // A capture is worth one workspace write, and onVisibleRangeChange fires once per animation
  // frame for the whole of a drag -- so captures wait for the gesture to stop rather than
  // riding the same rAF tick refreshViewState does.
  const VIEW_CAPTURE_DEBOUNCE_MS = 400

  // klinecharts' y-axis keeps a manual range (set by dragging the axis) as an internal
  // override, and exposes neither the flag nor the setter on its public `Axis` type -- only
  // `getRange()`, which answers whatever range is in force, auto or not. Reading the flag is
  // what separates "the user scaled this axis" from "the axis is following the data", and
  // writing the range is the only way to put a scale back. Both are guarded by a typeof
  // check: a klinecharts that renamed them degrades to an auto-scaled axis, which is the
  // behaviour before any of this existed, rather than throwing on every pane mount.
  type ManualYAxis = {
    getRange: () => PaneYAxisRange
    getAutoCalcTickFlag?: () => boolean
    setRange?: (range: PaneYAxisRange) => void
  }

  function candleYAxis(): ManualYAxis | null {
    const axes = widget?.getYAxes({ paneId: 'candle_pane' }) ?? []
    return (axes[0] as ManualYAxis | undefined) ?? null
  }

  /** The candle pane's price range, but only when the user actually set it. */
  function manualYAxisRange(): PaneYAxisRange | undefined {
    const axis = candleYAxis()
    if (!axis || typeof axis.getAutoCalcTickFlag !== 'function') return undefined
    if (axis.getAutoCalcTickFlag()) return undefined
    const range = axis.getRange()
    const values = Object.values(range) as unknown[]
    if (values.length === 0 || !values.every((value) => typeof value === 'number' && Number.isFinite(value))) {
      return undefined
    }
    return { ...range }
  }

  function applyYAxisRange(range: PaneYAxisRange): void {
    const axis = candleYAxis()
    if (!axis || typeof axis.setRange !== 'function') return
    axis.setRange({ ...range })
    // setRange only writes the range; nothing repaints on its own. resize() is the public
    // call that re-lays-out and rebuilds ticks WITHOUT resetting the manual flag -- which
    // overrideYAxis, the other repaint trigger to hand, always does (see applyYAxisSettings).
    widget?.resize()
  }

  function captureView(): void {
    if (!widget) return
    const anchor = visibleMidpointTimestamp(widget)
    const range = manualYAxisRange()
    const view: PaneViewState = {
      barSpace: widget.getBarSpace().bar,
      live: atLive,
      ...(anchor !== null ? { anchor, fraction: VIEW_ANCHOR_FRACTION } : {}),
      yAxis: {
        type: pane.yAxisType,
        reverse: pane.yAxisReverse,
        ...(range ? { range } : {})
      }
    }
    // Compared before writing: a workspace write is a localStorage write and a debounced PUT,
    // and plenty of things dispatch a visible-range change without moving the view (a live
    // bar arriving at a pane already at the tail, a resize that settles where it started).
    if (JSON.stringify(pane.view) === JSON.stringify(view)) return
    pane.view = view
    onStateChange(pane.id)
  }

  let captureTimer: ReturnType<typeof setTimeout> | null = null
  function scheduleViewCapture(): void {
    if (captureTimer) clearTimeout(captureTimer)
    captureTimer = setTimeout(() => {
      captureTimer = null
      captureView()
    }, VIEW_CAPTURE_DEBOUNCE_MS)
  }

  // Called once, before the data loader is installed, so the first 'init' load is already the
  // right one -- a pane parked in history reloads AROUND its anchor rather than loading the
  // present and then jumping away from it.
  function restoreView(): void {
    const view = pane.view
    if (!widget || !view) return
    // Out-of-range values are ignored by klinecharts itself (setBarSpace clamps to its own
    // limits by returning early), so this only has to rule out the values that would be
    // meaningless rather than merely large.
    if (Number.isFinite(view.barSpace) && view.barSpace > 0) widget.setBarSpace(view.barSpace)
    if (!view.live && typeof view.anchor === 'number') {
      // Exactly what a click-to-scroll seek sets, minus the crosshair: nothing was clicked.
      // The loader's own 'init' branch then brackets the anchor, opens backward paging and
      // marks the pane parked, all of which a restored history position wants.
      pendingSeek = {
        timestamp: view.anchor,
        fraction: view.fraction ?? VIEW_ANCHOR_FRACTION,
        crosshair: null,
        restore: true
      }
    } else {
      // Following the live candle means following it as it stands NOW, not as it stood when
      // the view was saved: a tab reopened an hour later must come back to the market, not to
      // an hour-old anchor that happens to have been at the edge.
      pendingLive = { broadcast: false }
    }
    pendingYAxisRange = view.yAxis?.range ?? null
  }

  const chartDataLoader: DataLoader = {
    async getBars({ type, timestamp, symbol: chartSymbol, period: chartPeriod, callback }) {
      const currentPeriod = fromChartPeriod(chartPeriod)

      if (type === 'backward') {
        // The newer-in-time page after a seek landed mid-history (see the 'init' branch
        // below). A plain (non-seek) load never opens this direction, so klinecharts never
        // asks for it outside a seek.
        if (timestamp === null) {
          callback([], { backward: false })
          return
        }
        pane.loading = true
        const from = timestamp + 1
        const to = timestamp + BACKWARD_PAGE_BARS * periodDurationMs(currentPeriod)
        try {
          const data = await pane.datafeed.getHistoryKLineData(
            chartSymbol as SymbolInfo,
            currentPeriod,
            from,
            to,
            'newer'
          )
          // Belt-and-braces against the server ever answering with a bar at or before the
          // seam: _addData's 'backward' branch is a plain concat, so anything <= timestamp
          // here would duplicate or misorder the bar the chart already holds at that edge.
          const fresh = data.filter((bar) => bar.timestamp > timestamp)
          // Nothing newer to page toward means the loaded data has caught up with the
          // server's own latest bar: the pane is at the present again and may take live
          // bars onto its tail.
          if (fresh.length === 0) parkedInHistory = false
          callback(fresh, { backward: fresh.length > 0 })
          scheduleViewTick()
        } finally {
          pane.loading = false
        }
        return
      }

      if (type === 'init') {
        const generation = ++loadGeneration
        const seek = pendingSeek
        pendingSeek = null
        const live = pendingLive
        pendingLive = null
        pane.loading = true
        const [from, to] = seek
          ? seekWindow(currentPeriod, seek.timestamp, SEEK_WINDOW_BARS)
          : adjustFromTo(currentPeriod, Date.now(), 500)
        try {
          const data = await pane.datafeed.getHistoryKLineData(
            chartSymbol as SymbolInfo,
            currentPeriod,
            from,
            to
          )
          if (generation !== loadGeneration) {
            console.debug('[sync] seek reload dropped: superseded by a newer load', { pane: pane.id })
            return
          }
          // A plain init has nothing newer to page toward (backward: false, as before); only
          // a seek reload opens that direction, closed again by the 'backward' branch above
          // once it runs dry. That is also exactly when this pane's data is parked in the
          // past, and a plain init -- mount, symbol change, period change -- is exactly when
          // it is not: the window it just loaded ends at `now`.
          //
          // A seek is the third case: one whose target is newer than anything the reload came
          // back with has caught UP with the present rather than parking short of it, because
          // seekWindow brackets `now` for a future target. Nothing newer to page toward, and
          // live bars belong on this tail -- so it is not parked either.
          const pastLiveEdge =
            seek !== null && data.length > 0 && seek.timestamp > data[data.length - 1].timestamp
          parkedInHistory = Boolean(seek) && !pastLiveEdge
          callback(data, { forward: data.length > 0, backward: parkedInHistory })
          if (seek?.restore && data.length === 0) {
            // The saved anchor no longer has bars around it -- history was trimmed, or the
            // instrument's data moved. Left as it is the pane would sit empty AND offer no way
            // out: the jump-to-live control hides itself when there is no data to jump from.
            // So fall back to what a pane with no saved view does, which is load the present.
            console.warn('[view] saved position has no data; falling back to live', { pane: pane.id })
            pendingLive = { broadcast: false }
            parkedInHistory = false
            setTimeout(() => widget?.resetData(), 0)
            return
          }
          if (seek && data.length > 0 && widget) {
            // Past the live edge there is no `seek.timestamp` on the chart to scroll to, and
            // asking anyway leaves the newest bar jammed two bars from the left with a screen
            // of nothing after it (resolveSeekReach spells that out). Land at the live edge,
            // which is as far forward as this pane goes.
            if (pastLiveEdge) positionAtLive(widget)
            else seekToTimestamp(widget, seek.timestamp, seek.fraction, 0)
            // resetData() cleared this pane's crosshair along with its data (see
            // _clearData in klinecharts) -- without this, the pane lands in the right
            // place but shows no crosshair marking where every other pane just aligned to.
            // An auto-sync pan carries no crosshair (see SyncPane.seekTo): a pan points at
            // nothing, so the pane lands clean instead of marking an arbitrary instant.
            if (seek.crosshair) applyCrosshairAt(widget, seek.crosshair)
          } else if (live && data.length > 0 && widget) {
            // The reload jumpToLive asked for -- or the one a restored live pane opens with --
            // has landed; only now does the tail exist to be positioned. Without this the pane
            // would sit wherever klinecharts' own default offset put it, which is flush right,
            // not the fifth of clear air the control promises.
            positionAtLive(widget)
            if (live.broadcast) broadcastPan()
          }
          // After the positioning, not before: klinecharts rebuilds the y-axis ticks as part
          // of the same layout a scroll triggers, and a range set ahead of that is recomputed
          // away on any pane whose axis is still auto-scaling.
          if (pendingYAxisRange) {
            applyYAxisRange(pendingYAxisRange)
            pendingYAxisRange = null
          }
          scheduleViewTick()
        } finally {
          pane.loading = false
        }
        return
      }

      // type === 'forward'
      pane.loading = true
      const toTimestamp = timestamp ? timestamp - 1 : Date.now()
      const [from, to] = adjustFromTo(currentPeriod, toTimestamp, 500)
      try {
        const data = await pane.datafeed.getHistoryKLineData(
          chartSymbol as SymbolInfo,
          currentPeriod,
          from,
          to
        )
        callback(data, { forward: data.length > 0, backward: false })
      } finally {
        pane.loading = false
      }
    },
    subscribeBar({ symbol: chartSymbol, period: chartPeriod, callback }) {
      const currentPeriod = fromChartPeriod(chartPeriod)
      const periodMs = periodDurationMs(currentPeriod)
      pane.datafeed.subscribe(chartSymbol as SymbolInfo, currentPeriod, (bar: KLineData) => {
        // Once a seek has parked this pane's data in the past, the live stream must not push
        // a bar at "now" onto the tail -- _addData's single-bar path accepts anything newer
        // than the last loaded bar unconditionally, which would strand one candle far to the
        // right with a dead zone in between.
        //
        // Both halves of this test are needed, and the flag is the load-bearing one. A gap
        // wider than one period does NOT mean the pane is parked: the market closes. The bar
        // after Thursday's daily candle opens Sunday 17:00, three periods later; the bar
        // after Friday's last hourly one opens 49 hours later. A gap test alone dropped
        // every one of those -- the whole first session of the week, at every period -- and
        // dropped it silently. The period arithmetic is kept only for the parked case, where
        // it is what lets a pane that has been paged back up to the tail take live bars
        // again without waiting for a backward page to run dry.
        const last = widget?.getDataList().at(-1)?.timestamp
        if (parkedInHistory && last !== undefined && bar.timestamp > last + periodMs) {
          console.debug('[sync] live bar dropped: pane is parked in history', { pane: pane.id })
          return
        }
        parkedInHistory = false
        callback(bar)
        scheduleViewTick()
      })
    },
    unsubscribeBar({ symbol: chartSymbol, period: chartPeriod }) {
      pane.datafeed.unsubscribe(chartSymbol as SymbolInfo, fromChartPeriod(chartPeriod))
    }
  }

  // Parameters of an indicator that is no longer on the pane: dropped rather than kept for a
  // possible re-add, so that ticking a template off and on again gives the default it shows
  // in the picker, and a workspace document doesn't accumulate settings for indicators the
  // user removed months ago.
  function forgetIndicatorParams(name: string): void {
    if (!(name in pane.indicatorParams)) return
    const next = { ...pane.indicatorParams }
    delete next[name]
    pane.indicatorParams = next
  }

  function changeIndicator(name: string, main: boolean, added: boolean) {
    if (main) {
      if (added) {
        createIndicator(name, true, 'candle_pane')
        pane.mainIndicators = [...pane.mainIndicators, name]
      } else {
        widget?.removeIndicator({ paneId: 'candle_pane', name })
        pane.mainIndicators = pane.mainIndicators.filter((item) => item !== name)
        forgetIndicatorParams(name)
      }
      onStateChange(pane.id)
      return
    }

    if (added) {
      const chartPaneId = createIndicator(name)
      if (chartPaneId) {
        subIndicatorMap = { ...subIndicatorMap, [name]: chartPaneId }
        pane.subIndicatorNames = [...pane.subIndicatorNames, name]
      }
    } else if (subIndicatorMap[name]) {
      widget?.removeIndicator({ paneId: subIndicatorMap[name], name })
      const nextMap = { ...subIndicatorMap }
      delete nextMap[name]
      subIndicatorMap = nextMap
      pane.subIndicatorNames = pane.subIndicatorNames.filter((item) => item !== name)
      forgetIndicatorParams(name)
    }
    onStateChange(pane.id)
  }

  // The settings dialog's Confirm, routed through the pane rather than reaching for
  // `api.chart.overrideIndicator` itself, so that the parameters land on PaneState in the same
  // breath as on the chart. Keyed by template NAME, like the picker: a template is on a pane
  // at most once, whichever chart pane klinecharts put it in.
  function setIndicatorParams(chartPaneId: string, name: string, calcParams: unknown[]): void {
    widget?.overrideIndicator({ name, paneId: chartPaneId, calcParams })
    pane.indicatorParams = { ...pane.indicatorParams, [name]: [...calcParams] }
    onStateChange(pane.id)
  }

  function applyYAxisSettings(chartPaneId?: string) {
    if (!widget) return
    const chartPaneIds = chartPaneId
      ? [chartPaneId]
      : ['candle_pane', ...Object.values(subIndicatorMap)]
    for (const id of new Set(chartPaneIds)) {
      widget.overrideYAxis({ paneId: id, name: pane.yAxisType, reverse: pane.yAxisReverse })
    }
  }

  function setStyleValue(key: string, value: unknown): Styles {
    if (key === 'yAxis.type') {
      pane.yAxisType = String(value)
      applyYAxisSettings()
      captureView()
      return widget?.getStyles() as Styles
    }
    if (key === 'yAxis.reverse') {
      pane.yAxisReverse = Boolean(value)
      applyYAxisSettings()
      captureView()
      return widget?.getStyles() as Styles
    }
    const patch = {}
    setByPath(patch, key, value)
    widget?.setStyles(patch)
    return widget?.getStyles() as Styles
  }

  function restoreStyles(): Styles {
    if (defaultStyles) {
      const patch = {}
      for (const option of settingOptions) {
        if (option.key.startsWith('yAxis.')) continue
        setByPath(patch, option.key, utils.formatValue(defaultStyles, option.key))
      }
      widget?.setStyles(patch)
    }
    pane.yAxisType = 'normal'
    pane.yAxisReverse = false
    applyYAxisSettings()
    captureView()
    return clone(widget?.getStyles() ?? (defaultStyles as Styles))
  }

  function createOverlay(
    name: string,
    drawing: { mode: OverlayMode; lock: boolean; visible: boolean }
  ) {
    widget?.createOverlay({
      groupId: 'drawing_tools',
      name,
      visible: drawing.visible,
      lock: drawing.lock,
      mode: drawing.mode,
      // A click that selects or starts dragging an existing drawing must not also seek. The
      // `currentStep !== -1` guard in the click handler below covers placing a new drawing;
      // this flag covers interacting with one that's already finished -- see
      // `overlayInteracted`'s own comment for the ordering this relies on.
      onClick: () => { overlayInteracted = true },
      onPressedMoveStart: () => { overlayInteracted = true }
    } as OverlayCreate)
  }

  function overrideOverlay(patch: Partial<OverlayCreate>) {
    widget?.overrideOverlay(patch)
  }

  function removeDrawings() {
    widget?.removeOverlay({ groupId: 'drawing_tools' })
  }

  function screenshot(background: string): string {
    return widget?.getConvertPictureUrl(true, 'jpeg', background) ?? ''
  }

  $effect(() => {
    if (!mounted) return
    widget?.setSymbol(toChartSymbol(pane.symbol))
  })

  $effect(() => {
    if (!mounted) return
    widget?.setPeriod(toChartPeriod(pane.period))
  })

  $effect(() => {
    if (!mounted || !widget) return
    widget.setStyles(theme)
    applyIndicatorIcons()
  })

  $effect(() => {
    if (!mounted || !widget) return
    widget.setStyles(styles)
  })

  $effect(() => {
    if (!mounted || !widget) return
    widget.setLocale(locale)
    widget.setTimezone(displayTimezone)
  })

  $effect(() => {
    if (!mounted || !widget || !priceUnitElement) return
    priceUnitElement.textContent = pane.symbol.priceCurrency?.toLocaleUpperCase() ?? ''
    priceUnitElement.style.display = pane.symbol.priceCurrency ? 'flex' : 'none'
  })

  onMount(() => {
    const chart = init(widgetElement, { formatter: { formatDate } })
    if (!chart) throw new Error('Unable to initialize KLineChart')
    widget = chart

    const watermarkContainer = widget.getDom('candle_pane', 'main')
    if (watermarkContainer) {
      const element = document.createElement('div')
      element.className = 'klinecharts-pro-watermark'
      if (typeof watermark === 'string') element.innerHTML = watermark.trim()
      // A DOM Node has exactly one parent -- with N panes sharing the same watermark Node,
      // each pane must clone it rather than move the caller's original.
      else element.appendChild((watermark as Node).cloneNode(true))
      watermarkContainer.appendChild(element)
    }

    priceUnitElement = document.createElement('span')
    priceUnitElement.className = 'klinecharts-pro-price-unit'
    widget.getDom('candle_pane', 'yAxis')?.appendChild(priceUnitElement)

    for (const name of pane.mainIndicators) createIndicator(name, true, 'candle_pane')
    const initialSubIndicatorMap: Record<string, string> = {}
    for (const name of pane.subIndicatorNames) {
      const chartPaneId = createIndicator(name, true)
      if (chartPaneId) initialSubIndicatorMap[name] = chartPaneId
    }
    subIndicatorMap = initialSubIndicatorMap
    // createIndicator applies these to each sub-pane it creates; the candle pane has no such
    // moment, so a restored logarithmic or reversed price axis needs saying here.
    applyYAxisSettings('candle_pane')

    // Before the loader, not after: installing it is what triggers the first 'init' load, and
    // restoreView's whole job is to make that first load the right one.
    restoreView()
    widget.setDataLoader(chartDataLoader)
    const onIndicatorFeatureClick = (value?: unknown) => {
      const data = value as IndicatorFeatureClick
      const featureId = data.feature.id
      const indicator = data.indicator
      if (featureId === 'visible' || featureId === 'invisible') {
        widget?.overrideIndicator({
          name: indicator.name,
          paneId: data.paneId,
          visible: featureId === 'visible'
        })
      } else if (featureId === 'setting') {
        onIndicatorSettings({
          paneId: pane.id,
          chartPaneId: data.paneId,
          name: indicator.name,
          calcParams: clone(indicator.calcParams)
        })
      } else if (featureId === 'close') {
        changeIndicator(indicator.name, data.paneId === 'candle_pane', false)
      }
    }
    widget.subscribeAction('onIndicatorTooltipFeatureClick', onIndicatorFeatureClick)

    // Crosshair sync source: onCrosshairChange's payload is the raw {x, y, paneId} mousemove
    // record, not the timestamp/price -- crosshairPoint recovers both via the same
    // coordinate->dataIndex/value path klinecharts itself uses internally. The price is only
    // meaningful (and only extracted) when the hover is over candle_pane itself, not an
    // indicator sub-pane. A sync-driven update on THIS chart (dispatched with
    // notExecuteAction: true by applyCrosshairAt/clearCrosshair on some other pane) never
    // re-enters here -- klinecharts guarantees that action does not re-fire this subscriber --
    // so there's no special-casing needed against echoing our own synced crosshair back out.
    const onCrosshairChange = (value?: unknown) => {
      const cr = value as { x?: number; y?: number; paneId?: string } | undefined
      if (!cr) return
      const point = crosshairPoint(chart, cr)
      if (!point) return
      bus.broadcastCrosshair(pane.id, point)
    }
    widget.subscribeAction('onCrosshairChange', onCrosshairChange)

    // Click-to-scroll source: a native DOM click on candle_pane's own main widget. Any
    // position in the pane -- not just a candle figure -- resolves to a date via
    // `convertFromPixel`, which extrapolates linearly outside the loaded range using this
    // chart's own period.
    //
    // Four guards:
    // - `selectingPointerDown` rules out the click that moved the wall's selection to this
    //   pane. Selecting a pane and pointing at an instant in it are two different intentions,
    //   and a click on an unselected pane is unambiguously the first: the user is reaching for
    //   a pane, not for a date, and having the rest of the wall jump away from where they left
    //   it is a side effect they did not ask for. Once this pane IS the active one the next
    //   click seeks as it always did.
    // - A pan-drag ending on the same element still fires a native 'click', so mousedown/click
    //   positions are compared against a 5px Manhattan-distance threshold, matching
    //   klinecharts' own `ManhattanDistance.CancelClick`.
    // - `overlayInteracted` (set by createOverlay()'s onClick/onPressedMoveStart above) rules
    //   out a click that selected or started dragging an existing drawing. klinecharts
    //   resolves the whole click -- including every overlay's hit-test -- synchronously inside
    //   its own mouseup handling, which always finishes before this native 'click' event
    //   fires, so the flag is already current by the time this runs. It is read-and-cleared
    //   at the TOP of the handler, ahead of every guard: it describes this click, and any
    //   guard returning with it still set would carry it into the next click and swallow that
    //   seek instead.
    // - `currentStep !== -1` rules out a click that is placing a new drawing's point.
    const candleMain = widget.getDom('candle_pane', 'main')
    let clickDownX = 0
    let clickDownY = 0
    const onCandleMainPointerDown = (event: PointerEvent) => {
      clickDownX = event.clientX
      clickDownY = event.clientY
    }
    const onCandleMainClick = (event: MouseEvent) => {
      const hitOverlay = overlayInteracted
      overlayInteracted = false
      if (selectingPointerDown) {
        console.debug('[sync] click ignored: selected this pane', { pane: pane.id })
        return
      }
      if (Math.abs(event.clientX - clickDownX) + Math.abs(event.clientY - clickDownY) >= 5) {
        console.debug('[sync] click ignored: exceeded drag threshold', { pane: pane.id })
        return
      }
      if (hitOverlay) {
        console.debug('[sync] click ignored: hit an existing drawing', { pane: pane.id })
        return
      }
      if (chart.getOverlays().some((overlay) => overlay.currentStep !== -1)) {
        console.debug('[sync] click ignored: a drawing is in progress', { pane: pane.id })
        return
      }
      const main = chart.getSize('candle_pane', 'main')
      if (!main || main.width === 0 || !candleMain) {
        console.debug('[sync] click ignored: candle_pane has no measured width yet', { pane: pane.id })
        return
      }
      const rect = candleMain.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top
      // Same resolver the hover-driven crosshair sync uses (onCrosshairChange above), so a
      // click carries a price too -- reused to re-show a crosshair on any pane this seek
      // reloads, since reloading wipes klinecharts' own crosshair state (see bus.seekPane).
      const point = crosshairPoint(chart, { x, y, paneId: 'candle_pane' })
      if (!point) {
        console.debug('[sync] click ignored: could not resolve a date for this position', { pane: pane.id, x })
        return
      }
      console.debug('[sync] broadcasting seek', { pane: pane.id, point, fraction: x / main.width })
      bus.broadcastSeek(pane.id, point, x / main.width)
    }
    candleMain?.addEventListener('pointerdown', onCandleMainPointerDown)
    candleMain?.addEventListener('click', onCandleMainClick)

    // Auto time sync source, and the jump-to-live control's own trigger. Both consume the same
    // dispatch: klinecharts fires this whenever the visible range moves, whether from a drag,
    // a zoom, a page of history, a live bar or a resize. Which of those it was is not in the
    // payload, so `isDriving()` -- a pointer or wheel gesture on THIS pane, right now -- is
    // what separates a pan the wall should follow from one it caused itself.
    const onVisibleRangeChange = () => {
      if (isDriving()) panPending = true
      scheduleViewTick()
    }
    widget.subscribeAction('onVisibleRangeChange', onVisibleRangeChange)

    // The candle pane's height is not a function of the visible range: adding or removing an
    // indicator sub-pane and dragging a separator both resize it while the range stands still,
    // and neither dispatches anything. Without this the jump-to-live control keeps the inset
    // measured before the layout changed and drifts out of the price area.
    const candleRoot = widget.getDom('candle_pane')
    const candleResize = new ResizeObserver(() => { refreshViewState() })
    if (candleRoot) candleResize.observe(candleRoot)

    // Listened for on the chart's own root (so an x-axis drag counts, not just one over the
    // candles) but released on the window: a drag that ends with the pointer outside the pane
    // -- off the edge of a small pane in a dense layout, which is most of them -- never
    // delivers pointerup to the element it started on, and would leave this stuck driving.
    const onPanPointerDown = () => { pointerDriving = true }
    // Dragging the PRICE axis scales it without moving the visible range, so it dispatches
    // nothing this pane subscribes to -- the end of any pointer gesture is the one signal
    // that covers it as well as the pans that do dispatch.
    const onPanPointerUp = () => {
      pointerDriving = false
      scheduleViewCapture()
    }
    const onPanWheel = () => { wheelDrivingUntil = Date.now() + WHEEL_TAIL_MS }

    // There is no klinecharts action for "crosshair cleared" -- on pointer leave it clears
    // its own internal state directly, with no observable dispatch. `chart.getDom()` with no
    // args returns the chart's own root container, which is what actually receives pointer
    // events.
    const onPointerLeave = () => { bus.clearCrosshair(pane.id) }
    const chartDom = widget.getDom() ?? widgetElement
    chartDom.addEventListener('pointerleave', onPointerLeave)
    chartDom.addEventListener('pointerdown', onPanPointerDown)
    chartDom.addEventListener('wheel', onPanWheel, { passive: true })
    window.addEventListener('pointerup', onPanPointerUp)
    window.addEventListener('pointercancel', onPanPointerUp)

    bus.register({
      id: pane.id,
      getChart: () => widget,
      getPeriodMs: () => periodDurationMs(pane.period),
      seekTo
    })

    widget.setStyles(theme)
    widget.setStyles(styles)
    widget.setLocale(locale)
    widget.setTimezone(displayTimezone)
    applyIndicatorIcons()
    defaultStyles = clone(widget.getStyles())
    mounted = true
    // Sizes the axis gutters the jump-to-live control is inset by, before any range change has
    // happened -- a pane that mounts already scrolled off the tail (it cannot yet, but nothing
    // here should depend on that) would otherwise place its control over the axes.
    refreshViewState()

    pane.api = {
      chart: widget,
      changeIndicator,
      applyYAxisSettings,
      getStyles: () => widget?.getStyles() as Styles,
      setStyles: (patch: DeepPartial<Styles>) => widget?.setStyles(patch),
      setStyleValue,
      restoreStyles,
      setIndicatorParams,
      createOverlay,
      overrideOverlay,
      removeDrawings,
      screenshot
    } satisfies PaneApi

    return () => {
      // Teardown order matters: stop inbound sync dispatches before outbound subscriptions,
      // so a broadcast already in flight can't reach a half-torn-down chart; if this pane was
      // the crosshair source, unregister() itself clears every other pane's synced line
      // rather than leaving it stale with no owner.
      bus.unregister(pane.id)
      if (viewRaf !== 0) cancelAnimationFrame(viewRaf)
      // A capture fired after the chart is disposed would read a dead widget; the state it
      // would have written is already on PaneState, captured on the last settled change.
      if (captureTimer) clearTimeout(captureTimer)
      chartDom.removeEventListener('pointerleave', onPointerLeave)
      chartDom.removeEventListener('pointerdown', onPanPointerDown)
      chartDom.removeEventListener('wheel', onPanWheel)
      window.removeEventListener('pointerup', onPanPointerUp)
      window.removeEventListener('pointercancel', onPanPointerUp)
      candleMain?.removeEventListener('pointerdown', onCandleMainPointerDown)
      candleMain?.removeEventListener('click', onCandleMainClick)
      widget?.unsubscribeAction('onIndicatorTooltipFeatureClick', onIndicatorFeatureClick)
      widget?.unsubscribeAction('onCrosshairChange', onCrosshairChange)
      widget?.unsubscribeAction('onVisibleRangeChange', onVisibleRangeChange)
      candleResize.disconnect()
      pane.api = null
      // dispose()/destroy() calls the store's _clearData(), never _processDataUnsubscribe() --
      // only an in-place setSymbol/setPeriod (resetData) does that. Without this explicit
      // call, every pane a layout shrink destroys leaks its live stream subscription for the
      // tab's lifetime.
      pane.datafeed.unsubscribe(pane.symbol, pane.period)
      dispose(chart)
      widget = null
    }
  })
</script>

<div
  bind:this={paneElement}
  class="klinecharts-pro-pane"
  data-active={active}
  data-pane-id={pane.id}
  style={`grid-area: ${pane.id};`}
  tabindex="-1"
  onpointerdowncapture={() => {
    // Captured BEFORE onActivate, which is what makes the answer meaningful -- see
    // selectingPointerDown. Any pointerdown anywhere in the pane refreshes it, so the flag
    // always describes the gesture actually in flight.
    selectingPointerDown = !active
    onActivate(pane.id)
  }}
  onfocusin={() => onActivate(pane.id)}
>
  <div bind:this={widgetElement} class="klinecharts-pro-widget"></div>
  {#snippet liveJump(bottom: number, right: number)}
    <button
      type="button"
      class="klinecharts-pro-live-jump"
      style={`bottom: ${bottom}px; right: ${right}px;`}
      aria-label={i18n('jump_to_live', locale)}
      title={i18n('jump_to_live', locale)}
      onclick={jumpToLive}
    >
      <ChevronsRightIcon />
    </button>
  {/snippet}
  {#if !atLive}
    <!-- Inside the candle pane's own price area, above whatever sub-panes and axis sit
         below it, and the chart's true lower right corner. The same control twice: the
         first is where the eye already is when reading candles, the second is where a
         scroll-to-the-end control is conventionally looked for, and on a pane carrying
         several tall indicator sub-panes those are a long way apart. -->
    {@render liveJump(priceAreaBottom, yAxisWidth)}
    {@render liveJump(0, 0)}
  {/if}
  {#if pane.loading}
    <div class="klinecharts-pro-loading"><LoaderCircleIcon class="kc-spinner" aria-label="Loading chart data" /></div>
  {/if}
</div>
