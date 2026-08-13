import type { Chart } from 'klinecharts'
import { KLineChartPro } from '../src'
import { capabilities, loadCapabilities, levelsCoverageFor } from './capabilities'
import { WdashboardDatafeed } from './datafeed'
import { clearLevels, drawLevels } from './levels'
import { availablePeriods, defaultPeriod } from './periods'
import { stream, type StreamStatus } from './stream'
import { DEFAULT_SYMBOL_TICKER, fetchSymbolInfo, symbolVendor } from './symbols'

import './style.css'

// Levels are re-queried on pan/zoom because the query is price-windowed. The debounce is
// what keeps a drag from issuing one request per animation frame.
const LEVELS_REDRAW_DEBOUNCE_MS = 400

const params = new URLSearchParams(window.location.search)

async function bootstrap(): Promise<void> {
  // Discovery and the initial instrument's configuration both have to resolve before the
  // chart mounts — the period bar is built from the server's interval list, and price
  // precision is a construction-time property of the symbol.
  const [, symbol] = await Promise.all([
    loadCapabilities(),
    fetchSymbolInfo(params.get('symbol') ?? DEFAULT_SYMBOL_TICKER)
  ])

  const periods = availablePeriods()
  const chartPro = new KLineChartPro({
    container: 'app',
    locale: 'en-US',
    theme: params.get('theme') ?? 'dark',
    // wdashboard-server aligns bar timestamps to America/New_York — 1D bars open at 17:00
    // NY, the FX daily boundary — so any other display timezone splits days mid-bar.
    timezone: 'America/New_York',
    symbol,
    period: defaultPeriod(periods),
    periods,
    mainIndicators: ['MA'],
    subIndicators: ['VOL'],
    datafeed: new WdashboardDatafeed()
  })

  mountStatusBar(chartPro)
}

// A small status strip: whether the live stream is actually connected, and a levels toggle
// for the instruments the server has computed levels for. Both answer questions the chart
// itself cannot — a chart with a dead socket looks exactly like a quiet market.
function mountStatusBar(chartPro: KLineChartPro): void {
  const bar = document.createElement('div')
  bar.className = 'wd-statusbar'

  const status = document.createElement('span')
  status.className = 'wd-status'
  const dot = document.createElement('span')
  dot.className = 'wd-status-dot'
  const statusText = document.createElement('span')
  status.append(dot, statusText)

  const levelsButton = document.createElement('button')
  levelsButton.type = 'button'
  levelsButton.className = 'wd-levels-toggle'
  levelsButton.textContent = 'Levels'

  const version = document.createElement('span')
  version.className = 'wd-version'
  version.textContent = `server ${capabilities().version}`

  bar.append(status, levelsButton, version)
  document.body.appendChild(bar)

  stream.onStatus((value: StreamStatus) => {
    bar.dataset.stream = value
    statusText.textContent = value === 'connected' ? 'live' : value
  })

  void wireLevels(chartPro, levelsButton)
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
