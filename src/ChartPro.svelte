<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
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
  import CandlestickIcon from '@lucide/svelte/icons/chart-candlestick'
  import ClockIcon from '@lucide/svelte/icons/clock'
  import EllipsisIcon from '@lucide/svelte/icons/ellipsis'
  import MatrixIcon from '@lucide/svelte/icons/grid-3x3'
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
    ChartProSlot,
    Datafeed,
    DatafeedFactory,
    IndicatorParamsCheck,
    PaneOptions,
    PaneSnapshot,
    Period,
    SymbolInfo
  } from './types'
  import { indicatorSettingsFor } from './config/indicators'
  import { fitWall, panePlacement } from './config/fit'
  import { NARROW_SHELL_WIDTH, shellSize } from './config/responsive'
  import { getOptions } from './config/settings'
  import {
    createTimezoneSelectOptions,
    translateTimezone
  } from './config/timezones'
  import ChartPane from './ChartPane.svelte'
  import IndicatorManager from './IndicatorManager.svelte'
  import LayoutPicker from './LayoutPicker.svelte'
  import type { IndicatorRow } from './state/indicatorMatrix'
  import { Wall } from './state/wall.svelte'
  import { clone } from './utils/object'
  import { SyncBus } from './sync/bus'
  import { samePeriod, sameSymbol } from './sync/follow'
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
    syncSymbol,
    syncPeriod,
    onPaneLayoutChange,
    onActivePaneChange,
    onPaneStateChange,
    onPanesChange,
    onSymbolChange,
    onPeriodChange,
    onSyncChange
  }: ChartProps = $props()

  let rootElement = $state<HTMLDivElement>()
  let toolbarSlot = $state<HTMLDivElement>()
  // Pinned to the right edge of the same rail -- see ChartProSlot in src/types.ts.
  let toolbarRightSlot = $state<HTMLDivElement>()
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
  let syncSymbolEnabled = $state(untrack(() => syncSymbol))
  let syncPeriodEnabled = $state(untrack(() => syncPeriod))

  let symbolDialogOpen = $state(false)
  let indicatorDialogOpen = $state(false)
  let indicatorManagerOpen = $state(false)
  let timezoneDialogOpen = $state(false)
  let settingsDialogOpen = $state(false)
  let screenshotDialogOpen = $state(false)
  let indicatorSettingsOpen = $state(false)
  let screenshotUrl = $state('')

  let symbolQuery = $state('')
  let symbolResults = $state<SymbolInfo[]>([])
  let symbolSearching = $state(false)
  // The search box itself, so opening the dialog can put the caret in it. The dialog's own
  // open-focus lands on the first tabbable child, which is the close button -- the user has
  // to click or Tab before typing, every time. Bound here rather than reached for with a
  // querySelector because the dialog is portalled outside this component's DOM.
  let symbolInput = $state<HTMLInputElement | null>(null)
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
  // iPhone Safari has no element fullscreen at all (only video), and a button that does
  // nothing when tapped reads as broken.
  const fullscreenSupported = typeof document !== 'undefined' && Boolean(document.fullscreenEnabled)

  // -- Responsive layout ------------------------------------------------------------------
  // Three measurements, each answering one question (see src/config/responsive.ts for why
  // they are measured rather than container-queried):
  //   the shell  -- which size class: how dialogs sit, whether the rail overlays the chart;
  //   the wall   -- whether the layout preset can be drawn as declared (src/config/fit.ts);
  //   the toolbar -- how much of it has to fold away, which depends on the app's own slots.
  let shellWidth = $state(0)
  let shellHeight = $state(0)
  let wallElement = $state<HTMLDivElement>()
  let wallWidth = $state(0)
  let wallHeight = $state(0)
  let toolbarElement = $state<HTMLElement>()
  let paneStrip = $state<HTMLDivElement>()
  const size = $derived(shellSize(shellWidth, shellHeight))
  const narrow = $derived(shellWidth > 0 && shellWidth < NARROW_SHELL_WIDTH)

  // How much of the toolbar is folded: 0 everything inline; 1 the icon actions (layout, the
  // sync switches, indicators, timezone, settings, screenshot, fullscreen) move into one
  // "more" menu; 2 the starred period chips go too -- the timeframe dropdown beside them
  // still shows and picks the period -- and the symbol button shows only its ticker. Chosen
  // as the least folding under which nothing overflows, by trying each in turn: the width
  // the app's slots take (the workspace switcher's name, however many layer toggles) is not
  // known to this component, and a fixed breakpoint would be wrong for every app but one.
  // Past tier 2 the toolbar scrolls sideways rather than clipping (app.css).
  const TOOLBAR_TIERS = 2
  let toolbarTier = $state(0)
  let toolbarFitSeq = 0
  let toolbarMeasured = ''
  async function fitToolbar(force = false): Promise<void> {
    const element = toolbarElement
    if (!element) return
    // The loop guard: nothing in the slots is styled by tier, so if neither the toolbar's
    // width nor either slot's has changed, the answer has not either. Without it a slot's
    // own ResizeObserver notification would re-run the fit that caused it, every frame.
    const key = `${element.clientWidth}:${toolbarSlot?.offsetWidth ?? 0}:${toolbarRightSlot?.offsetWidth ?? 0}`
    if (!force && key === toolbarMeasured) return
    toolbarMeasured = key
    const seq = ++toolbarFitSeq
    // Every step is a microtask, so the tiers tried and rejected here are laid out and
    // measured but never painted.
    for (let tier = 0; tier <= TOOLBAR_TIERS; tier++) {
      toolbarTier = tier
      await tick()
      if (seq !== toolbarFitSeq) return
      if (element.scrollWidth - element.clientWidth <= 1) return
    }
  }

  // A shell wide enough to span displays opens its dialogs over the active pane (app.css,
  // `[data-size='wide']`), measured when a dialog opens -- where the user is working is the
  // pane they last touched, and the middle of a window across two monitors is the bezel.
  let dialogAnchorX = $state<number | null>(null)

  let overlayMode = $state<OverlayMode>('normal')
  let overlaysLocked = $state(false)
  let overlaysVisible = $state(true)

  // The settings dialog's heading: a template's registered name unless the locale gives it a
  // display label (i18n passes an unknown key through, so the name is the fallback).
  function indicatorTitle(name: string): string {
    const key = `indicator_title_${name}`
    const title = i18n(key, locale)
    return title === key ? name : title
  }

  // The indicator manager's row heading: an app group's own label for its templates (an
  // `S:<name>@<version>` name means nothing on screen), else the picker's locale label for a
  // built-in, else the settings dialog's title.
  const groupLabels = $derived(new Map(
    (indicatorGroups ?? []).flatMap((group) => group.items.map((item) => [`${group.main}:${item.name}`, item.label] as const))
  ))
  function indicatorRowLabel(row: IndicatorRow): string {
    const grouped = groupLabels.get(`${row.main}:${row.name}`)
    if (grouped) return grouped
    const key = row.name.toLowerCase()
    const label = i18n(key, locale)
    return label === key ? indicatorTitle(row.name) : label
  }

  const mainIndicatorNames = ['MA', 'EMA', 'WMA', 'SMA', 'BOLL', 'SAR', 'BBI', 'SWING', 'SESSIONS']
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

  // How the wall's preset is drawn in the room it has now -- see src/config/fit.ts.
  const fit = $derived(fitWall(wall.layout, wallWidth, wallHeight))
  const gridStyle = $derived.by(() => {
    if (fit.mode === 'preset') {
      return `grid-template-areas: ${wall.layout.gridTemplateAreas}; grid-template-columns: ${wall.layout.gridTemplateColumns}; grid-template-rows: ${wall.layout.gridTemplateRows};`
    }
    if (fit.mode === 'reflow') {
      return `grid-template-columns: repeat(${fit.columns}, minmax(0, 1fr)); grid-template-rows: repeat(${fit.rows}, minmax(0, 1fr));`
    }
    return 'grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr);'
  })

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

  const toolbarActions = $derived([
    { label: i18n('indicator', locale), icon: ChartIcon, action: () => { indicatorDialogOpen = true } },
    { label: i18n('timezone', locale), icon: GlobeIcon, action: () => { timezoneDialogOpen = true } },
    { label: i18n('setting', locale), icon: SettingsIcon, action: openSettings },
    { label: i18n('screenshot', locale), icon: CameraIcon, action: takeScreenshot }
  ])

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
  export function getSlot(name: ChartProSlot) {
    switch (name) {
      case 'toolbar': return toolbarSlot ?? null
      case 'toolbar-right': return toolbarRightSlot ?? null
      default: return railFooterSlot ?? null
    }
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

    // One observer for every box the layout reads. None of what it writes resizes an
    // observed box at the same depth or shallower -- the toolbar is a fixed height whatever
    // its tier, and a fit change resizes the panes INSIDE the wall -- so it cannot feed a
    // ResizeObserver loop.
    const observer = new ResizeObserver(() => {
      if (rootElement) {
        shellWidth = rootElement.clientWidth
        shellHeight = rootElement.clientHeight
      }
      if (wallElement) {
        wallWidth = wallElement.clientWidth
        wallHeight = wallElement.clientHeight
      }
      void fitToolbar()
    })
    for (const element of [rootElement, wallElement, toolbarElement, toolbarSlot, toolbarRightSlot]) {
      if (element) observer.observe(element)
    }

    return () => {
      observer.disconnect()
      document.removeEventListener('fullscreenchange', handleFullscreen)
      bus.dispose()
    }
  })

  // What the observer cannot see: the symbol button and the period chips change width with
  // the active pane's instrument and timeframe, and neither is observed (both are styled by
  // tier, which is exactly what the guard in fitToolbar cannot allow).
  $effect(() => {
    void wall.active.symbol
    void railPeriods.length
    untrack(() => { void fitToolbar(true) })
  })

  // On a one-pane-at-a-time wall the strip scrolls sideways; keep the active tab in view,
  // including after the active pane changed from somewhere else (a restored wall).
  $effect(() => {
    if (fit.mode !== 'single' || !paneStrip) return
    const activeId = wall.activeId
    untrack(() => {
      paneStrip
        ?.querySelector<HTMLElement>(`[data-pane-tab="${activeId}"]`)
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
  })

  $effect(() => {
    // Not the indicator manager: it is about the whole wall, and centres on the shell.
    const open = symbolDialogOpen || indicatorDialogOpen || timezoneDialogOpen ||
      settingsDialogOpen || screenshotDialogOpen || indicatorSettingsOpen
    if (!open || size !== 'wide') {
      dialogAnchorX = null
      return
    }
    const activeId = wall.activeId
    untrack(() => {
      const paneElement = rootElement?.querySelector<HTMLElement>(`.klinecharts-pro-pane[data-pane-id="${activeId}"]`)
      if (!rootElement || !paneElement) return
      const shell = rootElement.getBoundingClientRect()
      const rect = paneElement.getBoundingClientRect()
      dialogAnchorX = rect.left + rect.width / 2 - shell.left
    })
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
      auto: syncAutoEnabled,
      symbol: syncSymbolEnabled,
      period: syncPeriodEnabled
    })
    const turnedOn = syncAutoEnabled && !syncAutoWas
    syncAutoWas = syncAutoEnabled
    // Switching auto sync on aligns the wall immediately, to the ACTIVE pane. Waiting for the
    // next drag would leave a mode called "sync" changing nothing at the moment it is turned
    // on, and leave the user to guess which pane the others will eventually follow.
    if (turnedOn) bus.alignTo(untrack(() => wall.activeId))
  })

  // Symbol and timeframe sync are INVARIANTS while on, not one-shot copies -- every visible
  // pane shows what the ACTIVE one shows. Stated this way rather than as a fan-out at each
  // toolbar click, one statement covers all four moments it has to hold at: the switch being
  // turned on (which aligns the wall there and then, the sync_auto precedent), a symbol or
  // timeframe picked afterwards, a layout GROW -- whose new panes would otherwise arrive on
  // whatever they were last seeded with -- and a wall restored with the switch already on.
  //
  // The panes' own symbols are read inside `untrack`: what this effect writes is exactly what
  // it would read back, so tracking them would re-run it on its own writes for a fixed point
  // it has already reached. Only the SOURCE -- the active pane's symbol, and which panes are
  // visible -- is tracked.
  $effect(() => {
    if (!syncSymbolEnabled) return
    const panes = wall.visiblePanes
    const symbol = wall.active.symbol
    if (!symbol) return
    untrack(() => {
      for (const pane of panes) {
        if (pane.id === wall.activeId || sameSymbol(pane.symbol, symbol)) continue
        pane.symbol = symbol
        onSymbolChange(pane.id, symbol)
      }
    })
  })

  $effect(() => {
    if (!syncPeriodEnabled) return
    const panes = wall.visiblePanes
    const period = wall.active.period
    if (!period) return
    untrack(() => {
      for (const pane of panes) {
        if (pane.id === wall.activeId || samePeriod(pane.period, period)) continue
        pane.period = period
        onPeriodChange(pane.id, period)
      }
    })
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

<div
  bind:this={rootElement}
  class="klinecharts-pro-shell"
  data-size={size}
  style={dialogAnchorX === null ? undefined : `--kc-dialog-anchor-x: ${dialogAnchorX}px;`}
>
  <Tooltip.Provider delayDuration={250}>
    <header class="kc-toolbar" bind:this={toolbarElement} data-tier={toolbarTier}>
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
        <span class="kc-truncate">{toolbarTier >= 2 ? wall.active.symbol.ticker : (wall.active.symbol.shortName ?? wall.active.symbol.name ?? wall.active.symbol.ticker)}</span>
        <SearchIcon />
      </button>

      {#if toolbarTier < 2}
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
      {/if}

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

      {#if toolbarTier >= 1}
      <!-- The same controls, folded: the layout presets and every sync switch inline, the
           dialogs and fullscreen as labelled rows. A label is affordable here and an icon
           alone is not -- there is no hover to reveal a tooltip on the touch screens this is
           most often shown on. Folded, it comes BEFORE the app's slot: on a phone the rail
           may still have to scroll sideways, and what scrolls out of view should be the app's
           extras rather than the menu holding the chart's own controls. -->
      <Popover.Root>
        <Tooltip.Root>
          <Tooltip.Trigger>
            {#snippet child({ props })}
              <Popover.Trigger {...props} class={iconButtonClass(syncSymbolEnabled || syncPeriodEnabled || syncAutoEnabled)} aria-label={i18n('more', locale)}>
                <EllipsisIcon />
              </Popover.Trigger>
            {/snippet}
          </Tooltip.Trigger>
          <Tooltip.Portal {...portalProps}>
            <Tooltip.Content class="kc-tooltip">{i18n('more', locale)}</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <Popover.Portal {...portalProps}>
          <Popover.Content align="end" sideOffset={4} collisionPadding={8} class="kc-popover kc-more-popover">
            <div class="kc-popover-header">{i18n('layout', locale)}</div>
            <LayoutPicker {wall} {locale} {portalProps} inline />
            <div class="kc-menu-list">
              <Popover.Close class="kc-button kc-menu-item" onclick={() => { setTimeout(() => { indicatorManagerOpen = true }, 0) }}>
                <MatrixIcon />
                <span>{i18n('indicator_manager', locale)}</span>
              </Popover.Close>
            </div>
            <Separator.Root class="kc-separator kc-menu-separator" />
            <div class="kc-popover-header">{i18n('sync', locale)}</div>
            <div class="kc-field-group kc-menu-fields">
              {#each [
                { id: 'symbol', label: i18n('sync_symbol', locale), checked: syncSymbolEnabled, disabled: false, set: (on: boolean) => { syncSymbolEnabled = on } },
                { id: 'period', label: i18n('sync_period', locale), checked: syncPeriodEnabled, disabled: false, set: (on: boolean) => { syncPeriodEnabled = on } },
                { id: 'auto', label: i18n('sync_auto', locale), checked: syncAutoEnabled, disabled: false, set: (on: boolean) => { syncAutoEnabled = on } },
                { id: 'crosshair', label: i18n('sync_crosshair', locale), checked: syncCrosshairEnabled, disabled: false, set: (on: boolean) => { syncCrosshairEnabled = on } },
                { id: 'time', label: i18n('sync_time', locale), checked: syncTimeEnabled && !syncAutoEnabled, disabled: syncAutoEnabled, set: (on: boolean) => { syncTimeEnabled = on } }
              ] as item (item.id)}
                <div class="kc-field kc-field-horizontal">
                  <label for={`more-sync-${item.id}`}>{item.label}</label>
                  <Switch.Root class="kc-switch" id={`more-sync-${item.id}`} disabled={item.disabled} checked={item.checked} onCheckedChange={item.set}>
                    <Switch.Thumb class="kc-switch-thumb" />
                  </Switch.Root>
                </div>
              {/each}
              {#if syncAutoEnabled}
                <p class="kc-field-hint">{i18n('sync_time_auto_hint', locale)}</p>
              {/if}
            </div>
            <Separator.Root class="kc-separator kc-menu-separator" />
            <div class="kc-menu-list">
              {#each toolbarActions as action (action.label)}
                {@const ActionIcon = action.icon}
                <!-- Closed first, then the dialog opened: a dialog opened while the popover
                     is still dismissing has its open-focus taken back by the popover's
                     return-focus to this trigger. -->
                <Popover.Close class="kc-button kc-menu-item" onclick={() => { setTimeout(action.action, 0) }}>
                  <ActionIcon />
                  <span>{action.label}</span>
                </Popover.Close>
              {/each}
              {#if fullscreenSupported}
                <Popover.Close class="kc-button kc-menu-item" onclick={toggleFullscreen}>
                  {#if fullscreen}<MinimizeIcon />{:else}<MaximizeIcon />{/if}
                  <span>{i18n(fullscreen ? 'exit_full_screen' : 'full_screen', locale)}</span>
                </Popover.Close>
              {/if}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {/if}

      <div class="kc-toolbar-slot" bind:this={toolbarSlot}></div>

      {#if toolbarTier < 1}
      <div class="kc-toolbar-actions">
        <LayoutPicker {wall} {locale} {portalProps} />
        <!-- Beside the layout, not among the active-pane actions: the manager acts on every pane
             of the wall at once, so it belongs with the controls that do. -->
        <Tooltip.Root>
          <Tooltip.Trigger class={iconButtonClass()} onclick={() => { indicatorManagerOpen = true }} aria-label={i18n('indicator_manager', locale)}>
            <MatrixIcon />
          </Tooltip.Trigger>
          <Tooltip.Portal {...portalProps}>
            <Tooltip.Content class="kc-tooltip">{i18n('indicator_manager', locale)}</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        <!-- The three wall-wide switches, in the order they narrow what a pane may differ by:
             the instrument, then the timeframe, then where on the time axis it is looking.
             The two in the popover beside them (crosshair, click to scroll) stay there --
             those follow a POINTER, and are worth a click of their own to reach. -->
        {#each [
          {
            label: i18n('sync_symbol', locale),
            icon: CandlestickIcon,
            active: syncSymbolEnabled,
            toggle: () => { syncSymbolEnabled = !syncSymbolEnabled }
          },
          {
            label: i18n('sync_period', locale),
            icon: ClockIcon,
            active: syncPeriodEnabled,
            toggle: () => { syncPeriodEnabled = !syncPeriodEnabled }
          },
          {
            label: i18n('sync_auto', locale),
            icon: ArrowLeftRightIcon,
            active: syncAutoEnabled,
            toggle: () => { syncAutoEnabled = !syncAutoEnabled }
          }
        ] as item (item.label)}
          {@const ToggleIcon = item.icon}
          <Tooltip.Root>
            <Tooltip.Trigger
              class={iconButtonClass(item.active)}
              aria-pressed={item.active}
              aria-label={item.label}
              onclick={item.toggle}
            >
              <ToggleIcon />
            </Tooltip.Trigger>
            <Tooltip.Portal {...portalProps}>
              <Tooltip.Content class="kc-tooltip">{item.label}</Tooltip.Content>
            </Tooltip.Portal>
          </Tooltip.Root>
        {/each}
        <SyncToggle
          bind:crosshair={syncCrosshairEnabled}
          bind:time={syncTimeEnabled}
          auto={syncAutoEnabled}
          {locale}
          {portalProps}
        />
        {#each toolbarActions as action (action.label)}
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
        {#if fullscreenSupported}
        <Tooltip.Root>
          <Tooltip.Trigger class={iconButtonClass()} onclick={toggleFullscreen} aria-label={i18n(fullscreen ? 'exit_full_screen' : 'full_screen', locale)}>
            {#if fullscreen}<MinimizeIcon />{:else}<MaximizeIcon />{/if}
          </Tooltip.Trigger>
          <Tooltip.Portal {...portalProps}>
            <Tooltip.Content class="kc-tooltip">{i18n(fullscreen ? 'exit_full_screen' : 'full_screen', locale)}</Tooltip.Content>
          </Tooltip.Portal>
        </Tooltip.Root>
        {/if}
      </div>
      {/if}

      <div class="kc-toolbar-right-slot" bind:this={toolbarRightSlot}></div>
    </header>

    <div class="klinecharts-pro-chart-area">
      {#if drawingBarVisible}
        <!-- On a narrow shell the rail overlays the chart rather than taking a column from
             it: 48px of a 390px phone is an eighth of every pane, and toggling it would
             otherwise resize -- and re-layout -- every chart on the wall. -->
        <aside class={`kc-drawing-toolbar${narrow ? ' is-overlay' : ''}`}>
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

      <div class="kc-wall" bind:this={wallElement}>
      {#if fit.mode === 'single'}
        <!-- One pane at a time (src/config/fit.ts): the others are still mounted and live
             behind it, and a tab brings one forward by making it the active pane -- which is
             also what every toolbar control already acts on. -->
        <div class="kc-pane-strip" role="tablist" aria-label={i18n('panes', locale)} bind:this={paneStrip}>
          {#each wall.visiblePanes as pane, index (pane.id)}
            <button
              type="button"
              role="tab"
              class="kc-pane-tab"
              data-pane-tab={pane.id}
              aria-selected={pane.id === wall.activeId}
              onclick={() => wall.activate(pane.id)}
            >
              <span class="kc-pane-tab-index">{index + 1}</span>
              <span class="kc-truncate">{pane.symbol?.shortName ?? pane.symbol?.ticker ?? ''}</span>
              <span class="kc-pane-tab-period">{pane.period?.text ?? ''}</span>
            </button>
          {/each}
        </div>
      {/if}
      <div
        class="klinecharts-pro-grid"
        data-pane-count={wall.layout.paneCount}
        data-fit={fit.mode}
        style={gridStyle}
      >
        {#each wall.visiblePanes as pane, index (pane.id)}
          <ChartPane
            {pane}
            active={pane.id === wall.activeId}
            placement={fit.mode === 'preset' ? undefined : panePlacement(fit, index, wall.visiblePanes.length, pane.id)}
            concealed={fit.mode === 'single' && pane.id !== wall.activeId}
            {theme}
            {styles}
            {locale}
            {timezone}
            {periods}
            {bus}
            onActivate={(id) => wall.activate(id)}
            onStateChange={onPaneStateChange}
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
    </div>

    <Dialog.Root bind:open={symbolDialogOpen}>
      <Dialog.Portal {...portalProps}>
        <Dialog.Overlay class="kc-dialog-overlay" />
        <Dialog.Content class="kc-dialog-content kc-dialog-lg" onOpenAutoFocus={(event) => {
          // Take over the dialog's default open-focus so the search box gets it. `select()`
          // as well as focus: reopening keeps the previous query, and a query that is
          // replaced by the first keystroke is friendlier than one the user must clear.
          event.preventDefault()
          symbolInput?.focus()
          symbolInput?.select()
        }}>
          <div class="kc-dialog-header">
          <Dialog.Title>{i18n('symbol_search', locale)}</Dialog.Title>
          <Dialog.Description>{i18n('symbol_code', locale)}</Dialog.Description>
          </div>
          <Dialog.Close class="kc-button kc-icon-button kc-dialog-close" aria-label="Close"><XIcon /></Dialog.Close>
        <Command.Root shouldFilter={false} class="kc-command">
          <div class="kc-command-input-wrap"><SearchIcon /><Command.Input class="kc-command-input" bind:ref={symbolInput} bind:value={symbolQuery} placeholder={i18n('symbol_code', locale)} /></div>
          <Command.List class="kc-command-list">
            {#if symbolSearching}<Command.Loading class="kc-command-loading"><LoaderCircleIcon class="kc-spinner" /></Command.Loading>{/if}
            {#if !symbolSearching && symbolResults.length === 0}
              <Command.Empty class="kc-command-empty">{i18n('no_data', locale)}</Command.Empty>
            {/if}
            <Command.Group class="kc-command-group" value={i18n('symbol_search', locale)}>
              <Command.GroupHeading class="kc-command-heading">{i18n('symbol_search', locale)}</Command.GroupHeading>
              <Command.GroupItems>
                {#each symbolResults as item (`${item.exchange ?? ''}:${item.ticker}`)}
                  <Command.Item class="kc-command-item" value={`${item.exchange ?? ''}:${item.ticker}`} onclick={() => {
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
          {#each indicatorGroups as group, groupIndex (`${group.main}|${group.label}`)}
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

    <IndicatorManager
      bind:open={indicatorManagerOpen}
      panes={wall.visiblePanes}
      activeId={wall.activeId}
      {locale}
      {portalProps}
      labelFor={indicatorRowLabel}
    />

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
          <Dialog.Title>{indicatorTitle(indicatorSettings.indicatorName)}</Dialog.Title>
          <Dialog.Description>{i18n('indicator', locale)}</Dialog.Description>
          </div>
          <Dialog.Close class="kc-button kc-icon-button kc-dialog-close" aria-label="Close"><XIcon /></Dialog.Close>
        <div class="kc-field-group">
          {#each indicatorSettingsFor(indicatorSettings.indicatorName) as config, index (config.paramNameKey)}
            <div class="kc-field">
              <label for={`indicator-param-${index}`}>{i18n(config.paramNameKey, locale)}</label>
              <input class="kc-input" id={`indicator-param-${index}`} type="number" min={config.min} max={config.max} step={10 ** -config.precision} value={String(indicatorSettings.calcParams[index] ?? '')} oninput={(event) => {
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
            // Not chart.overrideIndicator directly: the pane records the parameters on its own
            // state and reports the change, which is what makes an MA(50) still an MA(50)
            // after a reload.
            targetPane?.api?.setIndicatorParams(
              indicatorSettings.chartPaneId,
              indicatorSettings.indicatorName,
              params
            )
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
