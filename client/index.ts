import type { Chart } from 'klinecharts'
import { KLineChartPro } from '../src'
import { currentSession, logout } from './auth'
import { capabilities, hasFeature, loadCapabilities, levelsCoverageFor } from './capabilities'
import { WdashboardDatafeed } from './datafeed'
import { clearLevels, drawLevels } from './levels'
import { renderLogin } from './login'
import { availablePeriods, defaultPeriod } from './periods'
import { loadStarredTimeframes, saveStarredTimeframes } from './preferences'
import { stream, type StreamStatus } from './stream'
import { DEFAULT_SYMBOL_TICKER, fetchSymbolInfo, symbolVendor } from './symbols'

import './style.css'

// Levels are re-queried on pan/zoom because the query is price-windowed. The debounce is
// what keeps a drag from issuing one request per animation frame.
const LEVELS_REDRAW_DEBOUNCE_MS = 400

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
  // The initial instrument's configuration and this account's starred timeframes both
  // have to resolve before the chart mounts — price precision and the starred set are
  // both construction-time properties of the library component (src/types.ts:
  // ChartProOptions has no setSymbol-style setter for either).
  const [symbol, starredTimeframes] = await Promise.all([
    fetchSymbolInfo(params.get('symbol') ?? DEFAULT_SYMBOL_TICKER),
    hasFeature('preferences') ? loadStarredTimeframes() : Promise.resolve(DEFAULT_STARRED_TIMEFRAMES)
  ])

  const periods = availablePeriods()
  const chartPro = new KLineChartPro({
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
    datafeed: new WdashboardDatafeed()
  })

  mountChartExtras(chartPro)
}

// Populates the two slots the library exposes (src/types.ts ChartPro.getSlot): the top-rail
// toolbar gets the Levels toggle, the bottom of the left drawing rail gets the
// stream-liveness dot, server version, and (when logged in) a sign-out control. All three
// answer questions the chart itself cannot — a chart with a dead socket looks exactly like
// a quiet market — which is why they used to float over the canvas in their own corner
// widget; they now live in the chrome instead.
function mountChartExtras(chartPro: KLineChartPro): void {
  const levelsButton = document.createElement('button')
  levelsButton.type = 'button'
  levelsButton.className = 'kc-button wd-levels-toggle'
  levelsButton.textContent = 'Levels'

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

  attachSlots(chartPro, levelsButton, footer)
  void wireLevels(chartPro, levelsButton)
}

// The library's slots only exist once ChartPro.svelte has mounted (getSlot() is null
// before then, the same timing problem whenChartReady below already solves), and the
// rail-footer slot's own element is additionally destroyed and recreated every time the
// drawing toolbar toggles off and back on — it lives inside ChartPro.svelte's
// `{#if drawingBarVisible}`. Re-parent into whichever instance of each slot currently
// exists, on every relevant DOM change, rather than attaching once: otherwise the footer's
// live/version/logout controls would vanish for good the first time someone hides the
// drawing tools instead of merely hiding with it, as intended.
function attachSlots(chartPro: KLineChartPro, levelsButton: HTMLElement, footer: HTMLElement): void {
  const tryAttach = (): void => {
    const toolbarSlot = chartPro.getSlot('toolbar')
    if (toolbarSlot && levelsButton.parentElement !== toolbarSlot) {
      toolbarSlot.appendChild(levelsButton)
    }
    const footerSlot = chartPro.getSlot('rail-footer')
    if (footerSlot && footer.parentElement !== footerSlot) {
      footerSlot.appendChild(footer)
    }
  }
  tryAttach()
  const container = document.getElementById('app')
  if (!container) return
  new MutationObserver(tryAttach).observe(container, { childList: true, subtree: true })
}

// Svelte 5's `mount()` does not flush the component's onMount synchronously, so the
// KLineChart instance does not exist yet when the KLineChartPro constructor returns —
// getChart() is null for the first few frames. Poll rather than reach into Svelte's
// scheduler, and give up rather than spin forever if the chart genuinely failed to build.
function whenChartReady(chartPro: KLineChartPro, timeoutMs = 5_000): Promise<Chart | null> {
  return new Promise((resolve) => {
    const deadline = performance.now() + timeoutMs
    const poll = (): void => {
      const chart = chartPro.getChart()
      if (chart) resolve(chart)
      else if (performance.now() > deadline) resolve(null)
      else requestAnimationFrame(poll)
    }
    poll()
  })
}

async function wireLevels(chartPro: KLineChartPro, button: HTMLButtonElement): Promise<void> {
  const chart = await whenChartReady(chartPro)
  if (!chart) {
    console.warn('[client] chart unavailable, levels disabled')
    button.hidden = true
    return
  }

  let enabled = params.get('levels') !== 'off'
  let timer: ReturnType<typeof setTimeout> | null = null

  const apply = (): void => {
    button.setAttribute('aria-pressed', String(enabled))
    button.classList.toggle('is-on', enabled)
  }

  const redraw = (): void => {
    if (!enabled) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const symbol = chartPro.getSymbol()
      // Coverage is per instrument; hide the control entirely where there is nothing to
      // show rather than offering a toggle that does nothing.
      button.hidden = !levelsCoverageFor(symbolVendor(symbol), symbol.ticker)
      drawLevels(chart, symbol).catch((err: unknown) => {
        console.error('[client] levels fetch failed', err)
      })
    }, LEVELS_REDRAW_DEBOUNCE_MS)
  }

  button.addEventListener('click', () => {
    enabled = !enabled
    apply()
    if (enabled) redraw()
    else clearLevels(chart)
  })

  // Pan, zoom and every data load land here, which covers symbol and period switches too.
  chart.subscribeAction('onVisibleRangeChange', redraw)

  apply()
  redraw()
}

void bootstrap()
