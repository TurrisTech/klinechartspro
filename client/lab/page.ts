import { KLineChartPro, type Period, type SymbolInfo } from '../../src'
import { Arming } from '../ui/arming'
import { button, el, input, select } from '../ui/dom'
import { WdashboardDatafeed } from '../datafeed'
import { defaultLayout, hydrateLayout, toPaneOptions } from '../layout'
import { createLevelsIndicators } from '../levels/indicator'
import { availablePeriods } from '../periods'
import { builtinPlugins } from '../builtins'
import { createFacilities } from '../facilities'
import { createPluginHost } from '../plugins'
import type { CandleGrid } from '../time/timeframes'
import { fetchSymbolInfo, fetchSymbols, DEFAULT_VENDOR, splitInstrumentKey, symbolKey } from '../symbols'
import { loadLabCatalogue, labIntervals, type LabCatalogue } from './catalogue'
import { createBasketPanel } from './basketview'
import { HttpLabData } from './data'
import { download, fileStem, ImportError, strategyJson } from './export'
import { createStrategyEditor } from './editor'
import { normalInstrument, type Problem, utcDay } from './model'
import { DEFAULT_SHOW, LAB_DRAFT_TEMPLATE, type LabExtendData, publishRun, registerLabTemplate, type ShowOptions } from './overlay'
import { createResultsView } from './results'
import { createRunsPanel, type RunRecord } from './runs'
import { LabSession, type NewKind } from './session'
import { createSweepPanel } from './sweepview'
import { StrategyStore } from './store'
import { periodToResolution } from '../time/intervals'

// THE STRATEGY LAB: a page of the dashboard (`/lab`) for developing a strategy's rules -- the
// graph that joins signals into cascades, which of its nodes are entries, and what happens after
// them -- against history, where the dashboard is for watching the market.
//
//   header   which strategy, Save, the instrument and window it runs on, Run -- and two menus:
//            "⋯" (new, export, revert, delete) and Options (auto-run, a holdout, what the chart
//            shows), so the row holds what is used on every visit and nothing else
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
// What is open, the drafts, saving and deleting, the header's settings and the runs are the
// session's (./session.ts `LabSession`, no DOM). This module is the DOM around it -- the header,
// the auto-run timer, the Delete button's second press, the chart's selection and what it shows --
// and after each action draws what the session holds.
//
// Keys: Ctrl+Enter runs, Ctrl+S saves, `[` / `]` step the chart through the entries (or the
// trades, on that tab) -- the last two anywhere but in a text field.

const RUN_KEY = 'lab-page'
const CURRENT_KEY = 'wd.lab.current'
const AUTO_KEY = 'wd.lab.autorun'
const SPLIT_KEY = 'wd.lab.split'
const AUTO_DELAY_MS = 700
/** How long an armed Delete (or Discard) waits for its second press. */
const DELETE_CONFIRM_MS = 3000
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

/** Whether a key press belongs to a field being typed in rather than to the page. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && !['checkbox', 'radio', 'button'].includes(target.type))
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
  root.innerHTML = ''

  // -- the session: the drafts, the runs, what is open (./session.ts) -----------------------------
  const session = new LabSession(
    { store, data: new HttpLabData(), newData: () => new HttpLabData(), catalogue: catalogue?.server ?? null, clock: () => Date.now() },
    { requested: params.get('strategy'), remembered: storageGet(CURRENT_KEY) }
  )

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

  let selected: string | null = null
  const results = createResultsView({
    onPick: (pick) => {
      selected = pick.entryId
      chart?.select(pick.entryId)
      if (session.lastRun) chart?.seek(pick.at, session.lastRun.grid)
    },
    onProblem: (problem) => reveal(problem)
  })
  main.appendChild(results.element)

  // -- this session's runs, a sweep, a basket ------------------------------------------------------
  const runLabel = (r: RunRecord): string =>
    `run ${session.runNumber(r)}, ${new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(r.ranAt)}`
  const runsPanel = createRunsPanel({
    onPin: (record) => {
      session.pin(record)
      showHistory()
    },
    onRestore: (record) => {
      session.restore(record)
      editor.setStrategy(session.current)
      edited()
    }
  })
  results.addPanel({ id: 'runs', label: () => `Runs ${session.runs().length || ''}`.trim(), element: runsPanel.element })
  function showHistory(): void {
    runsPanel.render(session.runs(), session.baseline(), session.shownRunId())
    const baseline = session.comparedBaseline()
    results.setBaseline(baseline ? { figures: baseline.figures, label: runLabel(baseline) } : null)
    results.refreshTabs()
  }

  const paramInfo = (plugin: string, variant: string, name: string) => {
    const p = catalogue?.signals.find((f) => f.plugin === plugin && f.variant === variant)?.params.find((x) => x.name === name)
    return p ? { type: p.type, min: p.min, max: p.max } : null
  }
  const sweepPanel = createSweepPanel({
    strategy: () => session.current,
    paramInfo,
    // A sweep compares whole runs: no rule needs an account of its own.
    run: (strategy, isCancelled) => session.sweepRun(strategy, isCancelled),
    use: (target, value) => {
      target.apply(session.current, value)
      editor.render()
      edited()
    }
  })
  results.addPanel({ id: 'sweep', label: () => 'Sweep', element: sweepPanel.element })

  const basketPanel = createBasketPanel({
    strategy: () => session.current,
    symbols: () => fetchSymbols('').then((list) => list.map(symbolKey)),
    run: (strategy, symbol, isCancelled) => session.basketRun(strategy, symbol, isCancelled),
    open: (symbol) => {
      session.setInstrument(symbol)
      editor.render()
      edited()
    }
  })
  results.addPanel({ id: 'basket', label: () => 'Basket', element: basketPanel.element })

  const editor = createStrategyEditor(
    session.current,
    {
      catalogue,
      intervals: () => labIntervals(session.current.instrument),
      counts: () => session.signalCounts()
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

  const nameInput = input('text', session.current.name, (value) => {
    session.rename(value)
    edited(false)
  })
  nameInput.className = 'kc-input wd-lab-name'
  nameInput.setAttribute('aria-label', 'Name')

  /** A new draft: the rank 85 rules, the rule-event pair, or a copy of this one. */
  function createNew(kind: NewKind): void {
    session.create(kind)
    opened()
  }

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
      session.importFile(await file.text())
      saveNote.textContent = ''
      opened()
    } catch (err) {
      saveNote.textContent = `Could not import ${file.name}: ${err instanceof ImportError ? err.message : String(err)}`
    }
  })
  const exportButton = button('wd-lab-menu-item', 'Export to a file', () => download(`${fileStem(session.current.name)}.strategy.json`, strategyJson(session.current), 'application/json'))
  exportButton.title = 'This strategy (the draft, as it stands) as a file; New from a file reads it back, here or on another dashboard'

  const save = button('kc-button kc-button-primary', 'Save', () => {
    try {
      session.save()
      saveNote.textContent = ''
    } catch (err) {
      saveNote.textContent = err instanceof Error ? err.message : String(err)
    }
    refreshHead()
  })
  save.title = 'Keep this strategy. A dashboard pane or an alert reads what is saved.'
  const revert = button('wd-lab-menu-item', 'Revert to the saved version', () => {
    if (!session.revert()) return
    editor.setStrategy(session.current)
    refreshHead()
    scheduleRun()
  })
  revert.title = 'Discard the changes since the last Save'
  /** A saved strategy is deleted; a draft never saved is discarded -- the same button. */
  const removeWord = (): string => (session.isSaved() ? 'Delete' : 'Discard')
  const paintRemove = (): void => {
    const armed = deleteArming.key !== null
    remove.textContent = armed ? `${removeWord()}?` : removeWord()
    remove.classList.toggle('is-armed', armed)
  }
  const deleteArming = new Arming(paintRemove, DELETE_CONFIRM_MS)
  /** Unarmed, with the word repainted either way: how a strategy just opened gets its own. */
  const disarm = (): void => {
    deleteArming.disarm()
    paintRemove()
  }
  const remove = button('wd-lab-menu-item wd-lab-delete', 'Delete', () => {
    if (!deleteArming.press('delete')) return
    closePops()
    try {
      session.remove()
    } catch (err) {
      saveNote.textContent = err instanceof Error ? err.message : String(err)
      return
    }
    opened()
  })
  remove.title = 'Delete this strategy (press twice)'
  remove.addEventListener('blur', disarm)
  const saveNote = el('span', 'wd-lab-save-note')

  // The run's instrument and window.
  const instrument = input('text', session.current.instrument, () => {})
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
        option.value = symbolKey(s)
        symbols.appendChild(option)
      }
    })
    .catch(() => {})
  instrument.addEventListener('change', () => {
    session.setInstrument(normalInstrument(instrument.value))
    instrument.value = session.current.instrument
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
      // The same span, as dates or as days.
      session.setWindowKind(value)
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
    if (session.setDays(Number(days.value))) edited()
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
      if (session.setRange(fromDate.value, toDate.value)) edited()
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
      session.setHoldoutKind(value)
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
    if (session.setHoldoutPercent(Number(holdoutPercent.value))) edited()
  })
  const holdoutPercentWord = el('span', '')
  holdoutPercentWord.textContent = '%'
  const holdoutDate = document.createElement('input')
  holdoutDate.type = 'date'
  holdoutDate.className = 'kc-input wd-lab-date'
  holdoutDate.setAttribute('aria-label', 'Holdout from')
  holdoutDate.title = 'The first day held out (UTC)'
  holdoutDate.addEventListener('change', () => {
    if (session.setHoldoutFrom(holdoutDate.value)) edited()
  })
  const holdoutLabel = el('div', 'wd-lab-window')
  holdoutLabel.append(holdoutKind, holdoutPercent, holdoutPercentWord, holdoutDate)

  const runButton = button('kc-button kc-button-primary wd-lab-run', 'Run', () => {
    if (!session.running) {
      void run()
      return
    }
    stop()
    if (session.lastRun) results.showStale('Stopped: these are the last finished run’s results. Run (Ctrl+Enter) to try again.')
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

  // The "⋯" menu: everything about the strategy that is not Save.
  const menuItem = (label: string, onClick: () => void, title = ''): HTMLButtonElement => {
    const b = button('wd-lab-menu-item', label, () => {
      onClick()
      closePops()
    })
    if (title) b.title = title
    return b
  }
  const strategyMenu = popover('⋯', 'New, export, revert or delete', (panel) => {
    const newHead = el('div', 'wd-lab-menu-head')
    newHead.textContent = 'New'
    panel.append(
      newHead,
      menuItem('AREV21 rank 85 rules (the overlay’s 1D graph)', () => createNew('rank85')),
      menuItem('Rule events, no graph', () => createNew('rule')),
      menuItem('A copy of this one', () => createNew('copy')),
      menuItem('From a file…', () => importFile.click(), 'A strategy file exported here or on another dashboard, as a new strategy'),
      el('hr', 'wd-lab-menu-rule'),
      exportButton,
      revert,
      remove
    )
  })
  exportButton.addEventListener('click', () => closePops())
  revert.addEventListener('click', () => closePops())

  // Options: what changes how a run is read, and what the chart draws.
  const optionsMenu = popover('Options', 'Auto-run, a holdout, and what the chart shows', (panel) => {
    const showHead = el('div', 'wd-lab-menu-head')
    showHead.textContent = 'On the chart'
    const holdHead = el('div', 'wd-lab-menu-head')
    holdHead.textContent = 'Hold out'
    panel.append(autoLabel, holdHead, holdoutLabel, showHead, showBox)
  })

  const left = el('div', 'wd-lab-head-left')
  left.append(back, brand, picker, nameInput, save, strategyMenu, importFile, saveNote)
  const right = el('div', 'wd-lab-head-right')
  right.append(instrument, symbols, daysLabel, runButton, optionsMenu)
  head.append(left, right)
  document.addEventListener('click', (event) => {
    for (const pop of head.querySelectorAll<HTMLDetailsElement>('details.wd-lab-pop[open]')) if (!pop.contains(event.target as Node)) pop.open = false
  })
  function closePops(): void {
    for (const pop of head.querySelectorAll<HTMLDetailsElement>('details.wd-lab-pop[open]')) pop.open = false
  }

  function refreshHead(): void {
    picker.innerHTML = ''
    for (const s of session.strategies()) {
      const option = document.createElement('option')
      option.value = s.id
      option.textContent = `${s.name || 'Untitled'}${s.saved ? '' : ' (not saved)'}${s.unsaved && s.saved ? ' •' : ''}`
      picker.appendChild(option)
    }
    picker.value = session.currentId
    const current = session.current
    if (document.activeElement !== nameInput) nameInput.value = current.name
    instrument.value = current.instrument
    const w = current.window
    windowKind.value = w.kind
    days.value = w.kind === 'days' ? String(w.days) : ''
    if (w.kind === 'range') {
      if (document.activeElement !== fromDate) fromDate.value = utcDay(w.from)
      if (document.activeElement !== toDate) toDate.value = utcDay(w.to - DAY_MS)
    }
    for (const n of [days, daysWord]) n.hidden = w.kind !== 'days'
    for (const n of [fromDate, toWord, toDate]) n.hidden = w.kind !== 'range'
    const h = current.holdout
    holdoutKind.value = h?.kind ?? ''
    if (h?.kind === 'percent' && document.activeElement !== holdoutPercent) holdoutPercent.value = String(h.percent)
    if (h?.kind === 'from' && document.activeElement !== holdoutDate) holdoutDate.value = utcDay(h.at)
    for (const n of [holdoutPercent, holdoutPercentWord]) n.hidden = h?.kind !== 'percent'
    holdoutDate.hidden = h?.kind !== 'from'
    const dirty = session.unsaved(session.currentId)
    const saved = session.isSaved()
    save.disabled = !dirty || !!store.loadError
    revert.disabled = !dirty || !saved
    save.textContent = saved ? 'Save' : 'Save new'
    revert.hidden = !saved
    if (deleteArming.key === null) remove.textContent = removeWord()
    remove.title = saved ? 'Delete this strategy (press twice)' : 'Discard this draft, never saved (press twice)'
    // A fresh default nobody has touched holds nothing to discard.
    remove.disabled = !session.removable
    root.classList.toggle('is-unsaved', dirty)
    editor.markProblems(session.problems())
    sweepPanel.refresh()
  }

  /** Take the page to a problem's slot: the editor's, or the header's instrument and window. */
  function reveal(problem: Problem): void {
    if (editor.reveal(problem)) return
    const holdout = /holdout/.test(problem.message) ? (session.current.holdout?.kind === 'from' ? holdoutDate : holdoutPercent) : null
    const field = holdout ?? (problem.where === 'Instrument' ? instrument : session.current.window.kind === 'days' ? days : fromDate)
    field.focus()
    field.classList.remove('is-flash')
    void field.offsetWidth
    field.classList.add('is-flash')
  }

  function switchTo(id: string): void {
    if (session.open(id)) opened()
  }

  /** The page after the session opened a strategy (another one, a new draft, or the one left
   * after a delete): nothing running, the editor and the header on it, no run shown yet. */
  function opened(): void {
    showIdle()
    disarm()
    storageSet(CURRENT_KEY, session.currentId)
    editor.setStrategy(session.current)
    refreshHead()
    results.showMessage('Press Run to evaluate the strategy over its window.')
    showHistory()
    publishRun(RUN_KEY, null)
    chart?.draw()
    void chart?.setInstrument(session.current.instrument)
    scheduleRun(0)
  }

  // -- running ----------------------------------------------------------------------------------
  let timer: ReturnType<typeof setTimeout> | null = null

  function edited(rerun = true): void {
    session.touch()
    refreshHead()
    if (!rerun) return
    if (auto.checked) {
      scheduleRun()
      return
    }
    // No run is coming: say so, and what stops one.
    const problems = session.problems()
    if (problems.length > 0) results.showProblems(problems, `${problems.length} problem${problems.length === 1 ? '' : 's'} to fix before it can run`)
    else if (session.lastRun) results.showStale('Edited since this run: Run (Ctrl+Enter) to see the change')
  }

  function scheduleRun(delay = AUTO_DELAY_MS): void {
    if (timer) clearTimeout(timer)
    timer = null
    if (!auto.checked) return
    timer = setTimeout(() => {
      timer = null
      const problems = session.problems()
      if (problems.length > 0) {
        results.showProblems(problems, `${problems.length} problem${problems.length === 1 ? '' : 's'} to fix before it can run`)
        return
      }
      void run()
    }, delay)
  }

  /** Abandon the run in progress; what the last one found stays shown. */
  function stop(): void {
    session.stop()
    showIdle()
  }

  /** The Run button and the progress line with no run going. */
  function showIdle(): void {
    results.progress(null)
    runButton.textContent = 'Run'
    runButton.title = 'Run the strategy over its window (Ctrl+Enter)'
  }

  function showFailure(err: unknown): void {
    console.error('[lab] run failed', err)
    results.showProblems([], `The run failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  async function run(): Promise<void> {
    if (timer) clearTimeout(timer)
    timer = null
    results.progress('Running…')
    runButton.textContent = 'Stop'
    runButton.title = 'Stop this run'
    const outcome = await session.run((text) => results.progress(text))
    try {
      if (outcome.kind === 'done') {
        const result = outcome.run
        publishRun(RUN_KEY, result)
        showHistory()
        results.showRun(result)
        if (selected) results.select(selected)
        await chart?.setInstrument(result.symbol)
        chart?.draw()
        // The editor shows each timeframe's signal count; redraw it unless the user is typing in it.
        if (!editorBox.contains(document.activeElement)) editor.render()
      } else if (outcome.kind === 'problems') results.showProblems(outcome.problems, outcome.message)
      else if (outcome.kind === 'failed') showFailure(outcome.error)
    } catch (err) {
      // Showing the run failed: said as a failed run is, unless a newer run has taken over.
      if (session.isLatest(outcome.ticket)) showFailure(err)
    } finally {
      if (session.settle(outcome.ticket)) showIdle()
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
    if (!session.hasUnsavedWork()) return
    event.preventDefault()
    event.returnValue = ''
  })

  // -- the chart --------------------------------------------------------------------------------
  let chart: LabChart | null = null
  refreshHead()
  try {
    chart = await mountLabChart(chartBox, session.current.instrument, theme, () => ({ runKey: RUN_KEY, show, selected }))
  } catch (err) {
    console.error('[lab] the chart could not be built', err)
    const failed = el('p', 'wd-lab-error')
    failed.textContent = 'The chart could not be built; the results below still work.'
    chartBox.appendChild(failed)
  }
  scheduleRun(0)
}

// -- a header menu ------------------------------------------------------------------------------------

/** A button that opens a small panel under it (a `details`, so it needs no dialog and Escape-free
 * code: a click outside or on an item closes it). */
function popover(label: string, title: string, build: (panel: HTMLElement) => void): HTMLDetailsElement {
  const details = document.createElement('details')
  details.className = 'wd-lab-pop'
  const summary = document.createElement('summary')
  summary.className = 'kc-button kc-button-outline wd-lab-pop-button'
  summary.textContent = label
  summary.title = title
  summary.setAttribute('aria-label', title)
  const panel = el('div', 'wd-lab-pop-panel')
  build(panel)
  details.append(summary, panel)
  details.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      details.open = false
      summary.focus()
    }
  })
  return details
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
  const { vendor, ticker } = splitInstrumentKey(instrument)
  const layout = defaultLayout(instrument)
  layout.panes = [{ s: ticker, ...(vendor !== DEFAULT_VENDOR ? { v: vendor } : {}), p: DEFAULT_PERIOD, mi: [], si: [] }]
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
      const parts = splitInstrumentKey(next)
      const info: SymbolInfo = await fetchSymbolInfo(parts.ticker, parts.vendor)
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
