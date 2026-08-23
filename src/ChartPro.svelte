<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import {
    utils,
    type Chart,
    type DeepPartial,
    type OverlayMode,
    type Styles
  } from 'klinecharts'
  import MenuIcon from '@lucide/svelte/icons/menu'
  import SearchIcon from '@lucide/svelte/icons/search'
  import ChartIcon from '@lucide/svelte/icons/chart-no-axes-combined'
  import GlobeIcon from '@lucide/svelte/icons/globe-2'
  import SettingsIcon from '@lucide/svelte/icons/settings-2'
  import CameraIcon from '@lucide/svelte/icons/camera'
  import MaximizeIcon from '@lucide/svelte/icons/maximize-2'
  import MinimizeIcon from '@lucide/svelte/icons/minimize-2'
  import LineIcon from '@lucide/svelte/icons/chart-spline'
  import ParallelIcon from '@lucide/svelte/icons/align-horizontal-space-around'
  import ShapesIcon from '@lucide/svelte/icons/shapes'
  import FibonacciIcon from '@lucide/svelte/icons/binary'
  import WavesIcon from '@lucide/svelte/icons/waves'
  import MagnetIcon from '@lucide/svelte/icons/magnet'
  import LockIcon from '@lucide/svelte/icons/lock-keyhole'
  import UnlockIcon from '@lucide/svelte/icons/unlock-keyhole'
  import EyeIcon from '@lucide/svelte/icons/eye'
  import EyeOffIcon from '@lucide/svelte/icons/eye-off'
  import TrashIcon from '@lucide/svelte/icons/trash-2'
  import CircleIcon from '@lucide/svelte/icons/circle'
  import SquareIcon from '@lucide/svelte/icons/square'
  import TriangleIcon from '@lucide/svelte/icons/triangle'
  import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right'
  import MinusIcon from '@lucide/svelte/icons/minus'
  import GitBranchIcon from '@lucide/svelte/icons/git-branch'
  import CheckIcon from '@lucide/svelte/icons/check'
  import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle'
  import XIcon from '@lucide/svelte/icons/x'
  import StarIcon from '@lucide/svelte/icons/star'
  import ChevronDownIcon from '@lucide/svelte/icons/chevron-down'
  import ArrowLeftRightIcon from '@lucide/svelte/icons/arrow-left-right'
  import {
    Avatar,
    Checkbox,
    Command,
    Dialog,
    Popover,
    ScrollArea,
    Separator,
    Switch,
    ToggleGroup,
    Tooltip
  } from 'bits-ui'

  import i18n from './i18n'
  import type {
    ChartProOptions,
    ChartProPane,
    Datafeed,
    DatafeedFactory,
    IndicatorParamsCheck,
    PaneOptions,
    PaneSnapshot,
    Period,
    SymbolInfo
  } from './types'
  import { indicatorSettingsFor } from './config/indicators'
  import { getOptions } from './config/settings'
  import {
    createTimezoneSelectOptions,
    translateTimezone
  } from './config/timezones'
  import ChartPane from './ChartPane.svelte'
  import LayoutPicker from './LayoutPicker.svelte'
  import { Wall } from './state/wall.svelte'
  import { clone } from './utils/object'
  import { SyncBus } from './sync/bus'
  import SyncToggle from './SyncToggle.svelte'

  type ChartProps = Required<Omit<ChartProOptions, 'container'>>
  type DrawingTool = {
    name: string
    labelKey: string
    icon: typeof LineIcon
  }
  type DrawingGroup = {
    labelKey: string
    icon: typeof LineIcon
    tools: DrawingTool[]
  }
  type IndicatorSettingsState = {
    paneId: string
    chartPaneId: string
    indicatorName: string
    calcParams: unknown[]
  }

  let {
    styles,
    watermark,
    theme,
    locale,
    drawingBarVisible,
    symbol,
    period,
    periods,
    starredPeriods,
    onStarredPeriodsChange,
    timezone,
    mainIndicators,
    subIndicators,
    indicatorGroups,
    indicatorParamsValidator,
    indicatorSettingsHandler,
    datafeed,
    paneLayout,
    panes,
    maxPanes,
    activePane,
    syncCrosshair,
    syncTime,
    syncAuto,
    onPaneLayoutChange,
    onActivePaneChange,
    onPanesChange,
    onSymbolChange,
    onPeriodChange,
    onSyncChange
  }: ChartProps = $props()

  let rootElement = $state<HTMLDivElement>()
  let toolbarSlot = $state<HTMLDivElement>()
  let railFooterSlot = $state<HTMLDivElement>()

  let selectedPeriodText = $state('')
  // Construction-time-seeded, like `periods` itself: the app supplies the initial set and
  // hears about every change via onStarredPeriodsChange, rather than this reading a
  // reactive prop. `untrack` makes that one-time read explicit rather than triggering
  // Svelte's "did you mean $derived" warning.
  let starred = $state<Set<string>>(untrack(() => new Set(starredPeriods)))
  let syncCrosshairEnabled = $state(untrack(() => syncCrosshair))
  let syncTimeEnabled = $state(untrack(() => syncTime))
  let syncAutoEnabled = $state(untrack(() => syncAuto))

  let symbolDialogOpen = $state(false)
  let indicatorDialogOpen = $state(false)
  let timezoneDialogOpen = $state(false)
  let settingsDialogOpen = $state(false)
  let screenshotDialogOpen = $state(false)
  let indicatorSettingsOpen = $state(false)
  let screenshotUrl = $state('')

  let symbolQuery = $state('')
  let symbolResults = $state<SymbolInfo[]>([])
  let symbolSearching = $state(false)
  let settingsStyles = $state<Styles | null>(null)
  let indicatorSettings = $state<IndicatorSettingsState>({
    paneId: '',
    chartPaneId: '',
    indicatorName: '',
    calcParams: []
  })
  // The app's verdict on the numbers currently in the dialog. `null` means nobody is
  // checking (no validator supplied, or the answer is still in flight) -- which must look
  // exactly like the old behaviour rather than like a pending refusal, so Confirm stays
  // enabled and nothing is drawn until an answer actually arrives.
  let indicatorParamsCheck = $state<IndicatorParamsCheck | null>(null)
  let indicatorParamsChecking = $state(false)

  // Debounced, and last-write-wins: the params inputs fire per keystroke, and a slow answer
  // for "1" must never overwrite the answer for "14" that the user has since typed.
  const INDICATOR_PARAMS_DEBOUNCE_MS = 300
  let paramsCheckTimer: ReturnType<typeof setTimeout> | null = null
  let paramsCheckSeq = 0
  const checkIndicatorParams = (state: IndicatorSettingsState): void => {
    const validate = indicatorParamsValidator
    if (paramsCheckTimer) clearTimeout(paramsCheckTimer)
    if (!validate || !state.indicatorName) {
      indicatorParamsCheck = null
      indicatorParamsChecking = false
      return
    }
    const pane = wall.panes.find((item) => item.id === state.paneId)
    if (!pane?.symbol || !pane.period) {
      indicatorParamsCheck = null
      return
    }
    const seq = ++paramsCheckSeq
    indicatorParamsChecking = true
    paramsCheckTimer = setTimeout(() => {
      void validate({
        indicatorName: state.indicatorName,
        calcParams: [...state.calcParams],
        symbol: pane.symbol,
        period: pane.period
      })
        .then((result) => {
          if (seq !== paramsCheckSeq) return
          indicatorParamsCheck = result
        })
        .catch(() => {
          // An unreachable or older server must not lock the dialog: fall back to the
          // no-validator behaviour rather than refusing params we simply could not check.
          if (seq !== paramsCheckSeq) return
          indicatorParamsCheck = null
        })
        .finally(() => {
          if (seq === paramsCheckSeq) indicatorParamsChecking = false
        })
    }, INDICATOR_PARAMS_DEBOUNCE_MS)
  }

  $effect(() => {
    if (!indicatorSettingsOpen) {
      if (paramsCheckTimer) clearTimeout(paramsCheckTimer)
      paramsCheckSeq++
      indicatorParamsCheck = null
      indicatorParamsChecking = false
      return
    }
    checkIndicatorParams(indicatorSettings)
  })
  let fullscreen = $state(false)

  let overlayMode = $state<OverlayMode>('normal')
  let overlaysLocked = $state(false)
  let overlaysVisible = $state(true)

  const mainIndicatorNames = ['MA', 'EMA', 'WMA', 'SMA', 'BOLL', 'SAR', 'BBI']
  const subIndicatorNames = [
    'MA', 'EMA', 'WMA', 'VOL', 'MACD', 'BOLL', 'KDJ', 'RSI', 'BIAS', 'BRAR', 'CCI',
    'DMI', 'CR', 'PSY', 'DMA', 'TRIX', 'OBV', 'VR', 'WR', 'MTM', 'EMV',
    'SAR', 'SMA', 'ROC', 'PVT', 'BBI', 'AO'
  ]

  const drawingGroups: DrawingGroup[] = [
    {
      labelKey: 'straight_line',
      icon: LineIcon,
      tools: [
        ['horizontalStraightLine', 'horizontal_straight_line', MinusIcon],
        ['horizontalRayLine', 'horizontal_ray_line', ArrowUpRightIcon],
        ['horizontalSegment', 'horizontal_segment', MinusIcon],
        ['verticalStraightLine', 'vertical_straight_line', MinusIcon],
        ['verticalRayLine', 'vertical_ray_line', ArrowUpRightIcon],
        ['verticalSegment', 'vertical_segment', MinusIcon],
        ['straightLine', 'straight_line', LineIcon],
        ['rayLine', 'ray_line', ArrowUpRightIcon],
        ['segment', 'segment', LineIcon],
        ['arrow', 'arrow', ArrowUpRightIcon],
        ['priceLine', 'price_line', LineIcon]
      ].map(([name, labelKey, icon]) => ({ name, labelKey, icon })) as DrawingTool[]
    },
    {
      labelKey: 'price_channel_line',
      icon: ParallelIcon,
      tools: [
        { name: 'priceChannelLine', labelKey: 'price_channel_line', icon: ParallelIcon },
        { name: 'parallelStraightLine', labelKey: 'parallel_straight_line', icon: ParallelIcon }
      ]
    },
    {
      labelKey: 'circle',
      icon: ShapesIcon,
      tools: [
        { name: 'circle', labelKey: 'circle', icon: CircleIcon },
        { name: 'rect', labelKey: 'rect', icon: SquareIcon },
        { name: 'parallelogram', labelKey: 'parallelogram', icon: ShapesIcon },
        { name: 'triangle', labelKey: 'triangle', icon: TriangleIcon }
      ]
    },
    {
      labelKey: 'fibonacci_line',
      icon: FibonacciIcon,
      tools: [
        'fibonacciLine', 'fibonacciSegment', 'fibonacciCircle', 'fibonacciSpiral',
        'fibonacciSpeedResistanceFan', 'fibonacciExtension', 'gannBox'
      ].map((name) => ({
        name,
        labelKey: name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        icon: FibonacciIcon
      }))
    },
    {
      labelKey: 'xabcd',
      icon: WavesIcon,
      tools: [
        'xabcd', 'abcd', 'threeWaves', 'fiveWaves', 'eightWaves', 'anyWaves'
      ].map((name) => ({
        name,
        labelKey: name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        icon: name === 'xabcd' || name === 'abcd' ? GitBranchIcon : WavesIcon
      }))
    }
  ]

  // `datafeed`/`symbol`/`period`/`mainIndicators`/`subIndicators`/`panes`/`paneLayout`/
  // `maxPanes` are all construction-time-only, like `periods`/`starredPeriods` already are --
  // read once here (inside `untrack`, to avoid Svelte's "did you mean $derived" warning) and
  // never again. Every pane needs its OWN Datafeed instance whenever that datafeed keeps
  // per-subscription state (the common case -- see src/types.ts DatafeedFactory); a plain
  // object is still accepted for back-compat (every pane then shares it), with a one-time
  // warning if the initial layout already holds more than one pane, since only the
  // datafeed's author knows whether sharing is actually safe.
  const wall = untrack(() => {
    const datafeedFactory: DatafeedFactory = typeof datafeed === 'function'
      ? (datafeed as DatafeedFactory)
      : () => datafeed as Datafeed
    const seeds: PaneOptions[] = panes.length > 0
      ? panes
      : [{ symbol, period, mainIndicators, subIndicators }]
    const built = new Wall({
      maxPanes,
      initialLayoutId: paneLayout,
      initialActiveId: activePane,
      datafeedFactory,
      seeds,
      onPaneLayoutChange,
      onActivePaneChange
    })
    if (typeof datafeed !== 'function' && built.layout.paneCount > 1) {
      console.warn(
        '[KLineChartPro] a single Datafeed instance is shared by every pane in a multi-pane ' +
        'layout. If it keeps any per-subscription state (most real datafeeds do), panes on ' +
        'the same symbol/interval will interfere with each other -- pass a factory ' +
        '`(paneId) => Datafeed` instead.'
      )
    }
    return built
  })

  // One registry per shell instance -- crosshair sync and click-to-scroll, threaded down to
  // every ChartPane as a prop. Never at module scope: that would share sync state across two
  // `new KLineChartPro()` instances mounted on the same page.
  const bus = new SyncBus()

  function toChartProPane(pane: (typeof wall.panes)[number]): ChartProPane {
    return {
      id: pane.id,
      getChart: () => pane.api?.chart as Chart,
      getSymbol: () => pane.symbol,
      setSymbol: (value: SymbolInfo) => {
        pane.symbol = value
        onSymbolChange(pane.id, value)
      },
      getPeriod: () => pane.period,
      setPeriod: (value: Period) => {
        pane.period = value
        onPeriodChange(pane.id, value)
      },
      getDatafeed: () => pane.datafeed,
      isActive: () => pane.id === wall.activeId
    }
  }

  const portalProps = $derived(rootElement ? { to: rootElement } : undefined)
  const timezoneOptions = $derived(createTimezoneSelectOptions(locale))
  const settingOptions = $derived(getOptions(locale))

  const iconButtonClass = (active = false) => `kc-button kc-icon-button${active ? ' is-active' : ''}`

  // The top-rail chips: every starred period, in `periods`' own (shortest-first) order, plus
  // the ACTIVE PANE's current period appended as a transient chip when it isn't starred -- so
  // the rail always shows what's playing on the active chart even if the user never starred it.
  const railPeriods = $derived.by(() => {
    const list = periods.filter((item) => starred.has(item.text))
    if (!starred.has(wall.active.period.text)) list.push(wall.active.period)
    return list
  })

  // The dropdown's three sections. Days/weeks/months/years share one "Days & above" group --
  // the 16-interval server contract KLineChart Pro clients are built against
  // (client/periods.ts) has too few long periods to need day/week/month split further.
  const timeframeGroups = $derived.by(() => {
    const minutes: Period[] = []
    const hours: Period[] = []
    const daysAndAbove: Period[] = []
    for (const item of periods) {
      if (item.timespan === 'minute') minutes.push(item)
      else if (item.timespan === 'hour') hours.push(item)
      else daysAndAbove.push(item)
    }
    return [
      { key: 'minutes', labelKey: 'minutes', items: minutes },
      { key: 'hours', labelKey: 'hours', items: hours },
      { key: 'days', labelKey: 'days', items: daysAndAbove }
    ].filter((group) => group.items.length > 0)
  })

  function toggleStarred(text: string) {
    const next = new Set(starred)
    if (next.has(text)) next.delete(text)
    else next.add(text)
    starred = next
    onStarredPeriodsChange(Array.from(starred))
  }

  function getSettingValue(key: string): unknown {
    if (key === 'yAxis.type') return wall.active.yAxisType
    if (key === 'yAxis.reverse') return wall.active.yAxisReverse
    return utils.formatValue(settingsStyles, key)
  }

  function updateStyle(key: string, value: unknown) {
    if (!settingsStyles) return
    settingsStyles = wall.active.api?.setStyleValue(key, value) ?? settingsStyles
  }

  function restoreStyles() {
    settingsStyles = wall.active.api?.restoreStyles() ?? settingsStyles
  }

  function openSettings() {
    const current = wall.active.api?.getStyles()
    if (!current) return
    settingsStyles = clone(current)
    settingsDialogOpen = true
  }

  function createOverlay(tool: DrawingTool) {
    wall.active.api?.createOverlay(tool.name, {
      mode: overlayMode,
      lock: overlaysLocked,
      visible: overlaysVisible
    })
  }

  function takeScreenshot() {
    const url = wall.active.api?.screenshot(theme === 'dark' ? '#171717' : '#ffffff')
    if (!url) return
    screenshotUrl = url
    screenshotDialogOpen = true
  }

  function saveScreenshot() {
    const link = document.createElement('a')
    link.download = 'klinechart-screenshot.jpeg'
    link.href = screenshotUrl
    link.click()
  }

  async function toggleFullscreen() {
    const target = rootElement?.parentElement
    if (!document.fullscreenElement) await target?.requestFullscreen()
    else await document.exitFullscreen()
  }

  export function getChart() { return wall.active.api?.chart ?? null }
  export function setTheme(value: string) { theme = value }
  export function getTheme() { return theme }
  export function setStyles(value: DeepPartial<Styles>) { styles = value }
  export function getStyles() { return wall.active.api?.getStyles() as Styles }
  export function setLocale(value: string) { locale = value }
  export function getLocale() { return locale }
  export function setTimezone(value: string) { timezone = value }
  export function getTimezone() { return timezone }
  export function setSymbol(value: SymbolInfo) {
    wall.active.symbol = value
    onSymbolChange(wall.active.id, value)
  }
  export function getSymbol() { return wall.active.symbol }
  export function setPeriod(value: Period) {
    wall.active.period = value
    onPeriodChange(wall.active.id, value)
  }
  export function getPeriod() { return wall.active.period }
  export function getSlot(name: 'toolbar' | 'rail-footer') {
    return (name === 'toolbar' ? toolbarSlot : railFooterSlot) ?? null
  }

  export function getPanes(): ChartProPane[] {
    return wall.visiblePanes.filter((pane) => pane.api !== null).map(toChartProPane)
  }
  export function getPaneSnapshots(): PaneSnapshot[] {
    return wall.visiblePanes.map((pane) => pane.snapshot())
  }
  export function getPane(id: string): ChartProPane | null {
    const pane = wall.visiblePanes.find((item) => item.id === id && item.api !== null)
    return pane ? toChartProPane(pane) : null
  }
  export function getActivePaneId() { return wall.activeId }
  export function setActivePane(id: string) { wall.activate(id) }
  export function setPaneLayout(id: string) { wall.setLayout(id) }
  export function getPaneLayout() { return wall.layoutId }
  export function getPaneLayouts() { return [...wall.layouts] }

  $effect(() => {
    selectedPeriodText = wall.active.period.text
  })

  // Broadcasts the drawing rail's tool-mode state to every visible pane, including one that
  // has just mounted (a layout grow) -- this effect's own read of `pane.api` for each visible
  // pane is what makes it re-run exactly when a pane's chart becomes available, not only when
  // the mode/lock/visible toggles themselves change.
  $effect(() => {
    const mode = overlayMode
    const lock = overlaysLocked
    const visible = overlaysVisible
    for (const pane of wall.visiblePanes) {
      pane.api?.overrideOverlay({ mode, lock, visible })
    }
  })

  // The definitive "which panes are actually live" signal for a consuming app -- fires only
  // once each pane's chart exists (mount) or has been torn down (unmount / layout shrink),
  // via ChartPane publishing/clearing `pane.api`.
  $effect(() => {
    const live = wall.visiblePanes.filter((pane) => pane.api !== null).map(toChartProPane)
    onPanesChange(live)
  })

  onMount(() => {
    const handleFullscreen = () => { fullscreen = Boolean(document.fullscreenElement) }
    document.addEventListener('fullscreenchange', handleFullscreen)

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreen)
      bus.dispose()
    }
  })

  // Tracks syncAutoEnabled's PREVIOUS value so the alignment below fires on the transition
  // into auto sync, not on every re-run of the effect (a crosshair toggle would otherwise
  // yank every pane back to the active one's view for no reason the user asked for).
  let syncAutoWas = untrack(() => syncAuto)

  $effect(() => {
    bus.setOptions({
      crosshair: syncCrosshairEnabled,
      time: syncTimeEnabled,
      auto: syncAutoEnabled
    })
    onSyncChange({
      crosshair: syncCrosshairEnabled,
      time: syncTimeEnabled,
      auto: syncAutoEnabled
    })
    const turnedOn = syncAutoEnabled && !syncAutoWas
    syncAutoWas = syncAutoEnabled
    // Switching auto sync on aligns the wall immediately, to the ACTIVE pane. Waiting for the
    // next drag would leave a mode called "sync" changing nothing at the moment it is turned
    // on, and leave the user to guess which pane the others will eventually follow.
    if (turnedOn) bus.alignTo(untrack(() => wall.activeId))
  })

  $effect(() => {
    if (!symbolDialogOpen) return
    const query = symbolQuery
    const timer = window.setTimeout(async () => {
      symbolSearching = true
      try {
        symbolResults = await wall.active.datafeed.searchSymbols(query)
      } finally {
        symbolSearching = false
      }
    }, 180)
    return () => window.clearTimeout(timer)
  })
</script>

<div bind:this={rootElement} class="klinecharts-pro-shell">
  <Tooltip.Provider delayDuration={250}>
    <header class="kc-toolbar">
      <Tooltip.Root>
        <Tooltip.Trigger class={iconButtonClass()} onclick={() => {
          drawingBarVisible = !drawingBarVisible
        }} aria-label="Toggle drawing toolbar">
          <MenuIcon />
        </Tooltip.Trigger>
        <Tooltip.Portal {...portalProps}>
          <Tooltip.Content class="kc-tooltip">{i18n('drawing_tools', locale)}</Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>

      <button class="kc-button kc-symbol-button" onclick={() => { symbolDialogOpen = true }}>
        <Avatar.Root class="kc-avatar kc-avatar-sm">
          {#if wall.active.symbol.logo}<Avatar.Image class="kc-avatar-image" src={wall.active.symbol.logo} alt={wall.active.symbol.ticker} />{/if}
          <Avatar.Fallback class="kc-avatar-fallback">{wall.active.symbol.ticker.slice(0, 2).toUpperCase()}</Avatar.Fallback>
        </Avatar.Root>
        <span class="kc-truncate">{wall.active.symbol.shortName ?? wall.active.symbol.name ?? wall.active.symbol.ticker}</span>
        <SearchIcon />
      </button>

      <Separator.Root orientation="vertical" class="kc-separator kc-separator-vertical" />
      <div class="kc-period-scroller">
        <ToggleGroup.Root type="single" class="kc-toggle-group" bind:value={selectedPeriodText}>
          {#each railPeriods as item (item.text)}
            <ToggleGroup.Item
              class={`kc-toggle-item${starred.has(item.text) ? '' : ' is-transient'}`}
              value={item.text}
              onclick={() => {
                wall.active.period = item
                onPeriodChange(wall.active.id, item)
              }}
            >
              {item.text}
            </ToggleGroup.Item>
          {/each}
        </ToggleGroup.Root>
      </div>

      <Popover.Root>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Popover.Trigger {...props} class="kc-button kc-timeframe-trigger" aria-label={i18n('timeframes', locale)}>
                <span class="kc-truncate">{wall.active.period.text}</span>
                <ChevronDownIcon />
              </Popover.Trigger>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Portal {...portalProps}>
            <Tooltip.Content class="kc-tooltip">{i18n('timeframes', locale)}</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <Popover.Portal {...portalProps}>
          <Popover.Content align="start" sideOffset={4} class="kc-popover kc-timeframe-popover">
            {#each timeframeGroups as group (group.key)}
              <div class="kc-popover-header">{i18n(group.labelKey, locale)}</div>
              <div class="kc-timeframe-grid">
                {#each group.items as item (item.text)}
                  <div class="kc-timeframe-row">
                    <button
                      type="button"
                      class="kc-star-toggle"
                      aria-pressed={starred.has(item.text)}
                      aria-label={i18n(starred.has(item.text) ? 'unstar_timeframe' : 'star_timeframe', locale)}
                      onclick={() => toggleStarred(item.text)}
                    >
                      <StarIcon class={`kc-star-icon${starred.has(item.text) ? ' is-filled' : ''}`} />
                    </button>
                    <Popover.Close class="kc-timeframe-item" onclick={() => {
                      wall.active.period = item
                      onPeriodChange(wall.active.id, item)
                    }}>
                      {item.text}
                    </Popover.Close>
                  </div>
                {/each}
              </div>
            {/each}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <div class="kc-toolbar-slot" bind:this={toolbarSlot}></div>

      <div class="kc-toolbar-actions">
        <LayoutPicker {wall} {locale} {portalProps} />
        <Tooltip.Root>
          <Tooltip.Trigger
            class={iconButtonClass(syncAutoEnabled)}
            aria-pressed={syncAutoEnabled}
            aria-label={i18n('sync_auto', locale)}
            onclick={() => { syncAutoEnabled = !syncAutoEnabled }}
          >
            <ArrowLeftRightIcon />
          </Tooltip.Trigger>
          <Tooltip.Portal {...portalProps}>
            <Tooltip.Content class="kc-tooltip">{i18n('sync_auto', locale)}</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <SyncToggle
          bind:crosshair={syncCrosshairEnabled}
          bind:time={syncTimeEnabled}
          auto={syncAutoEnabled}
          {locale}
          {portalProps}
        />
        {#each [
          { label: i18n('indicator', locale), icon: ChartIcon, action: () => { indicatorDialogOpen = true } },
          { label: i18n('timezone', locale), icon: GlobeIcon, action: () => { timezoneDialogOpen = true } },
          { label: i18n('setting', locale), icon: SettingsIcon, action: openSettings },
          { label: i18n('screenshot', locale), icon: CameraIcon, action: takeScreenshot }
        ] as action (action.label)}
          {@const ActionIcon = action.icon}
          <Tooltip.Root>
            <Tooltip.Trigger class={iconButtonClass()} onclick={action.action} aria-label={action.label}>
              <ActionIcon />
            </Tooltip.Trigger>
            <Tooltip.Portal {...portalProps}>
              <Tooltip.Content class="kc-tooltip">{action.label}</Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        {/each}
        <Tooltip.Root>
          <Tooltip.Trigger class={iconButtonClass()} onclick={toggleFullscreen} aria-label={i18n(fullscreen ? 'exit_full_screen' : 'full_screen', locale)}>
            {#if fullscreen}<MinimizeIcon />{:else}<MaximizeIcon />{/if}
          </Tooltip.Trigger>
          <Tooltip.Portal {...portalProps}>
            <Tooltip.Content class="kc-tooltip">{i18n(fullscreen ? 'exit_full_screen' : 'full_screen', locale)}</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
      </div>
    </header>

    <div class="klinecharts-pro-chart-area">
      {#if drawingBarVisible}
        <aside class="kc-drawing-toolbar">
          {#each drawingGroups as group (group.labelKey)}
            {@const GroupIcon = group.icon}
            <Popover.Root>
              <Tooltip.Root>
                <Tooltip.Trigger>
                  {#snippet child({ props })}
                    <Popover.Trigger {...props} class={iconButtonClass()} aria-label={i18n(group.labelKey, locale)}>
                      <GroupIcon />
                    </Popover.Trigger>
                  {/snippet}
                </Tooltip.Trigger>
                <Tooltip.Portal {...portalProps}>
                  <Tooltip.Content class="kc-tooltip" side="right">{i18n(group.labelKey, locale)}</Tooltip.Content>
                </Tooltip.Portal>
              </Tooltip.Root>
              <Popover.Portal {...portalProps}>
                <Popover.Content side="right" align="start" sideOffset={4} class="kc-popover">
                  <div class="kc-popover-header">{i18n(group.labelKey, locale)}</div>
                  <ScrollArea.Root class="kc-tool-scroll-area">
                    <ScrollArea.Viewport class="kc-scroll-viewport">
                      <div class="kc-tool-list">
                        {#each group.tools as tool (tool.name)}
                          {@const ToolIcon = tool.icon}
                          <Popover.Close class="kc-button kc-tool-button" onclick={() => createOverlay(tool)}>
                            <ToolIcon />
                            <span>{i18n(tool.labelKey, locale)}</span>
                          </Popover.Close>
                        {/each}
                      </div>
                    </ScrollArea.Viewport>
                    <ScrollArea.Scrollbar orientation="vertical" class="kc-scrollbar">
                      <ScrollArea.Thumb class="kc-scroll-thumb" />
                    </ScrollArea.Scrollbar>
                  </ScrollArea.Root>
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          {/each}

          <Separator.Root class="kc-separator kc-separator-horizontal" />
          <Tooltip.Root>
            <Tooltip.Trigger class={iconButtonClass(overlayMode !== 'normal')} onclick={() => {
              overlayMode = overlayMode === 'normal' ? 'weak_magnet' : 'normal'
            }} aria-label={i18n('weak_magnet', locale)}><MagnetIcon /></Tooltip.Trigger>
            <Tooltip.Portal {...portalProps}><Tooltip.Content class="kc-tooltip" side="right">{i18n('weak_magnet', locale)}</Tooltip.Content></Tooltip.Portal>
          </Tooltip.Root>
          <Tooltip.Root>
            <Tooltip.Trigger class={iconButtonClass(overlaysLocked)} onclick={() => {
              overlaysLocked = !overlaysLocked
            }} aria-label={i18n(overlaysLocked ? 'unlock' : 'lock', locale)}>
              {#if overlaysLocked}<LockIcon />{:else}<UnlockIcon />{/if}
            </Tooltip.Trigger>
            <Tooltip.Portal {...portalProps}><Tooltip.Content class="kc-tooltip" side="right">{i18n(overlaysLocked ? 'unlock' : 'lock', locale)}</Tooltip.Content></Tooltip.Portal>
          </Tooltip.Root>
          <Tooltip.Root>
            <Tooltip.Trigger class={iconButtonClass(!overlaysVisible)} onclick={() => {
              overlaysVisible = !overlaysVisible
            }} aria-label={i18n(overlaysVisible ? 'invisible' : 'visible', locale)}>
              {#if overlaysVisible}<EyeIcon />{:else}<EyeOffIcon />{/if}
            </Tooltip.Trigger>
            <Tooltip.Portal {...portalProps}><Tooltip.Content class="kc-tooltip" side="right">{i18n(overlaysVisible ? 'invisible' : 'visible', locale)}</Tooltip.Content></Tooltip.Portal>
          </Tooltip.Root>
          <Tooltip.Root>
            <Tooltip.Trigger class={iconButtonClass()} onclick={() => wall.active.api?.removeDrawings()} aria-label={i18n('remove', locale)}><TrashIcon /></Tooltip.Trigger>
            <Tooltip.Portal {...portalProps}><Tooltip.Content class="kc-tooltip" side="right">{i18n('remove', locale)}</Tooltip.Content></Tooltip.Portal>
          </Tooltip.Root>

          <div class="kc-rail-footer" bind:this={railFooterSlot}></div>
        </aside>
      {/if}

      <div
        class="klinecharts-pro-grid"
        data-pane-count={wall.layout.paneCount}
        style={`grid-template-areas: ${wall.layout.gridTemplateAreas}; grid-template-columns: ${wall.layout.gridTemplateColumns}; grid-template-rows: ${wall.layout.gridTemplateRows};`}
      >
        {#each wall.visiblePanes as pane (pane.id)}
          <ChartPane
            {pane}
            active={pane.id === wall.activeId}
            {theme}
            {styles}
            {locale}
            {timezone}
            {watermark}
            {periods}
            {bus}
            onActivate={(id) => wall.activate(id)}
            onIndicatorSettings={(payload) => {
              // An app may own this indicator's settings entirely -- see
              // IndicatorSettingsHandler. It answers true once it has opened its own UI,
              // and the numeric dialog below never opens for that indicator.
              if (
                indicatorSettingsHandler?.({
                  indicatorName: payload.name,
                  paneId: payload.paneId,
                  chartPaneId: payload.chartPaneId,
                  calcParams: payload.calcParams
                })
              ) {
                return
              }
              indicatorSettings = {
                paneId: payload.paneId,
                chartPaneId: payload.chartPaneId,
                indicatorName: payload.name,
                calcParams: payload.calcParams
              }
              indicatorSettingsOpen = true
            }}
          />
        {/each}
      </div>
    </div>

    <Dialog.Root bind:open={symbolDialogOpen}>
      <Dialog.Portal {...portalProps}>
        <Dialog.Overlay class="kc-dialog-overlay" />
        <Dialog.Content class="kc-dialog-content kc-dialog-lg">
          <div class="kc-dialog-header">
          <Dialog.Title>{i18n('symbol_search', locale)}</Dialog.Title>
          <Dialog.Description>{i18n('symbol_code', locale)}</Dialog.Description>
          </div>
          <Dialog.Close class="kc-button kc-icon-button kc-dialog-close" aria-label="Close"><XIcon /></Dialog.Close>
        <Command.Root shouldFilter={false} class="kc-command">
          <div class="kc-command-input-wrap"><SearchIcon /><Command.Input class="kc-command-input" bind:value={symbolQuery} placeholder={i18n('symbol_code', locale)} /></div>
          <Command.List class="kc-command-list">
            {#if symbolSearching}<Command.Loading class="kc-command-loading"><LoaderCircleIcon class="kc-spinner" /></Command.Loading>{/if}
            {#if !symbolSearching && symbolResults.length === 0}
              <Command.Empty class="kc-command-empty">{i18n('no_data', locale)}</Command.Empty>
            {/if}
            <Command.Group class="kc-command-group" value={i18n('symbol_search', locale)}>
              <Command.GroupHeading class="kc-command-heading">{i18n('symbol_search', locale)}</Command.GroupHeading>
              <Command.GroupItems>
                {#each symbolResults as item (item.ticker)}
                  <Command.Item class="kc-command-item" value={item.ticker} onclick={() => {
                    wall.active.symbol = item
                    onSymbolChange(wall.active.id, item)
                    symbolDialogOpen = false
                  }}>
                    <Avatar.Root class="kc-avatar">
                      {#if item.logo}<Avatar.Image class="kc-avatar-image" src={item.logo} alt={item.ticker} />{/if}
                      <Avatar.Fallback class="kc-avatar-fallback">{item.ticker.slice(0, 2)}</Avatar.Fallback>
                    </Avatar.Root>
                    <div class="kc-symbol-result">
                      <div class="kc-truncate kc-font-medium">{item.shortName ?? item.ticker}</div>
                      {#if item.name}<div class="kc-truncate kc-muted-text">{item.name}</div>{/if}
                    </div>
                    <span class="kc-muted-text">{item.exchange ?? ''}</span>
                  </Command.Item>
                {/each}
              </Command.GroupItems>
            </Command.Group>
          </Command.List>
        </Command.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root bind:open={indicatorDialogOpen}>
      <Dialog.Portal {...portalProps}>
        <Dialog.Overlay class="kc-dialog-overlay" />
        <Dialog.Content class="kc-dialog-content kc-dialog-xl">
          <div class="kc-dialog-header">
          <Dialog.Title>{i18n('indicator', locale)}</Dialog.Title>
          <Dialog.Description>{i18n('main_indicator', locale)} / {i18n('sub_indicator', locale)}</Dialog.Description>
          </div>
          <Dialog.Close class="kc-button kc-icon-button kc-dialog-close" aria-label="Close"><XIcon /></Dialog.Close>
        <ScrollArea.Root class="kc-indicator-scroll-area">
          <ScrollArea.Viewport class="kc-scroll-viewport">
          <fieldset class="kc-fieldset">
            <legend>{i18n('main_indicator', locale)}</legend>
            <div class="kc-checkbox-grid">
              {#each mainIndicatorNames as name (name)}
                <div class="kc-checkbox-field">
                  <Checkbox.Root class="kc-checkbox" id={`main-${name}`} checked={wall.active.mainIndicators.includes(name)} onCheckedChange={(checked) => wall.active.api?.changeIndicator(name, true, checked === true)}>
                    {#snippet children({ checked })}{#if checked}<CheckIcon />{/if}{/snippet}
                  </Checkbox.Root>
                  <label for={`main-${name}`}>{i18n(name.toLowerCase(), locale)}</label>
                </div>
              {/each}
            </div>
          </fieldset>
          <Separator.Root class="kc-separator kc-dialog-separator" />
          <fieldset class="kc-fieldset">
            <legend>{i18n('sub_indicator', locale)}</legend>
            <div class="kc-checkbox-grid">
              {#each subIndicatorNames as name (name)}
                <div class="kc-checkbox-field">
                  <Checkbox.Root class="kc-checkbox" id={`sub-${name}`} checked={wall.active.subIndicatorNames.includes(name)} onCheckedChange={(checked) => wall.active.api?.changeIndicator(name, false, checked === true)}>
                    {#snippet children({ checked })}{#if checked}<CheckIcon />{/if}{/snippet}
                  </Checkbox.Root>
                  <label for={`sub-${name}`}>{i18n(name.toLowerCase(), locale)}</label>
                </div>
              {/each}
            </div>
          </fieldset>
          {#each indicatorGroups as group, groupIndex (group.label)}
          <Separator.Root class="kc-separator kc-dialog-separator" />
          <fieldset class="kc-fieldset">
            <legend>{group.label}</legend>
            <div class="kc-checkbox-grid">
              {#each group.items as item (item.name)}
                <div class="kc-checkbox-field" title={item.description ?? ''}>
                  <Checkbox.Root class="kc-checkbox" id={`grp${groupIndex}-${item.name}`} checked={(group.main ? wall.active.mainIndicators : wall.active.subIndicatorNames).includes(item.name)} onCheckedChange={(checked) => wall.active.api?.changeIndicator(item.name, group.main, checked === true)}>
                    {#snippet children({ checked })}{#if checked}<CheckIcon />{/if}{/snippet}
                  </Checkbox.Root>
                  <label for={`grp${groupIndex}-${item.name}`}>{item.label}</label>
                </div>
              {/each}
            </div>
          </fieldset>
          {/each}
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar orientation="vertical" class="kc-scrollbar"><ScrollArea.Thumb class="kc-scroll-thumb" /></ScrollArea.Scrollbar>
        </ScrollArea.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root bind:open={timezoneDialogOpen}>
      <Dialog.Portal {...portalProps}>
        <Dialog.Overlay class="kc-dialog-overlay" />
        <Dialog.Content class="kc-dialog-content kc-dialog-sm">
          <div class="kc-dialog-header">
          <Dialog.Title>{i18n('timezone', locale)}</Dialog.Title>
          <Dialog.Description>{translateTimezone(timezone, locale)}</Dialog.Description>
          </div>
          <Dialog.Close class="kc-button kc-icon-button kc-dialog-close" aria-label="Close"><XIcon /></Dialog.Close>
        <div class="kc-field-group">
          <div class="kc-field">
            <label for="chart-timezone">{i18n('timezone', locale)}</label>
            <select class="kc-select-trigger" id="chart-timezone" bind:value={timezone}>
              {#each timezoneOptions as item (item.key)}
                <option value={item.key}>{item.text}</option>
              {/each}
            </select>
          </div>
        </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root bind:open={settingsDialogOpen}>
      <Dialog.Portal {...portalProps}>
        <Dialog.Overlay class="kc-dialog-overlay" />
        <Dialog.Content class="kc-dialog-content kc-dialog-xl">
          <div class="kc-dialog-header">
          <Dialog.Title>{i18n('setting', locale)}</Dialog.Title>
          <Dialog.Description>{i18n('setting', locale)}</Dialog.Description>
          </div>
          <Dialog.Close class="kc-button kc-icon-button kc-dialog-close" aria-label="Close"><XIcon /></Dialog.Close>
        {#if settingsStyles}
          <div class="kc-field-group">
            {#each settingOptions as option (option.key)}
              <div class="kc-field kc-field-horizontal">
                <label for={`setting-${option.key}`}>{option.text}</label>
                {#if option.component === 'switch'}
                  <Switch.Root class="kc-switch" id={`setting-${option.key}`} checked={Boolean(getSettingValue(option.key))} onCheckedChange={(checked) => updateStyle(option.key, checked)}>
                    <Switch.Thumb class="kc-switch-thumb" />
                  </Switch.Root>
                {:else}
                  <select
                    id={`setting-${option.key}`}
                    class="kc-select-trigger kc-setting-select"
                    value={String(getSettingValue(option.key))}
                    onchange={(event) => updateStyle(option.key, event.currentTarget.value)}
                  >
                    {#each option.dataSource ?? [] as item (item.key)}
                      <option value={item.key}>{item.text}</option>
                    {/each}
                  </select>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        <div class="kc-dialog-footer">
          <button class="kc-button kc-button-outline" onclick={restoreStyles}>{i18n('restore_default', locale)}</button>
          <Dialog.Close class="kc-button kc-button-primary">{i18n('confirm', locale)}</Dialog.Close>
        </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root bind:open={indicatorSettingsOpen}>
      <Dialog.Portal {...portalProps}>
        <Dialog.Overlay class="kc-dialog-overlay" />
        <Dialog.Content class="kc-dialog-content kc-dialog-sm">
          <div class="kc-dialog-header">
          <Dialog.Title>{indicatorSettings.indicatorName}</Dialog.Title>
          <Dialog.Description>{i18n('indicator', locale)}</Dialog.Description>
          </div>
          <Dialog.Close class="kc-button kc-icon-button kc-dialog-close" aria-label="Close"><XIcon /></Dialog.Close>
        <div class="kc-field-group">
          {#each indicatorSettingsFor(indicatorSettings.indicatorName) as config, index (config.paramNameKey)}
            <div class="kc-field">
              <label for={`indicator-param-${index}`}>{i18n(config.paramNameKey, locale)}</label>
              <input class="kc-input" id={`indicator-param-${index}`} type="number" min={config.min} step={10 ** -config.precision} value={String(indicatorSettings.calcParams[index] ?? '')} oninput={(event) => {
                const next = [...indicatorSettings.calcParams]
                next[index] = event.currentTarget.value === '' ? '' : Number(event.currentTarget.value)
                indicatorSettings = { ...indicatorSettings, calcParams: next }
              }} />
            </div>
          {/each}
          {#if indicatorParamsCheck && indicatorParamsCheck.ok === false && indicatorParamsCheck.reason}
            <p class="kc-field-error" role="alert">{indicatorParamsCheck.reason}</p>
          {:else if indicatorParamsCheck?.hint}
            <p class="kc-field-hint">{indicatorParamsCheck.hint}</p>
          {/if}
        </div>
        <div class="kc-dialog-footer">
          <button class="kc-button kc-button-primary" disabled={indicatorParamsCheck?.ok === false || indicatorParamsChecking} onclick={() => {
            const config = indicatorSettingsFor(indicatorSettings.indicatorName)
            const params = indicatorSettings.calcParams.map((value, index) => value === '' || value == null ? config[index]?.default : value)
            const targetPane = wall.panes.find((item) => item.id === indicatorSettings.paneId)
            targetPane?.api?.chart.overrideIndicator({
              name: indicatorSettings.indicatorName,
              paneId: indicatorSettings.chartPaneId,
              calcParams: params
            })
            indicatorSettingsOpen = false
          }}>{i18n('confirm', locale)}</button>
        </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>

    <Dialog.Root bind:open={screenshotDialogOpen}>
      <Dialog.Portal {...portalProps}>
        <Dialog.Overlay class="kc-dialog-overlay" />
        <Dialog.Content class="kc-dialog-content kc-dialog-2xl">
          <div class="kc-dialog-header">
          <Dialog.Title>{i18n('screenshot', locale)}</Dialog.Title>
          <Dialog.Description>{wall.active.symbol.ticker} · {wall.active.period.text}</Dialog.Description>
          </div>
          <Dialog.Close class="kc-button kc-icon-button kc-dialog-close" aria-label="Close"><XIcon /></Dialog.Close>
        {#if screenshotUrl}
          <img class="kc-screenshot" src={screenshotUrl} alt={`${wall.active.symbol.ticker} chart screenshot`} />
        {:else}
          <div class="kc-empty">{i18n('no_data', locale)}</div>
        {/if}
        <div class="kc-dialog-footer">
          <button class="kc-button kc-button-primary" disabled={!screenshotUrl} onclick={saveScreenshot}>{i18n('save', locale)}</button>
        </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </Tooltip.Provider>
</div>
