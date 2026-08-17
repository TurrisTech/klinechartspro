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
    type Nullable,
    type OverlayCreate,
    type OverlayMode,
    type Period as ChartPeriod,
    type Point,
    type Styles,
    type SymbolInfo as ChartSymbolInfo,
    type TooltipFeatureStyle
  } from 'klinecharts'
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle'

  import type { Period, SymbolInfo } from './types'
  import { getOptions } from './config/settings'
  import type { PaneApi, PaneState } from './state/wall.svelte'
  import { clone, setByPath } from './utils/object'
  import { periodDurationMs } from './utils/period'
  import type { SyncBus } from './sync/bus'
  import { crosshairPoint } from './sync/crosshair'

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
    onIndicatorSettings
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
    const indicatorId = widget.createIndicator({
      name: indicatorName,
      paneId: chartPaneId,
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
  // local midnight (they open 17:00 America/New_York; a week opens Sunday 17:00), and
  // flooring dropped a bar at every page boundary for viewers east of the market. `from` is a
  // generous nominal reach; the server keeps the last `count`.
  function adjustFromTo(currentPeriod: Period, toTimestamp: number, count: number) {
    const to = toTimestamp
    const from = to - count * periodDurationMs(currentPeriod)
    return [from, to] as const
  }

  // Daily and coarser candles are labelled by their market SESSION date, not the wall-clock
  // date of their open: an FX daily candle opens 17:00 New York the evening before its
  // session, a weekly Sunday 17:00, a monthly/yearly 17:00 before the first market day -- so
  // December can open on Sunday 30 November and 2024 on Sunday 31 December 2023. The session
  // date is the New York date of `open + 7h` (wmarkettypes' canonical_date), and it is New
  // York regardless of the display timezone, because that is the market's calendar.
  const sessionDateFormat = new Intl.DateTimeFormat('en', {
    timeZone: 'America/New_York',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const SESSION_DATE_SHIFT_MS = 7 * 60 * 60 * 1000

  function formatDate({ dateTimeFormat, timestamp, type }: FormatDateParams) {
    if (pane.period.timespan === 'minute') {
      return utils.formatDate(dateTimeFormat, timestamp, type === 'xAxis'
        ? 'HH:mm' : 'YYYY-MM-DD HH:mm')
    }
    if (pane.period.timespan === 'hour') {
      return utils.formatDate(dateTimeFormat, timestamp, type === 'xAxis'
        ? 'MM-DD HH:mm' : 'YYYY-MM-DD HH:mm')
    }
    const sessionTimestamp = timestamp + SESSION_DATE_SHIFT_MS
    if (pane.period.timespan === 'month') {
      return utils.formatDate(sessionDateFormat, sessionTimestamp, type === 'xAxis'
        ? 'YYYY-MM' : 'YYYY-MM-DD')
    }
    if (pane.period.timespan === 'year') {
      return utils.formatDate(sessionDateFormat, sessionTimestamp, type === 'xAxis'
        ? 'YYYY' : 'YYYY-MM-DD')
    }
    return utils.formatDate(sessionDateFormat, sessionTimestamp, 'YYYY-MM-DD')
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

  const chartDataLoader: DataLoader = {
    async getBars({ type, timestamp, symbol: chartSymbol, period: chartPeriod, callback }) {
      if (type === 'backward') {
        callback([], { backward: false })
        return
      }
      pane.loading = true
      const currentPeriod = fromChartPeriod(chartPeriod)
      const toTimestamp = type === 'forward' && timestamp ? timestamp - 1 : Date.now()
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
      pane.datafeed.subscribe(chartSymbol as SymbolInfo, fromChartPeriod(chartPeriod), callback)
    },
    unsubscribeBar({ symbol: chartSymbol, period: chartPeriod }) {
      pane.datafeed.unsubscribe(chartSymbol as SymbolInfo, fromChartPeriod(chartPeriod))
    }
  }

  function changeIndicator(name: string, main: boolean, added: boolean) {
    if (main) {
      if (added) {
        createIndicator(name, true, 'candle_pane')
        pane.mainIndicators = [...pane.mainIndicators, name]
      } else {
        widget?.removeIndicator({ paneId: 'candle_pane', name })
        pane.mainIndicators = pane.mainIndicators.filter((item) => item !== name)
      }
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
    }
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
      return widget?.getStyles() as Styles
    }
    if (key === 'yAxis.reverse') {
      pane.yAxisReverse = Boolean(value)
      applyYAxisSettings()
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
      // A click that selects or starts dragging an EXISTING drawing must not also seek. The
      // isDrawing() guard in the click handler below covers PLACING a new drawing (its
      // currentStep stays !== -1 through the final point); this flag covers interacting with
      // one that's already finished -- see `overlayInteracted`'s own comment for why setting a
      // flag here, read by our own later-firing native click listener, is what's race-free.
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
    widget.setTimezone(timezone)
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

    // Click-to-scroll source. Deliberately a native DOM click on candle_pane's own main
    // widget, not klinecharts' `onCandleBarClick` action -- that action only fires when a
    // candle FIGURE is actually under the pointer, which at any real zoom level is a target a
    // couple of pixels wide at best. A click on the gap between candles, or past the newest/
    // oldest loaded bar, must translate to a date too. `convertFromPixel` extrapolates
    // linearly outside the loaded range using this chart's own period (the exact mechanism
    // seekToTimestamp's reverse direction relies on), so any x inside the pane -- not just one
    // over a bar -- resolves to a real timestamp.
    //
    // Two guards a bar-scoped click never needed:
    // - Drag distance: `onCandleBarClick` never fired past klinecharts' own 5px
    //   (`ManhattanDistance.CancelClick`) pointer-move threshold; a native 'click' has no such
    //   built-in cancellation (it fires on any mousedown+mouseup pair regardless of the pan in
    //   between), so it's reproduced here against the same threshold.
    // - Ordering vs. overlay clicks: klinecharts resolves the WHOLE click (candle hit-test,
    //   then every overlay's hit-test) synchronously inside its own mouseup handling, which
    //   always finishes before the browser dispatches the separate native 'click' event this
    //   listens for -- so `overlayInteracted` (set by createOverlay()'s onClick/
    //   onPressedMoveStart above) is already current by the time this runs.
    const candleMain = widget.getDom('candle_pane', 'main')
    let clickDownX = 0
    let clickDownY = 0
    const onCandleMainPointerDown = (event: PointerEvent) => {
      clickDownX = event.clientX
      clickDownY = event.clientY
    }
    const onCandleMainClick = (event: MouseEvent) => {
      if (Math.abs(event.clientX - clickDownX) + Math.abs(event.clientY - clickDownY) >= 5) {
        console.debug('[sync] click ignored: exceeded drag threshold', { pane: pane.id })
        return
      }
      if (overlayInteracted) {
        overlayInteracted = false
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
      const x = event.clientX - candleMain.getBoundingClientRect().left
      const points = chart.convertFromPixel([{ x }], { paneId: 'candle_pane' }) as Array<Partial<Point>>
      const timestamp = points[0]?.timestamp
      if (typeof timestamp !== 'number') {
        console.debug('[sync] click ignored: could not resolve a date for this position', { pane: pane.id, x })
        return
      }
      console.debug('[sync] broadcasting seek', { pane: pane.id, timestamp, fraction: x / main.width })
      bus.broadcastSeek(pane.id, timestamp, x / main.width)
    }
    candleMain?.addEventListener('pointerdown', onCandleMainPointerDown)
    candleMain?.addEventListener('click', onCandleMainClick)

    // There is no klinecharts action for "crosshair cleared" -- on pointer leave it clears
    // its own internal state directly, with no observable dispatch. `chart.getDom()` with no
    // args returns the chart's own root container, which is what actually receives pointer
    // events.
    const onPointerLeave = () => { bus.clearCrosshair(pane.id) }
    const chartDom = widget.getDom() ?? widgetElement
    chartDom.addEventListener('pointerleave', onPointerLeave)

    bus.register({
      id: pane.id,
      getChart: () => widget,
      getPeriodMs: () => periodDurationMs(pane.period)
    })

    widget.setStyles(theme)
    widget.setStyles(styles)
    widget.setLocale(locale)
    widget.setTimezone(timezone)
    applyIndicatorIcons()
    defaultStyles = clone(widget.getStyles())
    mounted = true

    pane.api = {
      chart: widget,
      changeIndicator,
      applyYAxisSettings,
      getStyles: () => widget?.getStyles() as Styles,
      setStyles: (patch: DeepPartial<Styles>) => widget?.setStyles(patch),
      setStyleValue,
      restoreStyles,
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
      chartDom.removeEventListener('pointerleave', onPointerLeave)
      candleMain?.removeEventListener('pointerdown', onCandleMainPointerDown)
      candleMain?.removeEventListener('click', onCandleMainClick)
      widget?.unsubscribeAction('onIndicatorTooltipFeatureClick', onIndicatorFeatureClick)
      widget?.unsubscribeAction('onCrosshairChange', onCrosshairChange)
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
  onpointerdowncapture={() => onActivate(pane.id)}
  onfocusin={() => onActivate(pane.id)}
>
  <div bind:this={widgetElement} class="klinecharts-pro-widget"></div>
  {#if pane.loading}
    <div class="klinecharts-pro-loading"><LoaderCircleIcon class="kc-spinner" aria-label="Loading chart data" /></div>
  {/if}
</div>
