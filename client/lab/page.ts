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
import { createBasketPanel } from './basketview'
import { HttpLabData } from './data'
import { download, fileStem, ImportError, readStrategyFile, strategyJson } from './export'
import { createStrategyEditor } from './editor'
import { newStrategyId, type Problem, rank85Strategy, ruleStrategy, type Strategy, strategyProblems } from './model'
import { DEFAULT_SHOW, LAB_DRAFT_TEMPLATE, type LabExtendData, publishRun, registerLabTemplate, type ShowOptions } from './overlay'
import { createResultsView } from './results'
import { createRunsPanel, type RunRecord, RunHistory } from './runs'
import { createSweepPanel } from './sweepview'
import { type LabRun, RunCancelled, RunError, runStrategy, runWindow } from './runner'
import { StrategyStore } from './store'

// THE STRATEGY LAB: a page of the dashboard (`/lab`) for developing a strategy's rules -- the
// graph that joins signals into cascades, which of its nodes are entries, and what happens after
// them -- against history, where the dashboard is for watching the market.
//
//   header   which strategy, Save / Revert, the instrument and window it runs on, Run
//   editor   every slot of the strategy (./editor.ts)
//   chart    the instrument, with the run drawn on it (./overlay.ts, the `LAB:draft` template)
//   results  what the run found (./results.ts); a row takes the chart there. The bar between
//            the chart and the results drags (double-click: back to the default split). After
//            the run's own tabs: Runs (this session's runs and the baseline, ./runs.ts), Sweep
//            (one number over a range, ./sweepview.ts) and Basket (many instruments,
//            ./basketview.ts)
//
// Editing is a DRAFT: nothing is kept until Save (./store.ts), and a dashboard pane or an alert
// reading a strategy reads what is saved. With Auto-run on, an edit that leaves the strategy
// runnable runs it again; the data layer holds what it has read, so a re-run fetches nothing.
// With it off, the results say they are out of date until Run.
//
// Keys: Ctrl+Enter runs, Ctrl+S saves, `[` / `]` step the chart through the entries (or the
// trades, on that tab) -- the last two anywhere but in a text field.

const RUN_KEY = 'lab-page'
const CURRENT_KEY = 'wd.lab.current'
const AUTO_KEY = 'wd.lab.autorun'
const SPLIT_KEY = 'wd.lab.split'
const AUTO_DELAY_MS = 700
const DEFAULT_PERIOD = '5m'
const DAY_MS = 86_400_000
/** Where a picked entry lands across the chart: 40% from the left, 60% of the view after it. */
const SEEK_FRACTION = 0.4
/** The results' share of the main column's height, by default and at the drag's two ends. */
const SPLIT = { default: 0.42, min: 0.12, max: 0.85 }

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

/** A `yyyy-mm-dd` day of a range window, which counts in UTC days, the last one included. */
function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function dayStart(day: string): number | null {
  const ms = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(ms) ? ms : null
}

/** Whether a key press belongs to a field being typed in rather than to the page. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type))
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
  /** Drafts the user has edited or created. Only these can hold work worth a "leave the page?"
   * prompt: the default strategy a first visit opens on is unsaved but holds nothing of theirs. */
  const touched = new Set<string>()

  // -- layout -----------------------------------------------------------------------------------
  const head = el('header', 'wd-lab-head')
  const bodyBox = el('div', 'wd-lab-body')
  const editorBox = el('aside', 'wd-lab-side')
  const main = el('main', 'wd-lab-main')
  const chartBox = el('div', 'wd-lab-chart')
  const split = splitter(main)
  main.append(chartBox, split)
  bodyBox.append(editorBox, main)
  root.append(head, bodyBox)

  let lastRun: LabRun | null = null
  let selected: string | null = null
  const results = createResultsView({
    onPick: (pick) => {
      selected = pick.entryId
      chart?.select(pick.entryId)
      if (lastRun) chart?.seek(pick.at, lastRun.grid)
    },
    onProblem: (problem) => reveal(problem)
  })
  main.appendChild(results.element)

  // -- this session's runs, a sweep, a basket ------------------------------------------------------
  const history = new RunHistory()
  /** The run on the chart, as the history keeps it. */
  let currentRecord: RunRecord | null = null
  const runLabel = (r: RunRecord): string => {
    const n = history.list(r.strategy.id).indexOf(r) + 1
    return `run ${n}, ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(r.ranAt)}`
  }
  const runsPanel = createRunsPanel({
    onPin: (record) => {
      history.pin(currentId, record?.id ?? null)
      showHistory()
    },
    onRestore: (record) => {
      drafts.set(currentId, { ...structuredClone(record.strategy), id: currentId })
      editor.setStrategy(current())
      edited()
    }
  })
  results.addPanel({ id: 'runs', label: () => `Runs ${history.list(currentId).length || ''}`.trim(), element: runsPanel.element })
  function showHistory(): void {
    const baseline = history.baseline(currentId)
    runsPanel.render(history.list(currentId), baseline, currentRecord?.strategy.id === currentId ? currentRecord.id : null)
    results.setBaseline(baseline && baseline.id !== currentRecord?.id ? { figures: baseline.figures, label: runLabel(baseline) } : null)
    results.refreshTabs()
  }

  const paramInfo = (plugin: string, variant: string, name: string) => {
    const p = catalogue?.signals.find((f) => f.plugin === plugin && f.variant === variant)?.params.find((x) => x.name === name)
    return p ? { type: p.type, min: p.min, max: p.max } : null
  }
  const sweepPanel = createSweepPanel({
    strategy: () => current(),
    paramInfo,
    run: (strategy, isCancelled) => runStrategy(strategy, data, { catalogue: catalogue?.server ?? null, isCancelled }),
    use: (target, value) => {
      target.apply(current(), value)
      editor.render()
      edited()
    }
  })
  results.addPanel({ id: 'sweep', label: () => 'Sweep', element: sweepPanel.element })

  const basketPanel = createBasketPanel({
    strategy: () => current(),
    symbols: () => fetchSymbols('').then((list) => list.map((s) => `${s.exchange ?? 'oanda'}:${s.ticker}`)),
    // The lab's own instrument reads through the page's data; any other through a data layer of
    // its own, dropped with its run, so a basket of 28 never holds 28 instruments' bars at once.
    run: (strategy, symbol, isCancelled) =>
      runStrategy(strategy, symbol === current().instrument ? data : new HttpLabData(), { symbol, catalogue: catalogue?.server ?? null, isCancelled }),
    open: (symbol) => {
      current().instrument = symbol
      editor.render()
      edited()
    }
  })
  results.addPanel({ id: 'basket', label: () => 'Basket', element: basketPanel.element })

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
      { value: 'copy', label: 'A copy of this one' },
      { value: 'import', label: 'From a file…' }
    ],
    '',
    (value) => {
      newPicker.value = ''
      if (!value) return
      const now = Date.now()
      let fresh: Strategy
      if (value === 'import') {
        importFile.click()
        return
      }
      if (value === 'copy') fresh = { ...structuredClone(current()), id: newStrategyId(now), name: `${current().name} copy`, createdAt: now, updatedAt: now }
      else fresh = value === 'rule' ? ruleStrategy(now) : rank85Strategy(now)
      fresh.instrument = current().instrument
      drafts.set(fresh.id, fresh)
      touched.add(fresh.id)
      switchTo(fresh.id)
    }
  )
  newPicker.classList.add('wd-lab-new')
  newPicker.setAttribute('aria-label', 'New strategy')

  // A strategy to or from a file: how one moves between the dev and prod dashboards.
  const importFile = document.createElement('input')
  importFile.type = 'file'
  importFile.accept = '.json,application/json'
  importFile.hidden = true
  importFile.addEventListener('change', async () => {
    const file = importFile.files?.[0]
    importFile.value = ''
    if (!file) return
    try {
      const fresh = readStrategyFile(await file.text())
      drafts.set(fresh.id, fresh)
      touched.add(fresh.id)
      saveNote.textContent = ''
      switchTo(fresh.id)
    } catch (err) {
      saveNote.textContent = `Could not import ${file.name}: ${err instanceof ImportError ? err.message : String(err)}`
    }
  })
  const exportButton = button('kc-button kc-button-outline', 'Export', () => download(`${fileStem(current().name)}.strategy.json`, strategyJson(current()), 'application/json'))
  exportButton.title = 'Save this strategy (the draft, as it stands) as a file; New… ▸ From a file reads it back, here or on another dashboard'

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
  /** A saved strategy is deleted; a draft never saved is discarded -- the same button. */
  const removeWord = (): string => (store.get(currentId) ? 'Delete' : 'Discard')
  const disarm = (): void => {
    if (deleteArmed) clearTimeout(deleteArmed)
    deleteArmed = null
    remove.textContent = removeWord()
    remove.classList.remove('is-armed')
  }
  const remove = button('kc-button kc-button-outline wd-lab-delete', 'Delete', () => {
    if (!deleteArmed) {
      remove.textContent = `${removeWord()}?`
      remove.classList.add('is-armed')
      deleteArmed = setTimeout(disarm, 3000)
      return
    }
    disarm()
    try {
      if (store.get(currentId)) store.remove(currentId)
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
  remove.addEventListener('blur', disarm)
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

  // The window: the last N days, or a range of UTC days with the last one included.
  const windowKind = select(
    [
      { value: 'days', label: 'last' },
      { value: 'range', label: 'from' }
    ],
    'days',
    (value) => {
      const w = current().window
      if (value === 'range' && w.kind === 'days') {
        // The same span, as dates: from N days ago through today.
        const today = dayStart(dayOf(Date.now())) as number
        current().window = { kind: 'range', from: today - (w.days - 1) * DAY_MS, to: today + DAY_MS }
      } else if (value === 'days' && w.kind === 'range') {
        current().window = { kind: 'days', days: Math.max(1, Math.round((w.to - w.from) / DAY_MS)) }
      }
      refreshHead()
      edited()
    }
  )
  windowKind.classList.add('wd-lab-window-kind')
  windowKind.setAttribute('aria-label', 'Window')
  windowKind.title = 'Run over the last N days, or between two dates'
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
  const daysWord = el('span', '')
  daysWord.textContent = 'days'
  const dateInput = (label: string): HTMLInputElement => {
    const i = document.createElement('input')
    i.type = 'date'
    i.className = 'kc-input wd-lab-date'
    i.setAttribute('aria-label', label)
    i.title = `${label} (a UTC day; the last day is included)`
    i.addEventListener('change', () => {
      const from = dayStart(fromDate.value)
      const to = dayStart(toDate.value)
      if (from === null || to === null) return
      current().window = { kind: 'range', from, to: to + DAY_MS }
      edited()
    })
    return i
  }
  const fromDate = dateInput('First day')
  const toDate = dateInput('Last day')
  const toWord = el('span', '')
  toWord.textContent = 'to'
  const daysLabel = el('div', 'wd-lab-window')
  daysLabel.append(windowKind, days, daysWord, fromDate, toWord, toDate)

  // The holdout: the end of the window kept back from fitting (model.ts `HoldoutSpec`).
  const holdoutKind = select(
    [
      { value: '', label: 'no holdout' },
      { value: 'percent', label: 'hold out the last' },
      { value: 'from', label: 'hold out from' }
    ],
    '',
    (value) => {
      if (value === 'percent') current().holdout = { kind: 'percent', percent: 30 }
      else if (value === 'from') {
        const { from, to } = runWindow(current())
        current().holdout = { kind: 'from', at: dayStart(dayOf(to - (to - from) * 0.3)) as number }
      } else current().holdout = null
      refreshHead()
      edited()
    }
  )
  holdoutKind.classList.add('wd-lab-window-kind')
  holdoutKind.setAttribute('aria-label', 'Holdout')
  holdoutKind.title = 'Keep the end of the window back: the results show it beside the rest, so a rule tuned on one part is checked on the other'
  const holdoutPercent = document.createElement('input')
  holdoutPercent.type = 'number'
  holdoutPercent.min = '1'
  holdoutPercent.max = '99'
  holdoutPercent.step = '1'
  holdoutPercent.className = 'kc-input wd-lab-days'
  holdoutPercent.setAttribute('aria-label', 'Holdout percent')
  holdoutPercent.addEventListener('input', () => {
    const n = Number(holdoutPercent.value)
    if (!(n > 0 && n < 100)) return
    current().holdout = { kind: 'percent', percent: n }
    edited()
  })
  const holdoutPercentWord = el('span', '')
  holdoutPercentWord.textContent = '%'
  const holdoutDate = document.createElement('input')
  holdoutDate.type = 'date'
  holdoutDate.className = 'kc-input wd-lab-date'
  holdoutDate.setAttribute('aria-label', 'Holdout from')
  holdoutDate.title = 'The first day held out (UTC)'
  holdoutDate.addEventListener('change', () => {
    const at = dayStart(holdoutDate.value)
    if (at === null) return
    current().holdout = { kind: 'from', at }
    edited()
  })
  const holdoutLabel = el('div', 'wd-lab-window')
  holdoutLabel.append(holdoutKind, holdoutPercent, holdoutPercentWord, holdoutDate)

  let running = false
  const runButton = button('kc-button kc-button-primary wd-lab-run', 'Run', () => {
    if (!running) {
      void run()
      return
    }
    stop()
    if (lastRun) results.showStale('Stopped: these are the last finished run’s results. Run (Ctrl+Enter) to try again.')
  })
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
  left.append(back, brand, picker, nameInput, newPicker, importFile, save, revert, remove, exportButton, saveNote)
  const right = el('div', 'wd-lab-head-right')
  right.append(instrument, symbols, daysLabel, holdoutLabel, runButton, autoLabel, showBox)
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
    windowKind.value = w.kind
    days.value = w.kind === 'days' ? String(w.days) : ''
    if (w.kind === 'range') {
      if (document.activeElement !== fromDate) fromDate.value = dayOf(w.from)
      if (document.activeElement !== toDate) toDate.value = dayOf(w.to - DAY_MS)
    }
    for (const n of [days, daysWord]) n.hidden = w.kind !== 'days'
    for (const n of [fromDate, toWord, toDate]) n.hidden = w.kind !== 'range'
    const h = current().holdout
    holdoutKind.value = h?.kind ?? ''
    if (h?.kind === 'percent' && document.activeElement !== holdoutPercent) holdoutPercent.value = String(h.percent)
    if (h?.kind === 'from' && document.activeElement !== holdoutDate) holdoutDate.value = dayOf(h.at)
    for (const n of [holdoutPercent, holdoutPercentWord]) n.hidden = h?.kind !== 'percent'
    holdoutDate.hidden = h?.kind !== 'from'
    const dirty = unsaved(currentId)
    const saved = !!store.get(currentId)
    save.disabled = !dirty || !!store.loadError
    revert.disabled = !dirty || !saved
    save.textContent = saved ? 'Save' : 'Save new'
    if (!deleteArmed) remove.textContent = removeWord()
    remove.title = saved ? 'Delete this strategy (press twice)' : 'Discard this draft, never saved (press twice)'
    // A fresh default nobody has touched holds nothing to discard.
    remove.disabled = !saved && !touched.has(currentId)
    root.classList.toggle('is-unsaved', dirty)
    editor.markProblems(strategyProblems(current()))
    sweepPanel.refresh()
  }

  /** Take the page to a problem's slot: the editor's, or the header's instrument and window. */
  function reveal(problem: Problem): void {
    if (editor.reveal(problem)) return
    const holdout = /holdout/.test(problem.message) ? (current().holdout?.kind === 'from' ? holdoutDate : holdoutPercent) : null
    const field = holdout ?? (problem.where === 'Instrument' ? instrument : current().window.kind === 'days' ? days : fromDate)
    field.focus()
    field.classList.remove('is-flash')
    void field.offsetWidth
    field.classList.add('is-flash')
  }

  function switchTo(id: string): void {
    if (!drafts.has(id)) {
      const saved = store.get(id)
      if (!saved) return
      drafts.set(id, structuredClone(saved))
    }
    stop()
    disarm()
    currentId = id
    storageSet(CURRENT_KEY, id)
    lastRun = null
    currentRecord = null
    editor.setStrategy(current())
    refreshHead()
    results.showMessage('Press Run to evaluate the strategy over its window.')
    showHistory()
    publishRun(RUN_KEY, null)
    chart?.draw()
    void chart?.setInstrument(current().instrument)
    scheduleRun(0)
  }

  // -- running ----------------------------------------------------------------------------------
  let token = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  function edited(rerun = true): void {
    touched.add(currentId)
    refreshHead()
    if (!rerun) return
    if (auto.checked) {
      scheduleRun()
      return
    }
    // No run is coming: say so, and what stops one.
    const problems = strategyProblems(current())
    if (problems.length > 0) results.showProblems(problems, `${problems.length} problem${problems.length === 1 ? '' : 's'} to fix before it can run`)
    else if (lastRun) results.showStale('Edited since this run: Run (Ctrl+Enter) to see the change')
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

  /** Abandon the run in progress; what the last one found stays shown. */
  function stop(): void {
    token++
    running = false
    results.progress(null)
    runButton.textContent = 'Run'
    runButton.title = 'Run the strategy over its window (Ctrl+Enter)'
  }

  async function run(): Promise<void> {
    if (timer) clearTimeout(timer)
    timer = null
    const mine = ++token
    const strategy = structuredClone(current())
    running = true
    results.progress('Running…')
    runButton.textContent = 'Stop'
    runButton.title = 'Stop this run'
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
      currentRecord = history.add(result)
      publishRun(RUN_KEY, result)
      showHistory()
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
        results.showProblems([], `The run failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    } finally {
      if (mine === token) stop()
    }
  }

  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey
    if (mod && event.key === 'Enter') {
      event.preventDefault()
      void run()
    } else if (mod && (event.key === 's' || event.key === 'S')) {
      // The page's Save, not the browser's "save this page".
      event.preventDefault()
      if (!save.disabled) save.click()
    } else if (!mod && !event.altKey && (event.key === '[' || event.key === ']') && !typing(event.target)) {
      if (results.step(event.key === ']' ? 1 : -1)) event.preventDefault()
    }
  })

  window.addEventListener('beforeunload', (event) => {
    if (![...touched].some((id) => drafts.has(id) && unsaved(id))) return
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

// -- the split ----------------------------------------------------------------------------------------

/** The bar between the chart and the results: dragged (or the arrow keys) it moves the split, a
 * double-click puts it back. The results' share is kept per device, as a fraction of the column,
 * so a window of another height splits the same way. */
function splitter(main: HTMLElement): HTMLElement {
  const bar = el('div', 'wd-lab-split')
  bar.setAttribute('role', 'separator')
  bar.setAttribute('aria-orientation', 'horizontal')
  bar.setAttribute('aria-label', 'Resize the chart and the results')
  bar.title = 'Drag to resize; double-click for the default'
  bar.tabIndex = 0
  const set = (share: number, keep = true): void => {
    const clamped = Math.min(SPLIT.max, Math.max(SPLIT.min, share))
    main.style.setProperty('--wd-lab-results', `${(clamped * 100).toFixed(1)}%`)
    bar.setAttribute('aria-valuenow', String(Math.round(clamped * 100)))
    if (keep) storageSet(SPLIT_KEY, String(clamped))
    current = clamped
  }
  let current = SPLIT.default
  const stored = Number(storageGet(SPLIT_KEY))
  set(stored > 0 ? stored : SPLIT.default, false)
  bar.addEventListener('pointerdown', (event) => {
    event.preventDefault()
    bar.setPointerCapture(event.pointerId)
    bar.classList.add('is-dragging')
    const move = (e: PointerEvent): void => {
      const rect = main.getBoundingClientRect()
      if (rect.height > 0) set((rect.bottom - e.clientY) / rect.height)
    }
    const up = (): void => {
      bar.classList.remove('is-dragging')
      bar.removeEventListener('pointermove', move)
      bar.removeEventListener('pointerup', up)
      bar.removeEventListener('pointercancel', up)
    }
    bar.addEventListener('pointermove', move)
    bar.addEventListener('pointerup', up)
    bar.addEventListener('pointercancel', up)
  })
  bar.addEventListener('dblclick', () => set(SPLIT.default))
  bar.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    set(current + (event.key === 'ArrowUp' ? 0.05 : -0.05))
  })
  return bar
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
      // by its own timestamp on the pane's clock; left of the middle, as what price did NEXT is
      // what a reviewed entry is about.
      p.seekTo(grid.toWire(interval, grid.start(interval, at)), SEEK_FRACTION)
    }
  }
}
