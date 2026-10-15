import { KLineChartPro, type Period, type SymbolInfo } from '../../src'
import { button, el, input, select } from '../alerts/dom'
import { WdashboardDatafeed } from '../datafeed'
import { defaultLayout, hydrateLayout, toPaneOptions } from '../layout'
import { createLevelsIndicators } from '../levels/indicator'
import { availablePeriods, periodToResolution } from '../periods'
import { builtinPlugins, createFacilities, createPluginHost } from '../plugins'
import type { CandleGrid } from '../replay/timeframes'
import { fetchSymbolInfo, fetchSymbols } from '../symbols'
import { loadLabCatalogue, labIntervals, type LabCatalogue } from './catalogue'
import { HttpLabData } from './data'
import { createStrategyEditor } from './editor'
import { newStrategyId, rank85Strategy, ruleStrategy, type Strategy, strategyProblems } from './model'
import { DEFAULT_SHOW, LAB_DRAFT_TEMPLATE, type LabExtendData, publishRun, registerLabTemplate, type ShowOptions } from './overlay'
import { createResultsView } from './results'
import { type LabRun, RunCancelled, RunError, runStrategy } from './runner'
import { StrategyStore } from './store'

// THE STRATEGY LAB: a page of the dashboard (`/lab`) for developing a strategy's rules -- the
// graph that joins signals into cascades, which of its nodes are entries, and what happens after
// them -- against history, where the dashboard is for watching the market.
//
//   header   which strategy, Save / Revert, the instrument and window it runs on, Run
//   editor   every slot of the strategy (./editor.ts)
//   chart    the instrument, with the run drawn on it (./overlay.ts, the `LAB:draft` template)
//   results  what the run found (./results.ts); a row takes the chart there
//
// Editing is a DRAFT: nothing is kept until Save (./store.ts), and a dashboard pane or an alert
// reading a strategy reads what is saved. With Auto-run on, an edit that leaves the strategy
// runnable runs it again; the data layer holds what it has read, so a re-run fetches nothing.

const RUN_KEY = 'lab-page'
const CURRENT_KEY = 'wd.lab.current'
const AUTO_KEY = 'wd.lab.autorun'
const AUTO_DELAY_MS = 700
const DEFAULT_PERIOD = '5m'

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // A per-device convenience only.
  }
}

/** A strategy as compared for "unsaved": everything but when it was saved. */
function signature(strategy: Strategy | null): string {
  if (!strategy) return ''
  const { updatedAt: _u, ...rest } = strategy
  return JSON.stringify(rest)
}

export async function runLab(container: HTMLElement, params: URLSearchParams): Promise<void> {
  container.innerHTML = ''
  const theme = params.get('theme') ?? 'dark'
  const root = el('div', `wd-lab${theme === 'dark' ? ' dark' : ''}`)
  container.appendChild(root)
  document.title = 'Strategy Lab · trading-marketdata'

  const placeholder = el('p', 'wd-lab-loading')
  placeholder.textContent = 'Loading the Strategy Lab…'
  root.appendChild(placeholder)

  const store = new StrategyStore()
  const [catalogue] = await Promise.all([loadLabCatalogue().catch((): LabCatalogue | null => null), store.load()])
  const data = new HttpLabData()
  root.innerHTML = ''

  // -- drafts -----------------------------------------------------------------------------------
  const drafts = new Map<string, Strategy>()
  for (const saved of store.list()) drafts.set(saved.id, structuredClone(saved))
  const requested = params.get('strategy')
  let currentId = (requested && drafts.has(requested) ? requested : null) ?? storageGet(CURRENT_KEY) ?? ''
  if (!drafts.has(currentId)) {
    const first = store.list()[0]
    if (first) currentId = first.id
    else {
      const fresh = rank85Strategy()
      drafts.set(fresh.id, fresh)
      currentId = fresh.id
    }
  }
  const current = (): Strategy => drafts.get(currentId) as Strategy
  const unsaved = (id: string): boolean => signature(drafts.get(id) ?? null) !== signature(store.get(id))

  // -- layout -----------------------------------------------------------------------------------
  const head = el('header', 'wd-lab-head')
  const bodyBox = el('div', 'wd-lab-body')
  const editorBox = el('aside', 'wd-lab-side')
  const main = el('main', 'wd-lab-main')
  const chartBox = el('div', 'wd-lab-chart')
  main.append(chartBox)
  bodyBox.append(editorBox, main)
  root.append(head, bodyBox)

  let lastRun: LabRun | null = null
  let selected: string | null = null
  const results = createResultsView((pick) => {
    selected = pick.entryId
    chart?.select(pick.entryId)
    if (lastRun) chart?.seek(pick.at, lastRun.grid)
  })
  main.appendChild(results.element)

  const editor = createStrategyEditor(
    current(),
    {
      catalogue,
      intervals: () => labIntervals(current().instrument),
      counts: () => (lastRun && lastRun.strategy.id === currentId ? new Map(lastRun.counts.map((c) => [`${c.source}|${c.interval}`, c.signals])) : null)
    },
    () => edited()
  )
  if (store.loadError) {
    const warning = el('p', 'wd-lab-error')
    warning.textContent = store.loadError
    editorBox.appendChild(warning)
  }
  editorBox.appendChild(editor.element)

  // -- header -----------------------------------------------------------------------------------
  const back = document.createElement('a')
  back.className = 'kc-button wd-lab-back'
  // The dashboard is the page this one sits beside: `/lab` -> `/`, under any base path.
  back.href = window.location.pathname.replace(/lab\/?$/, '') || '/'
  back.textContent = '← Dashboard'
  back.title = 'Back to the dashboard'

  const brand = el('span', 'wd-lab-brand')
  brand.textContent = 'Strategy Lab'

  const picker = document.createElement('select')
  picker.className = 'kc-input wd-lab-picker'
  picker.setAttribute('aria-label', 'Strategy')
  picker.addEventListener('change', () => switchTo(picker.value))

  const nameInput = input('text', current().name, (value) => {
    current().name = value
    edited(false)
  })
  nameInput.className = 'kc-input wd-lab-name'
  nameInput.setAttribute('aria-label', 'Name')

  const newPicker = select(
    [
      { value: '', label: 'New…' },
      { value: 'rank85', label: 'AREV21 rank 85 graph (the overlay’s)' },
      { value: 'rule', label: 'Rule events, no graph' },
      { value: 'copy', label: 'A copy of this one' }
    ],
    '',
    (value) => {
      newPicker.value = ''
      if (!value) return
      const now = Date.now()
      let fresh: Strategy
      if (value === 'copy') fresh = { ...structuredClone(current()), id: newStrategyId(now), name: `${current().name} copy`, createdAt: now, updatedAt: now }
      else fresh = value === 'rule' ? ruleStrategy(now) : rank85Strategy(now)
      fresh.instrument = current().instrument
      drafts.set(fresh.id, fresh)
      switchTo(fresh.id)
    }
  )
  newPicker.classList.add('wd-lab-new')
  newPicker.setAttribute('aria-label', 'New strategy')

  const save = button('kc-button kc-button-primary', 'Save', () => {
    try {
      const saved = store.save(current())
      drafts.set(saved.id, structuredClone(saved))
      saveNote.textContent = ''
    } catch (err) {
      saveNote.textContent = err instanceof Error ? err.message : String(err)
    }
    refreshHead()
  })
  save.title = 'Keep this strategy. A dashboard pane or an alert reads what is saved.'
  const revert = button('kc-button kc-button-outline', 'Revert', () => {
    const saved = store.get(currentId)
    if (!saved) return
    drafts.set(currentId, structuredClone(saved))
    editor.setStrategy(current())
    refreshHead()
    scheduleRun()
  })
  revert.title = 'Discard the changes since the last Save'
  let deleteArmed: ReturnType<typeof setTimeout> | null = null
  const remove = button('kc-button kc-button-outline wd-lab-delete', 'Delete', () => {
    if (!deleteArmed) {
      remove.textContent = 'Delete?'
      remove.classList.add('is-armed')
      deleteArmed = setTimeout(() => {
        deleteArmed = null
        remove.textContent = 'Delete'
        remove.classList.remove('is-armed')
      }, 3000)
      return
    }
    clearTimeout(deleteArmed)
    deleteArmed = null
    remove.textContent = 'Delete'
    remove.classList.remove('is-armed')
    try {
      store.remove(currentId)
    } catch (err) {
      saveNote.textContent = err instanceof Error ? err.message : String(err)
      return
    }
    drafts.delete(currentId)
    const next = [...drafts.keys()][0]
    if (next) switchTo(next)
    else {
      const fresh = rank85Strategy()
      drafts.set(fresh.id, fresh)
      switchTo(fresh.id)
    }
  })
  remove.title = 'Delete this strategy (press twice)'
  const saveNote = el('span', 'wd-lab-save-note')

  // The run's instrument and window.
  const instrument = input('text', current().instrument, () => {})
  instrument.className = 'kc-input wd-lab-instrument'
  instrument.setAttribute('aria-label', 'Instrument')
  instrument.setAttribute('list', 'wd-lab-symbols')
  instrument.title = 'vendor:TICKER'
  const symbols = document.createElement('datalist')
  symbols.id = 'wd-lab-symbols'
  void fetchSymbols('')
    .then((list) => {
      for (const s of list) {
        const option = document.createElement('option')
        option.value = `${s.exchange ?? 'oanda'}:${s.ticker}`
        symbols.appendChild(option)
      }
    })
    .catch(() => {})
  instrument.addEventListener('change', () => {
    const raw = instrument.value.trim()
    const at = raw.indexOf(':')
    current().instrument = at > 0 ? `${raw.slice(0, at).toLowerCase()}:${raw.slice(at + 1).toUpperCase()}` : `oanda:${raw.toUpperCase()}`
    instrument.value = current().instrument
    editor.render()
    edited()
  })

  const days = document.createElement('input')
  days.type = 'number'
  days.min = '1'
  days.step = '1'
  days.className = 'kc-input wd-lab-days'
  days.setAttribute('aria-label', 'Days')
  days.addEventListener('input', () => {
    const n = Math.round(Number(days.value))
    if (!(n >= 1)) return
    current().window = { kind: 'days', days: n }
    edited()
  })
  const daysLabel = el('label', 'wd-lab-window')
  daysLabel.append(document.createTextNode('last'), days, document.createTextNode('days'))

  const runButton = button('kc-button kc-button-primary wd-lab-run', 'Run', () => void run())
  runButton.title = 'Run the strategy over its window (Ctrl+Enter)'
  const auto = document.createElement('input')
  auto.type = 'checkbox'
  auto.checked = storageGet(AUTO_KEY) !== '0'
  auto.addEventListener('change', () => storageSet(AUTO_KEY, auto.checked ? '1' : '0'))
  const autoLabel = el('label', 'wd-lab-check')
  autoLabel.append(auto, document.createTextNode('Auto-run'))
  autoLabel.title = 'Run again after every edit that leaves the strategy runnable'

  const show: ShowOptions = { ...DEFAULT_SHOW }
  const showBox = el('span', 'wd-lab-show')
  for (const [key, label] of [
    ['graphs', 'graphs'],
    ['entries', 'entries'],
    ['signals', 'all signals'],
    ['trades', 'trades']
  ] as const) {
    const l = el('label', 'wd-lab-check')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = show[key]
    box.addEventListener('change', () => {
      show[key] = box.checked
      chart?.draw()
    })
    l.append(box, document.createTextNode(label))
    showBox.appendChild(l)
  }

  const left = el('div', 'wd-lab-head-left')
  left.append(back, brand, picker, nameInput, newPicker, save, revert, remove, saveNote)
  const right = el('div', 'wd-lab-head-right')
  right.append(instrument, symbols, daysLabel, runButton, autoLabel, showBox)
  head.append(left, right)

  function refreshHead(): void {
    picker.innerHTML = ''
    const ids = [...new Set([...store.list().map((s) => s.id), ...drafts.keys()])]
    for (const id of ids) {
      const s = drafts.get(id) ?? store.get(id)
      if (!s) continue
      const option = document.createElement('option')
      option.value = id
      option.textContent = `${s.name || 'Untitled'}${store.get(id) ? '' : ' (not saved)'}${unsaved(id) && store.get(id) ? ' •' : ''}`
      picker.appendChild(option)
    }
    picker.value = currentId
    if (document.activeElement !== nameInput) nameInput.value = current().name
    instrument.value = current().instrument
    const w = current().window
    days.value = w.kind === 'days' ? String(w.days) : ''
    const dirty = unsaved(currentId)
    save.disabled = !dirty || !!store.loadError
    revert.disabled = !dirty || !store.get(currentId)
    save.textContent = store.get(currentId) ? 'Save' : 'Save new'
    root.classList.toggle('is-unsaved', dirty)
  }

  function switchTo(id: string): void {
    if (!drafts.has(id)) {
      const saved = store.get(id)
      if (!saved) return
      drafts.set(id, structuredClone(saved))
    }
    currentId = id
    storageSet(CURRENT_KEY, id)
    lastRun = null
    editor.setStrategy(current())
    refreshHead()
    results.showMessage('Press Run to evaluate the strategy over its window.')
    publishRun(RUN_KEY, null)
    chart?.draw()
    void chart?.setInstrument(current().instrument)
    scheduleRun(0)
  }

  // -- running ----------------------------------------------------------------------------------
  let token = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function edited(rerun = true): void {
    refreshHead()
    if (rerun) scheduleRun()
  }

  function scheduleRun(delay = AUTO_DELAY_MS): void {
    if (timer) clearTimeout(timer)
    timer = null
    if (!auto.checked) return
    timer = setTimeout(() => {
      timer = null
      const problems = strategyProblems(current())
      if (problems.length > 0) {
        results.showProblems(problems, `${problems.length} problem${problems.length === 1 ? '' : 's'} to fix before it can run`)
        return
      }
      void run()
    }, delay)
  }

  async function run(): Promise<void> {
    const mine = ++token
    const strategy = structuredClone(current())
    results.progress('Running…')
    runButton.textContent = 'Running…'
    try {
      const result = await runStrategy(strategy, data, {
        catalogue: catalogue?.server ?? null,
        onProgress: (text) => {
          if (mine === token) results.progress(text)
        },
        isCancelled: () => mine !== token
      })
      if (mine !== token) return
      lastRun = result
      publishRun(RUN_KEY, result)
      results.showRun(result)
      if (selected) results.select(selected)
      await chart?.setInstrument(result.symbol)
      chart?.draw()
      // The editor shows each timeframe's signal count; redraw it unless the user is typing in it.
      if (!editorBox.contains(document.activeElement)) editor.render()
    } catch (err) {
      if (err instanceof RunCancelled || mine !== token) return
      if (err instanceof RunError) results.showProblems(err.problems, err.message)
      else {
        console.error('[lab] run failed', err)
        results.showMessage(`The run failed: ${err instanceof Error ? err.message : String(err)}`, 'error')
      }
    } finally {
      if (mine === token) {
        results.progress(null)
        runButton.textContent = 'Run'
      }
    }
  }

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void run()
    }
  })

  window.addEventListener('beforeunload', (event) => {
    if (![...drafts.keys()].some((id) => unsaved(id))) return
    event.preventDefault()
    event.returnValue = ''
  })

  // -- the chart --------------------------------------------------------------------------------
  let chart: LabChart | null = null
  refreshHead()
  try {
    chart = await mountLabChart(chartBox, current().instrument, theme, () => ({ runKey: RUN_KEY, show, selected }))
  } catch (err) {
    console.error('[lab] the chart could not be built', err)
    const failed = el('p', 'wd-lab-error')
    failed.textContent = 'The chart could not be built; the results below still work.'
    chartBox.appendChild(failed)
  }
  scheduleRun(0)
}

// -- the chart ----------------------------------------------------------------------------------------

interface LabChart {
  setInstrument(symbol: string): Promise<void>
  /** Redraw the run (after a run, or a change of what is shown). */
  draw(): void
  select(entryId: string | null): void
  /** Bring an instant (absolute) on screen, on the run's candle grid. */
  seek(at: number, grid: CandleGrid): void
}

/** One chart pane -- the dashboard's own component, datafeed and plugins, so every indicator the
 * dashboard offers can be put beside the run -- with the `LAB:draft` overlay on its price pane. */
async function mountLabChart(
  container: HTMLElement,
  instrument: string,
  theme: string,
  view: () => { runKey: string; show: ShowOptions; selected: string | null }
): Promise<LabChart> {
  registerLabTemplate()
  const [vendor, ticker] = instrument.split(':')
  const layout = defaultLayout(instrument)
  layout.panes = [{ s: ticker, ...(vendor !== 'oanda' ? { v: vendor } : {}), p: DEFAULT_PERIOD, mi: [], si: [] }]
  const hydrated = await hydrateLayout(layout)
  const levels = createLevelsIndicators()
  const pluginHost = await createPluginHost({
    plugins: builtinPlugins(levels.plugin),
    facilities: createFacilities({}),
    paneDocs: {},
    requestPersist: () => {}
  })
  let symbol = instrument
  let rev = 0
  let selected: string | null = null
  const periods = availablePeriods()
  const chartPro = new KLineChartPro({
    container,
    locale: 'en-US',
    theme,
    timezone: 'America/New_York',
    symbol: hydrated.panes[0].symbol,
    period: hydrated.panes[0].period,
    periods,
    starredPeriods: ['3m', '5m', '15m', '1h', '4h', '1D'],
    onStarredPeriodsChange: () => {},
    mainIndicators: [],
    subIndicators: [],
    indicatorGroups: pluginHost.groups,
    indicatorParamsValidator: pluginHost.validateParams,
    indicatorSettingsHandler: pluginHost.handleSettings,
    indicatorSettingsOwned: pluginHost.ownsSettings,
    indicatorSettingsModel: pluginHost.settingsModel,
    datafeed: () => new WdashboardDatafeed(),
    paneLayout: hydrated.preset,
    panes: hydrated.panes.map(toPaneOptions),
    activePane: 'p1',
    onPanesChange: (panes) => {
      pluginHost.sync(panes)
      draw()
    },
    onPeriodChange: () => draw(),
    onSymbolChange: () => draw()
  })

  const pane = () => chartPro.getPanes()[0] ?? null

  function extend(): LabExtendData {
    const p = pane()
    const v = view()
    return {
      runKey: v.runKey,
      rev,
      chartInterval: p ? periodToResolution(p.getPeriod() as Period) : DEFAULT_PERIOD,
      show: { ...v.show },
      selected: selected ?? v.selected
    }
  }

  function draw(): void {
    const chart = pane()?.getChart()
    if (!chart) return
    rev++
    const extendData = extend()
    if (chart.getIndicators({ name: LAB_DRAFT_TEMPLATE }).length === 0) {
      chart.createIndicator({ name: LAB_DRAFT_TEMPLATE, paneId: 'candle_pane', extendData }, true)
    } else chart.overrideIndicator({ name: LAB_DRAFT_TEMPLATE, extendData })
  }

  return {
    async setInstrument(next: string) {
      if (next === symbol) return
      symbol = next
      const at = next.indexOf(':')
      const info: SymbolInfo = await fetchSymbolInfo(next.slice(at + 1), next.slice(0, at))
      pane()?.setSymbol(info)
    },
    draw,
    select(entryId) {
      selected = entryId
      draw()
    },
    seek(at: number, grid: CandleGrid) {
      const p = pane()
      if (!p) return
      const interval = periodToResolution(p.getPeriod() as Period)
      // The bar in force at the instant -- where the overlay draws what became knowable then --
      // by its own timestamp on the pane's clock.
      p.seekTo(grid.toWire(interval, grid.start(interval, at)))
    }
  }
}
