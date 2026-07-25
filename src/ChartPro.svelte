<script lang="ts">
  import { onMount, type Component } from 'svelte'
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
    type Styles,
    type SymbolInfo as ChartSymbolInfo,
    type TooltipFeatureStyle
  } from 'klinecharts'
  import cloneDeep from 'lodash/cloneDeep'
  import set from 'lodash/set'

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

  import { Button, buttonVariants } from '$lib/components/ui/button'
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Field from '$lib/components/ui/field'
  import { Input } from '$lib/components/ui/input'
  import * as Select from '$lib/components/ui/select'
  import { Switch } from '$lib/components/ui/switch'
  import { Checkbox } from '$lib/components/ui/checkbox'
  import * as Command from '$lib/components/ui/command'
  import * as Popover from '$lib/components/ui/popover'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import * as ToggleGroup from '$lib/components/ui/toggle-group'
  import * as ScrollArea from '$lib/components/ui/scroll-area'
  import * as Avatar from '$lib/components/ui/avatar'
  import { Spinner } from '$lib/components/ui/spinner'
  import { Separator } from '$lib/components/ui/separator'
  import * as Empty from '$lib/components/ui/empty'

  import i18n from './i18n'
  import type { ChartProOptions, Period, SymbolInfo } from './types'
  import indicatorConfig from './config/indicators'
  import { getOptions } from './config/settings'
  import {
    createTimezoneSelectOptions,
    translateTimezone
  } from './config/timezones'

  type ChartProps = Required<Omit<ChartProOptions, 'container'>>
  type DrawingTool = {
    name: string
    labelKey: string
    icon: Component
  }
  type DrawingGroup = {
    labelKey: string
    icon: Component
    tools: DrawingTool[]
  }
  type IndicatorFeatureClick = {
    paneId: string
    feature: TooltipFeatureStyle
    indicator: Indicator
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
    timezone,
    mainIndicators,
    subIndicators: initialSubIndicators,
    datafeed
  }: ChartProps = $props()

  let rootElement = $state<HTMLDivElement>()
  let widgetElement: HTMLDivElement
  let widget: Nullable<Chart> = null
  let priceUnitElement: HTMLElement | null = null
  let mounted = $state(false)

  let subIndicators = $state<Record<string, string>>({})
  let defaultStyles: Styles | null = null
  let loading = $state(false)
  let selectedPeriodText = $state('')

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
  let yAxisType = $state('normal')
  let yAxisReverse = $state(false)
  let indicatorSettings = $state({
    indicatorName: '',
    paneId: '',
    calcParams: [] as unknown[]
  })
  let fullscreen = $state(false)

  let overlayMode = $state<OverlayMode>('normal')
  let overlaysLocked = $state(false)
  let overlaysVisible = $state(true)

  const mainIndicatorNames = ['MA', 'EMA', 'SMA', 'BOLL', 'SAR', 'BBI']
  const subIndicatorNames = [
    'MA', 'EMA', 'VOL', 'MACD', 'BOLL', 'KDJ', 'RSI', 'BIAS', 'BRAR', 'CCI',
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

  const portalProps = $derived(rootElement ? { to: rootElement } : undefined)
  const timezoneOptions = $derived(createTimezoneSelectOptions(locale))
  const settingOptions = $derived(getOptions(locale))

  function createIndicator(
    indicatorName: string,
    isStack?: boolean,
    paneId?: string
  ): Nullable<string> {
    if (!widget) return null
    const indicatorId = widget.createIndicator({
      name: indicatorName,
      paneId,
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

  function adjustFromTo(currentPeriod: Period, toTimestamp: number, count: number) {
    const minute = 60 * 1000
    const hour = 60 * minute
    const day = 24 * hour
    let to = toTimestamp
    let from = to

    switch (currentPeriod.timespan) {
      case 'minute':
        to -= to % minute
        from = to - count * currentPeriod.multiplier * minute
        break
      case 'hour':
        to -= to % hour
        from = to - count * currentPeriod.multiplier * hour
        break
      case 'day':
        to -= to % day
        from = to - count * currentPeriod.multiplier * day
        break
      case 'week': {
        const date = new Date(to)
        const offset = date.getDay() === 0 ? 6 : date.getDay() - 1
        date.setHours(0, 0, 0, 0)
        date.setDate(date.getDate() - offset)
        to = date.getTime()
        from = to - count * currentPeriod.multiplier * 7 * day
        break
      }
      case 'month': {
        const date = new Date(to)
        date.setHours(0, 0, 0, 0)
        date.setDate(1)
        to = date.getTime()
        date.setMonth(date.getMonth() - count * currentPeriod.multiplier)
        from = date.getTime()
        break
      }
      case 'year': {
        const date = new Date(to)
        date.setHours(0, 0, 0, 0)
        date.setMonth(0, 1)
        to = date.getTime()
        date.setFullYear(date.getFullYear() - count * currentPeriod.multiplier)
        from = date.getTime()
        break
      }
    }
    return [from, to] as const
  }

  function formatDate({ dateTimeFormat, timestamp, type }: FormatDateParams) {
    if (period.timespan === 'minute') {
      return utils.formatDate(dateTimeFormat, timestamp, type === 'xAxis'
        ? 'HH:mm' : 'YYYY-MM-DD HH:mm')
    }
    if (period.timespan === 'hour') {
      return utils.formatDate(dateTimeFormat, timestamp, type === 'xAxis'
        ? 'MM-DD HH:mm' : 'YYYY-MM-DD HH:mm')
    }
    if (period.timespan === 'month') {
      return utils.formatDate(dateTimeFormat, timestamp, type === 'xAxis'
        ? 'YYYY-MM' : 'YYYY-MM-DD')
    }
    if (period.timespan === 'year') {
      return utils.formatDate(dateTimeFormat, timestamp, type === 'xAxis'
        ? 'YYYY' : 'YYYY-MM-DD')
    }
    return utils.formatDate(dateTimeFormat, timestamp, 'YYYY-MM-DD')
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
            icon('visible', '\ue903', 8),
            icon('invisible', '\ue901', 8),
            icon('setting', '\ue902'),
            icon('close', '\ue900')
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
      loading = true
      const currentPeriod = fromChartPeriod(chartPeriod)
      const toTimestamp = type === 'forward' && timestamp ? timestamp - 1 : Date.now()
      const [from, to] = adjustFromTo(currentPeriod, toTimestamp, 500)
      try {
        const data = await datafeed.getHistoryKLineData(
          chartSymbol as SymbolInfo,
          currentPeriod,
          from,
          to
        )
        callback(data, { forward: data.length > 0, backward: false })
      } finally {
        loading = false
      }
    },
    subscribeBar({ symbol: chartSymbol, period: chartPeriod, callback }) {
      datafeed.subscribe(chartSymbol as SymbolInfo, fromChartPeriod(chartPeriod), callback)
    },
    unsubscribeBar({ symbol: chartSymbol, period: chartPeriod }) {
      datafeed.unsubscribe(chartSymbol as SymbolInfo, fromChartPeriod(chartPeriod))
    }
  }

  function changeIndicator(name: string, main: boolean, added: boolean) {
    if (main) {
      if (added) {
        createIndicator(name, true, 'candle_pane')
        mainIndicators = [...mainIndicators, name]
      } else {
        widget?.removeIndicator({ paneId: 'candle_pane', name })
        mainIndicators = mainIndicators.filter((item) => item !== name)
      }
      return
    }

    if (added) {
      const paneId = createIndicator(name)
      if (paneId) subIndicators = { ...subIndicators, [name]: paneId }
    } else if (subIndicators[name]) {
      widget?.removeIndicator({ paneId: subIndicators[name], name })
      const next = { ...subIndicators }
      delete next[name]
      subIndicators = next
    }
  }

  function openSettings() {
    if (!widget) return
    settingsStyles = cloneDeep(widget.getStyles())
    settingsDialogOpen = true
  }

  function getSettingValue(key: string): unknown {
    if (key === 'yAxis.type') return yAxisType
    if (key === 'yAxis.reverse') return yAxisReverse
    return utils.formatValue(settingsStyles, key)
  }

  function applyYAxisSettings(paneId?: string) {
    if (!widget) return
    const paneIds = paneId
      ? [paneId]
      : ['candle_pane', ...Object.values(subIndicators)]
    for (const id of new Set(paneIds)) {
      widget.overrideYAxis({ paneId: id, name: yAxisType, reverse: yAxisReverse })
    }
  }

  function updateStyle(key: string, value: unknown) {
    if (!settingsStyles) return
    if (key === 'yAxis.type') {
      yAxisType = String(value)
      applyYAxisSettings()
      return
    }
    if (key === 'yAxis.reverse') {
      yAxisReverse = Boolean(value)
      applyYAxisSettings()
      return
    }
    const patch = {}
    set(patch, key, value)
    const next = cloneDeep(settingsStyles)
    set(next, key, value)
    settingsStyles = next
    widget?.setStyles(patch)
  }

  function restoreStyles() {
    if (!defaultStyles) return
    const patch = {}
    for (const option of settingOptions) {
      if (option.key.startsWith('yAxis.')) continue
      set(patch, option.key, utils.formatValue(defaultStyles, option.key))
    }
    widget?.setStyles(patch)
    yAxisType = 'normal'
    yAxisReverse = false
    applyYAxisSettings()
    settingsStyles = cloneDeep(widget?.getStyles() ?? defaultStyles)
  }

  function createOverlay(tool: DrawingTool) {
    widget?.createOverlay({
      groupId: 'drawing_tools',
      name: tool.name,
      visible: overlaysVisible,
      lock: overlaysLocked,
      mode: overlayMode
    } as OverlayCreate)
  }

  function takeScreenshot() {
    if (!widget) return
    screenshotUrl = widget.getConvertPictureUrl(
      true,
      'jpeg',
      theme === 'dark' ? '#171717' : '#ffffff'
    )
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

  export function setTheme(value: string) { theme = value }
  export function getTheme() { return theme }
  export function setStyles(value: DeepPartial<Styles>) { styles = value }
  export function getStyles() { return widget?.getStyles() as Styles }
  export function setLocale(value: string) { locale = value }
  export function getLocale() { return locale }
  export function setTimezone(value: string) { timezone = value }
  export function getTimezone() { return timezone }
  export function setSymbol(value: SymbolInfo) { symbol = value }
  export function getSymbol() { return symbol }
  export function setPeriod(value: Period) { period = value }
  export function getPeriod() { return period }

  $effect(() => {
    selectedPeriodText = period.text
  })

  $effect(() => {
    if (!mounted) return
    widget?.setSymbol(toChartSymbol(symbol))
  })

  $effect(() => {
    if (!mounted) return
    widget?.setPeriod(toChartPeriod(period))
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
    priceUnitElement.textContent = symbol.priceCurrency?.toLocaleUpperCase() ?? ''
    priceUnitElement.style.display = symbol.priceCurrency ? 'flex' : 'none'
  })

  $effect(() => {
    if (!symbolDialogOpen) return
    const query = symbolQuery
    const timer = window.setTimeout(async () => {
      symbolSearching = true
      try {
        symbolResults = await datafeed.searchSymbols(query)
      } finally {
        symbolSearching = false
      }
    }, 180)
    return () => window.clearTimeout(timer)
  })

  onMount(() => {
    const handleResize = () => widget?.resize()
    const handleFullscreen = () => { fullscreen = Boolean(document.fullscreenElement) }
    window.addEventListener('resize', handleResize)
    document.addEventListener('fullscreenchange', handleFullscreen)

    const chart = init(widgetElement, { formatter: { formatDate } })
    if (!chart) throw new Error('Unable to initialize KLineChart')
    widget = chart

    const watermarkContainer = widget.getDom('candle_pane', 'main')
    if (watermarkContainer) {
      const element = document.createElement('div')
      element.className = 'klinecharts-pro-watermark'
      if (typeof watermark === 'string') element.innerHTML = watermark.trim()
      else element.appendChild(watermark as Node)
      watermarkContainer.appendChild(element)
    }

    priceUnitElement = document.createElement('span')
    priceUnitElement.className = 'klinecharts-pro-price-unit'
    widget.getDom('candle_pane', 'yAxis')?.appendChild(priceUnitElement)

    for (const name of mainIndicators) createIndicator(name, true, 'candle_pane')
    const initialSubIndicatorMap: Record<string, string> = {}
    for (const name of initialSubIndicators) {
      const paneId = createIndicator(name, true)
      if (paneId) initialSubIndicatorMap[name] = paneId
    }
    subIndicators = initialSubIndicatorMap

    widget.setDataLoader(chartDataLoader)
    widget.subscribeAction('onIndicatorTooltipFeatureClick', (value) => {
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
        indicatorSettings = {
          indicatorName: indicator.name,
          paneId: data.paneId,
          calcParams: cloneDeep(indicator.calcParams)
        }
        indicatorSettingsOpen = true
      } else if (featureId === 'close') {
        changeIndicator(indicator.name, data.paneId === 'candle_pane', false)
      }
    })

    widget.setStyles(theme)
    widget.setStyles(styles)
    widget.setLocale(locale)
    widget.setTimezone(timezone)
    applyIndicatorIcons()
    defaultStyles = cloneDeep(widget.getStyles())
    mounted = true

    return () => {
      window.removeEventListener('resize', handleResize)
      document.removeEventListener('fullscreenchange', handleFullscreen)
      dispose(chart)
      widget = null
    }
  })
</script>

<div bind:this={rootElement} class="klinecharts-pro-shell">
  <Tooltip.Provider delayDuration={250}>
    <header class="flex h-12 shrink-0 items-center gap-1 border-b px-2">
      <Tooltip.Root>
        <Tooltip.Trigger class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} onclick={() => {
          drawingBarVisible = !drawingBarVisible
          requestAnimationFrame(() => widget?.resize())
        }} aria-label="Toggle drawing toolbar">
          <MenuIcon />
        </Tooltip.Trigger>
        <Tooltip.Content portalProps={portalProps}>{i18n('drawing_tools', locale)}</Tooltip.Content>
      </Tooltip.Root>

      <Button variant="ghost" size="sm" class="max-w-52" onclick={() => { symbolDialogOpen = true }}>
        <Avatar.Root class="size-5">
          {#if symbol.logo}<Avatar.Image src={symbol.logo} alt={symbol.ticker} />{/if}
          <Avatar.Fallback>{symbol.ticker.slice(0, 2).toUpperCase()}</Avatar.Fallback>
        </Avatar.Root>
        <span class="truncate">{symbol.shortName ?? symbol.name ?? symbol.ticker}</span>
        <SearchIcon data-icon="inline-end" />
      </Button>

      <Separator orientation="vertical" class="mx-1 h-6" />
      <div class="min-w-0 flex-1 overflow-x-auto">
        <ToggleGroup.Root type="single" variant="outline" size="sm" bind:value={selectedPeriodText}>
          {#each periods as item (item.text)}
            <ToggleGroup.Item value={item.text} onclick={() => { period = item }}>
              {item.text}
            </ToggleGroup.Item>
          {/each}
        </ToggleGroup.Root>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        {#each [
          { label: i18n('indicator', locale), icon: ChartIcon, action: () => { indicatorDialogOpen = true } },
          { label: i18n('timezone', locale), icon: GlobeIcon, action: () => { timezoneDialogOpen = true } },
          { label: i18n('setting', locale), icon: SettingsIcon, action: openSettings },
          { label: i18n('screenshot', locale), icon: CameraIcon, action: takeScreenshot }
        ] as action (action.label)}
          {@const ActionIcon = action.icon}
          <Tooltip.Root>
            <Tooltip.Trigger class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} onclick={action.action} aria-label={action.label}>
              <ActionIcon />
            </Tooltip.Trigger>
            <Tooltip.Content portalProps={portalProps}>{action.label}</Tooltip.Content>
          </Tooltip.Root>
        {/each}
        <Tooltip.Root>
          <Tooltip.Trigger class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} onclick={toggleFullscreen} aria-label={i18n(fullscreen ? 'exit_full_screen' : 'full_screen', locale)}>
            {#if fullscreen}<MinimizeIcon />{:else}<MaximizeIcon />{/if}
          </Tooltip.Trigger>
          <Tooltip.Content portalProps={portalProps}>{i18n(fullscreen ? 'exit_full_screen' : 'full_screen', locale)}</Tooltip.Content>
        </Tooltip.Root>
      </div>
    </header>

    <div class="klinecharts-pro-chart-area">
      {#if drawingBarVisible}
        <aside class="flex w-12 shrink-0 flex-col items-center gap-1 border-r py-2">
          {#each drawingGroups as group (group.labelKey)}
            {@const GroupIcon = group.icon}
            <Popover.Root>
              <Tooltip.Root>
                <Tooltip.Trigger>
                  {#snippet child({ props })}
                    <Popover.Trigger {...props} class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} aria-label={i18n(group.labelKey, locale)}>
                      <GroupIcon />
                    </Popover.Trigger>
                  {/snippet}
                </Tooltip.Trigger>
                <Tooltip.Content portalProps={portalProps} side="right">{i18n(group.labelKey, locale)}</Tooltip.Content>
              </Tooltip.Root>
              <Popover.Content portalProps={portalProps} side="right" align="start" class="w-64 p-2">
                <Popover.Header class="px-2 py-1">
                  <Popover.Title>{i18n(group.labelKey, locale)}</Popover.Title>
                </Popover.Header>
                <ScrollArea.Root class="max-h-72">
                  <div class="flex flex-col gap-1">
                    {#each group.tools as tool (tool.name)}
                      {@const ToolIcon = tool.icon}
                      <Popover.Close class={buttonVariants({ variant: 'ghost', size: 'sm' })} onclick={() => createOverlay(tool)}>
                        <ToolIcon data-icon="inline-start" />
                        <span class="flex-1 text-left">{i18n(tool.labelKey, locale)}</span>
                      </Popover.Close>
                    {/each}
                  </div>
                </ScrollArea.Root>
              </Popover.Content>
            </Popover.Root>
          {/each}

          <Separator class="my-1" />
          <Tooltip.Root>
            <Tooltip.Trigger class={buttonVariants({ variant: overlayMode === 'normal' ? 'ghost' : 'secondary', size: 'icon-sm' })} onclick={() => {
              overlayMode = overlayMode === 'normal' ? 'weak_magnet' : 'normal'
              widget?.overrideOverlay({ mode: overlayMode })
            }} aria-label={i18n('weak_magnet', locale)}><MagnetIcon /></Tooltip.Trigger>
            <Tooltip.Content portalProps={portalProps} side="right">{i18n('weak_magnet', locale)}</Tooltip.Content>
          </Tooltip.Root>
          <Tooltip.Root>
            <Tooltip.Trigger class={buttonVariants({ variant: overlaysLocked ? 'secondary' : 'ghost', size: 'icon-sm' })} onclick={() => {
              overlaysLocked = !overlaysLocked
              widget?.overrideOverlay({ lock: overlaysLocked })
            }} aria-label={i18n(overlaysLocked ? 'unlock' : 'lock', locale)}>
              {#if overlaysLocked}<LockIcon />{:else}<UnlockIcon />{/if}
            </Tooltip.Trigger>
            <Tooltip.Content portalProps={portalProps} side="right">{i18n(overlaysLocked ? 'unlock' : 'lock', locale)}</Tooltip.Content>
          </Tooltip.Root>
          <Tooltip.Root>
            <Tooltip.Trigger class={buttonVariants({ variant: overlaysVisible ? 'ghost' : 'secondary', size: 'icon-sm' })} onclick={() => {
              overlaysVisible = !overlaysVisible
              widget?.overrideOverlay({ visible: overlaysVisible })
            }} aria-label={i18n(overlaysVisible ? 'invisible' : 'visible', locale)}>
              {#if overlaysVisible}<EyeIcon />{:else}<EyeOffIcon />{/if}
            </Tooltip.Trigger>
            <Tooltip.Content portalProps={portalProps} side="right">{i18n(overlaysVisible ? 'invisible' : 'visible', locale)}</Tooltip.Content>
          </Tooltip.Root>
          <Tooltip.Root>
            <Tooltip.Trigger class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })} onclick={() => widget?.removeOverlay({ groupId: 'drawing_tools' })} aria-label={i18n('remove', locale)}><TrashIcon /></Tooltip.Trigger>
            <Tooltip.Content portalProps={portalProps} side="right">{i18n('remove', locale)}</Tooltip.Content>
          </Tooltip.Root>
        </aside>
      {/if}

      <div bind:this={widgetElement} class="klinecharts-pro-widget"></div>
      {#if loading}
        <div class="klinecharts-pro-loading"><Spinner class="size-6" aria-label="Loading chart data" /></div>
      {/if}
    </div>

    <Dialog.Root bind:open={symbolDialogOpen}>
      <Dialog.Content portalProps={portalProps} class="sm:max-w-lg">
        <Dialog.Header>
          <Dialog.Title>{i18n('symbol_search', locale)}</Dialog.Title>
          <Dialog.Description>{i18n('symbol_code', locale)}</Dialog.Description>
        </Dialog.Header>
        <Command.Root shouldFilter={false} class="border">
          <Command.Input bind:value={symbolQuery} placeholder={i18n('symbol_code', locale)} />
          <Command.List class="max-h-80">
            {#if symbolSearching}<Command.Loading><Spinner /></Command.Loading>{/if}
            {#if !symbolSearching && symbolResults.length === 0}
              <Command.Empty>{i18n('no_data', locale)}</Command.Empty>
            {/if}
            <Command.Group heading={i18n('symbol_search', locale)}>
              {#each symbolResults as item (item.ticker)}
                <Command.Item value={item.ticker} onclick={() => {
                  symbol = item
                  symbolDialogOpen = false
                }}>
                  <Avatar.Root class="size-7">
                    {#if item.logo}<Avatar.Image src={item.logo} alt={item.ticker} />{/if}
                    <Avatar.Fallback>{item.ticker.slice(0, 2)}</Avatar.Fallback>
                  </Avatar.Root>
                  <div class="min-w-0 flex-1">
                    <div class="truncate font-medium">{item.shortName ?? item.ticker}</div>
                    {#if item.name}<div class="truncate text-xs text-muted-foreground">{item.name}</div>{/if}
                  </div>
                  <span class="text-xs text-muted-foreground">{item.exchange ?? ''}</span>
                </Command.Item>
              {/each}
            </Command.Group>
          </Command.List>
        </Command.Root>
      </Dialog.Content>
    </Dialog.Root>

    <Dialog.Root bind:open={indicatorDialogOpen}>
      <Dialog.Content portalProps={portalProps} class="sm:max-w-xl">
        <Dialog.Header>
          <Dialog.Title>{i18n('indicator', locale)}</Dialog.Title>
          <Dialog.Description>{i18n('main_indicator', locale)} / {i18n('sub_indicator', locale)}</Dialog.Description>
        </Dialog.Header>
        <ScrollArea.Root class="h-[min(60vh,30rem)] pr-4">
          <Field.Set>
            <Field.Legend>{i18n('main_indicator', locale)}</Field.Legend>
            <Field.Group class="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {#each mainIndicatorNames as name (name)}
                <Field.Field orientation="horizontal">
                  <Checkbox id={`main-${name}`} checked={mainIndicators.includes(name)} onCheckedChange={(checked) => changeIndicator(name, true, checked === true)} />
                  <Field.Label for={`main-${name}`} class="font-normal">{i18n(name.toLowerCase(), locale)}</Field.Label>
                </Field.Field>
              {/each}
            </Field.Group>
          </Field.Set>
          <Separator class="my-5" />
          <Field.Set>
            <Field.Legend>{i18n('sub_indicator', locale)}</Field.Legend>
            <Field.Group class="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {#each subIndicatorNames as name (name)}
                <Field.Field orientation="horizontal">
                  <Checkbox id={`sub-${name}`} checked={name in subIndicators} onCheckedChange={(checked) => changeIndicator(name, false, checked === true)} />
                  <Field.Label for={`sub-${name}`} class="font-normal">{i18n(name.toLowerCase(), locale)}</Field.Label>
                </Field.Field>
              {/each}
            </Field.Group>
          </Field.Set>
        </ScrollArea.Root>
      </Dialog.Content>
    </Dialog.Root>

    <Dialog.Root bind:open={timezoneDialogOpen}>
      <Dialog.Content portalProps={portalProps} class="sm:max-w-sm">
        <Dialog.Header>
          <Dialog.Title>{i18n('timezone', locale)}</Dialog.Title>
          <Dialog.Description>{translateTimezone(timezone, locale)}</Dialog.Description>
        </Dialog.Header>
        <Field.Group>
          <Field.Field>
            <Field.Label for="chart-timezone">{i18n('timezone', locale)}</Field.Label>
            <Select.Root type="single" bind:value={timezone}>
              <Select.Trigger id="chart-timezone">{translateTimezone(timezone, locale)}</Select.Trigger>
              <Select.Content portalProps={portalProps} class="max-h-72">
                <Select.Group>
                  {#each timezoneOptions as item (item.key)}
                    <Select.Item value={item.key} label={item.text}>{item.text}</Select.Item>
                  {/each}
                </Select.Group>
              </Select.Content>
            </Select.Root>
          </Field.Field>
        </Field.Group>
      </Dialog.Content>
    </Dialog.Root>

    <Dialog.Root bind:open={settingsDialogOpen}>
      <Dialog.Content portalProps={portalProps} class="sm:max-w-xl">
        <Dialog.Header>
          <Dialog.Title>{i18n('setting', locale)}</Dialog.Title>
          <Dialog.Description>{i18n('setting', locale)}</Dialog.Description>
        </Dialog.Header>
        {#if settingsStyles}
          <Field.Group>
            {#each settingOptions as option (option.key)}
              <Field.Field orientation="horizontal">
                <Field.Label for={`setting-${option.key}`} class="flex-1">{option.text}</Field.Label>
                {#if option.component === 'switch'}
                  <Switch id={`setting-${option.key}`} checked={Boolean(getSettingValue(option.key))} onCheckedChange={(checked) => updateStyle(option.key, checked)} />
                {:else}
                  <Select.Root type="single" value={String(getSettingValue(option.key))} onValueChange={(value) => updateStyle(option.key, value)}>
                    <Select.Trigger id={`setting-${option.key}`} class="w-40">
                      {i18n(String(getSettingValue(option.key)), locale)}
                    </Select.Trigger>
                    <Select.Content portalProps={portalProps}>
                      <Select.Group>
                        {#each option.dataSource ?? [] as item (item.key)}
                          <Select.Item value={item.key} label={item.text}>{item.text}</Select.Item>
                        {/each}
                      </Select.Group>
                    </Select.Content>
                  </Select.Root>
                {/if}
              </Field.Field>
            {/each}
          </Field.Group>
        {/if}
        <Dialog.Footer>
          <Button variant="outline" onclick={restoreStyles}>{i18n('restore_default', locale)}</Button>
          <Dialog.Close class={buttonVariants()}>{i18n('confirm', locale)}</Dialog.Close>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>

    <Dialog.Root bind:open={indicatorSettingsOpen}>
      <Dialog.Content portalProps={portalProps} class="sm:max-w-sm">
        <Dialog.Header>
          <Dialog.Title>{indicatorSettings.indicatorName}</Dialog.Title>
          <Dialog.Description>{i18n('indicator', locale)}</Dialog.Description>
        </Dialog.Header>
        <Field.Group>
          {#each (indicatorConfig as Record<string, Array<{ paramNameKey: string; precision: number; min: number; default?: number }>>)[indicatorSettings.indicatorName] ?? [] as config, index (config.paramNameKey)}
            <Field.Field>
              <Field.Label for={`indicator-param-${index}`}>{i18n(config.paramNameKey, locale)}</Field.Label>
              <Input id={`indicator-param-${index}`} type="number" min={config.min} step={10 ** -config.precision} value={String(indicatorSettings.calcParams[index] ?? '')} oninput={(event) => {
                const next = [...indicatorSettings.calcParams]
                next[index] = event.currentTarget.value === '' ? '' : Number(event.currentTarget.value)
                indicatorSettings = { ...indicatorSettings, calcParams: next }
              }} />
            </Field.Field>
          {/each}
        </Field.Group>
        <Dialog.Footer>
          <Button onclick={() => {
            const config = (indicatorConfig as Record<string, Array<{ default?: number }>>)[indicatorSettings.indicatorName] ?? []
            const params = indicatorSettings.calcParams.map((value, index) => value === '' || value == null ? config[index]?.default : value)
            widget?.overrideIndicator({ name: indicatorSettings.indicatorName, paneId: indicatorSettings.paneId, calcParams: params })
            indicatorSettingsOpen = false
          }}>{i18n('confirm', locale)}</Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>

    <Dialog.Root bind:open={screenshotDialogOpen}>
      <Dialog.Content portalProps={portalProps} class="sm:max-w-2xl">
        <Dialog.Header>
          <Dialog.Title>{i18n('screenshot', locale)}</Dialog.Title>
          <Dialog.Description>{symbol.ticker} · {period.text}</Dialog.Description>
        </Dialog.Header>
        {#if screenshotUrl}
          <img class="w-full rounded-md border" src={screenshotUrl} alt={`${symbol.ticker} chart screenshot`} />
        {:else}
          <Empty.Root>
            <Empty.Header><Empty.Title>{i18n('no_data', locale)}</Empty.Title></Empty.Header>
          </Empty.Root>
        {/if}
        <Dialog.Footer>
          <Button disabled={!screenshotUrl} onclick={saveScreenshot}>{i18n('save', locale)}</Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  </Tooltip.Provider>
</div>
