import { KLineChartPro } from '../src'
import { currentSession, logout } from './auth'
import { capabilities, hasFeature, loadCapabilities } from './capabilities'
import { attachToSlot, createLayerController } from './chartlayers/controller'
import { WdashboardDatafeed } from './datafeed'
import { hydrateLayout, loadLayout, saveLayout, toPaneOptions } from './layout'
import { levelsLayer } from './levels/layer'
import { renderLogin } from './login'
import { availablePeriods, defaultPeriod } from './periods'
import { loadStarredTimeframes, saveStarredTimeframes } from './preferences'
import { stream, type StreamStatus } from './stream'
import { DEFAULT_SYMBOL_TICKER, fetchSymbolInfo } from './symbols'

import './style.css'

// Used only when the server doesn't advertise 'preferences' (prod, today) or a fetch of the
// user's own set fails — the account's real starred set otherwise comes from
// loadStarredTimeframes(), seeded server-side by wdashboard-server's appstate migration.
const DEFAULT_STARRED_TIMEFRAMES = ['1m', '1h', '1D', '1W', '1M']

const params = new URLSearchParams(window.location.search)

async function bootstrap(): Promise<void> {
  await loadCapabilities()

  const appContainer = document.getElementById('app')
  if (!appContainer) throw new Error('#app not found')

  // The login gate is dev-only, and the client is one bundle deployed to both dev and
  // prod: gating unconditionally would leave prod (which has no appstate database, so
  // 'auth' is never advertised) stuck at a login form nothing could ever satisfy. See
  // capabilities.ts's Feature union and appstate.py's module docstring.
  if (hasFeature('auth')) {
    const session = await currentSession()
    if (!session) {
      renderLogin(appContainer, () => {
        void bootstrap()
      })
      return
    }
  }

  await mountChart(appContainer)
}

async function mountChart(container: HTMLElement): Promise<void> {
  // Svelte's mount() appends to its target rather than replacing its contents, so a prior
  // renderLogin() left in place would sit visually on top of (or behind) the chart forever
  // — the chart mounts and works underneath, but the page reads as permanently stuck on
  // "Signing in…" since nothing ever tears the login form down.
  container.innerHTML = ''

  // A `?symbol=` link is a deliberate deep link to one instrument -- it wins outright over
  // any saved wall, rather than silently landing on some other pane's saved symbol.
  const requestedSymbol = params.get('symbol')

  // The initial instrument's configuration, this account's starred timeframes, and any saved
  // wall layout all have to resolve before the chart mounts — price precision, the starred
  // set and the pane layout are all construction-time properties of the library component
  // (src/types.ts: ChartProOptions has no setSymbol-style setter for any of them).
  const [symbol, starredTimeframes, persistedLayout] = await Promise.all([
    fetchSymbolInfo(requestedSymbol ?? DEFAULT_SYMBOL_TICKER),
    hasFeature('preferences') ? loadStarredTimeframes() : Promise.resolve(DEFAULT_STARRED_TIMEFRAMES),
    requestedSymbol ? Promise.resolve(null) : loadLayout()
  ])
  const hydrated = persistedLayout ? await hydrateLayout(persistedLayout) : null

  // Every chart layer (today: just Levels) is built before the chart exists: its `sync`
  // becomes the wall's onPanesChange, which is a constructor argument.
  const levelsController = createLayerController(levelsLayer)

  const periods = availablePeriods()

  // Every one of these fires only after the chart exists (Svelte effects, never
  // synchronously during the constructor below), so `chartPro` is always assigned by the
  // time any of them runs.
  let chartPro: KLineChartPro | null = null
  const persist = (): void => {
    const cp = chartPro
    if (!cp) return
    const panes = cp.getPaneSnapshots()
    if (panes.length === 0) return
    const activeIndex = Math.max(0, panes.findIndex((pane) => pane.id === cp.getActivePaneId()))
    saveLayout(cp.getPaneLayout(), panes, activeIndex, latestSync)
  }
  let latestSync = { crosshair: hydrated?.sync.crosshair ?? true, time: hydrated?.sync.time ?? true }

  chartPro = new KLineChartPro({
    container,
    locale: 'en-US',
    theme: params.get('theme') ?? 'dark',
    // wdashboard-server aligns bar timestamps to America/New_York — 1D bars open at 17:00
    // NY, the FX daily boundary — so any other display timezone splits days mid-bar.
    timezone: 'America/New_York',
    symbol,
    period: defaultPeriod(periods),
    periods,
    starredPeriods: starredTimeframes,
    onStarredPeriodsChange: hasFeature('preferences') ? saveStarredTimeframes : () => {},
    mainIndicators: ['MA'],
    subIndicators: ['VOL'],
    // A factory: WdashboardDatafeed keys its `listeners`/`latest` watermark maps by
    // `vendor symbol interval`, so each pane needs its own instance -- two panes on the same
    // symbol+interval sharing one would clobber each other's stream subscription.
    datafeed: () => new WdashboardDatafeed(),
    ...(hydrated
      ? { paneLayout: hydrated.preset, panes: hydrated.panes.map(toPaneOptions) }
      : {}),
    activePane: hydrated ? `p${hydrated.active + 1}` : 'p1',
    syncCrosshair: latestSync.crosshair,
    syncTime: latestSync.time,
    // The definitive "which panes are actually live" signal -- fires once per pane mount and
    // once per pane teardown (including every layout grow/shrink), never before a pane's
    // chart exists. Every mounted chart layer resyncs from this directly; nothing here polls
    // getChart().
    onPanesChange: (panes) => levelsController.sync(panes),
    onPaneLayoutChange: persist,
    onActivePaneChange: persist,
    onSymbolChange: persist,
    onPeriodChange: persist,
    onSyncChange: (options) => {
      latestSync = options
      persist()
    }
  })

  mountChartExtras(chartPro, levelsController)
}

// Populates the two slots the library exposes (src/types.ts ChartPro.getSlot): the top-rail
// toolbar gets each mounted chart layer's toggle (today just Levels), the bottom of the left
// drawing rail gets the stream-liveness dot, server version, and (when logged in) a sign-out
// control. The rail-footer trio lives in the chrome because it answers questions the chart
// itself cannot — a chart with a dead socket looks exactly like a quiet market.
function mountChartExtras(
  chartPro: KLineChartPro,
  levelsController: ReturnType<typeof createLayerController>
): void {
  const footer = document.createElement('div')
  footer.className = 'wd-rail-footer-content'

  const status = document.createElement('span')
  status.className = 'wd-status'
  const dot = document.createElement('span')
  dot.className = 'wd-status-dot'
  const statusText = document.createElement('span')
  status.append(dot, statusText)

  const version = document.createElement('span')
  version.className = 'wd-version'
  version.textContent = capabilities().version
  version.title = `server ${capabilities().version}`

  footer.append(status, version)

  if (hasFeature('auth')) {
    const logoutButton = document.createElement('button')
    logoutButton.type = 'button'
    logoutButton.className = 'wd-logout'
    logoutButton.textContent = 'Sign out'
    logoutButton.addEventListener('click', () => {
      void logout().then(() => window.location.reload())
    })
    footer.append(logoutButton)
  }

  // The rail is 3rem (48px) wide, so the visible label has to be short — the full word
  // ('connecting', 'offline') lives in `title` for anyone who hovers.
  const STATUS_LABELS: Record<StreamStatus, string> = {
    connected: 'live',
    connecting: 'conn',
    offline: 'off'
  }
  stream.onStatus((value: StreamStatus) => {
    status.dataset.stream = value
    statusText.textContent = STATUS_LABELS[value]
    statusText.title = value
  })

  attachToSlot(chartPro, 'rail-footer', footer)
  levelsController.attach(chartPro)
}

void bootstrap()
