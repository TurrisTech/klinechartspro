import { button, el, iconButton } from '../alerts/dom'
import { type BasketRow, FX_28, MAJORS, poolBasket, runBasket } from './basket'
import { figuresTable } from './figtable'
import { describeMean } from './figures'
import type { Strategy } from './model'
import type { LabRun } from './runner'

// GLUE (DOM). The Basket panel: the draft run on every instrument of a list -- the seven majors,
// the 28 FX pairs, or any -- a row of figures per instrument and the pooled trades of them all.
// "Open" takes the lab to an instrument. Money is each instrument's own quote currency, so the
// rows compare in R and pips.

export interface BasketContext {
  strategy(): Strategy
  /** Instruments the server offers, `vendor:TICKER`, for the add field. */
  symbols(): Promise<string[]>
  /** One run of a copy of the draft on `symbol`; throws `RunCancelled` once `isCancelled` says so. */
  run(strategy: Strategy, symbol: string, isCancelled: () => boolean): Promise<LabRun>
  /** Show `symbol` in the lab: the draft's instrument becomes it. */
  open(symbol: string): void
}

export interface BasketPanel {
  readonly element: HTMLElement
  refresh(): void
}

const LIST_KEY = 'wd.lab.basket'
/** Two at a time: a run is mostly waiting on the server, and the dev server is shared. */
const CONCURRENCY = 2

const signed = (v: number | null | undefined, digits: number): string => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}`)

export function createBasketPanel(ctx: BasketContext): BasketPanel {
  const element = el('div', 'wd-lab-panel wd-lab-basket')
  let list: string[] = stored() ?? MAJORS.map((s) => `oanda:${s}`)
  let rows: Array<BasketRow | null> = []
  let ranOn: string[] = []
  let token = 0
  let running = false
  let started = 0
  /** What the server offers; empty until it answers (then nothing is left out). */
  let offeredSet = new Set<string>()
  const note = el('p', 'wd-lab-note')

  function stored(): string[] | null {
    try {
      const raw = JSON.parse(window.localStorage.getItem(LIST_KEY) ?? 'null')
      return Array.isArray(raw) && raw.every((s) => typeof s === 'string') ? raw : null
    } catch {
      return null
    }
  }
  function keep(): void {
    try {
      window.localStorage.setItem(LIST_KEY, JSON.stringify(list))
    } catch {
      // A per-device convenience only.
    }
  }

  const preset = document.createElement('select')
  preset.className = 'kc-input'
  preset.setAttribute('aria-label', 'Basket')
  for (const [value, text] of [
    ['', 'Fill with…'],
    ['majors', 'the 7 majors'],
    ['fx28', 'the 28 FX pairs'],
    ['this', 'this instrument only']
  ]) {
    const o = document.createElement('option')
    o.value = value
    o.textContent = text
    preset.appendChild(o)
  }
  preset.addEventListener('change', () => {
    const wanted = preset.value === 'majors' ? MAJORS.map((s) => `oanda:${s}`) : preset.value === 'fx28' ? FX_28.map((s) => `oanda:${s}`) : [ctx.strategy().instrument]
    // Only what this server has: dev carries a handful of OANDA instruments, prod all of them.
    const missing = offeredSet.size > 0 ? wanted.filter((s) => !offeredSet.has(s)) : []
    list = wanted.filter((s) => !missing.includes(s))
    note.textContent = missing.length > 0 ? `${missing.length} of the ${wanted.length} are not on this server, so left out: ${missing.map((s) => s.replace(/^oanda:/, '')).join(', ')}.` : ''
    preset.value = ''
    keep()
    renderList()
  })

  const add = document.createElement('input')
  add.type = 'text'
  add.className = 'kc-input wd-lab-instrument'
  add.placeholder = 'add vendor:TICKER'
  add.setAttribute('aria-label', 'Add an instrument')
  add.setAttribute('list', 'wd-lab-basket-symbols')
  const offered = document.createElement('datalist')
  offered.id = 'wd-lab-basket-symbols'
  void ctx
    .symbols()
    .then((symbols) => {
      offeredSet = new Set(symbols)
      renderList()
      for (const s of symbols) {
        const o = document.createElement('option')
        o.value = s
        offered.appendChild(o)
      }
    })
    .catch(() => {})
  const addIt = (): void => {
    const raw = add.value.trim()
    if (!raw) return
    const at = raw.indexOf(':')
    const symbol = at > 0 ? `${raw.slice(0, at).toLowerCase()}:${raw.slice(at + 1).toUpperCase()}` : `oanda:${raw.toUpperCase()}`
    if (!list.includes(symbol)) list.push(symbol)
    add.value = ''
    keep()
    renderList()
  }
  add.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addIt()
  })
  add.addEventListener('change', addIt)

  const chips = el('div', 'wd-lab-chips wd-lab-basket-list')
  const go = button('kc-button kc-button-primary', 'Run basket', () => (running ? stop() : void start()))
  const status = el('span', 'wd-lab-muted')
  const results = el('div', 'wd-lab-basket-results')

  function renderList(): void {
    chips.innerHTML = ''
    for (const symbol of list) {
      const missing = offeredSet.size > 0 && !offeredSet.has(symbol)
      const chip = el('span', `wd-lab-chip wd-lab-basket-chip${missing ? '' : ' is-on'}`)
      if (missing) chip.title = 'Not on this server: its run will fail'
      chip.append(document.createTextNode(symbol.startsWith('oanda:') ? symbol.slice(6) : symbol))
      chip.appendChild(
        iconButton('×', `Take ${symbol} out of the basket`, () => {
          list = list.filter((s) => s !== symbol)
          keep()
          renderList()
        })
      )
      chips.appendChild(chip)
    }
    go.disabled = list.length === 0 && !running
  }

  function stop(): void {
    token++
    running = false
    go.textContent = 'Run basket'
    const done = rows.filter(Boolean).length
    status.textContent = done > 0 ? `Stopped after ${done} of ${ranOn.length}` : ''
  }

  async function start(): Promise<void> {
    if (list.length === 0) return
    const mine = ++token
    const cancelled = (): boolean => mine !== token
    running = true
    started = Date.now()
    go.textContent = 'Stop'
    ranOn = [...list]
    rows = ranOn.map(() => null)
    const draft = structuredClone(ctx.strategy())
    status.textContent = `0 of ${ranOn.length}…`
    renderRows()
    await runBasket(
      ranOn,
      (symbol) => ctx.run(draft, symbol, cancelled),
      (row, index) => {
        if (cancelled()) return
        rows[index] = row
        const done = rows.filter(Boolean).length
        const secs = Math.round((Date.now() - started) / 1000)
        status.textContent = done < ranOn.length ? `${done} of ${ranOn.length}… (${secs} s)` : `${ranOn.length} instruments in ${secs} s`
        renderRows()
      },
      cancelled,
      CONCURRENCY
    )
    if (mine === token) {
      running = false
      go.textContent = 'Run basket'
    }
  }

  function renderRows(): void {
    results.innerHTML = ''
    if (ranOn.length === 0) return
    const done = rows.filter((r): r is BasketRow => r !== null)
    const holdout = done.some((r) => r.holdout)
    const pool = poolBasket(done)
    const line = el('p', 'wd-lab-note wd-lab-basket-pool')
    line.textContent =
      done.length === 0
        ? 'Running…'
        : `R above zero on ${pool.positive} of ${pool.withTrades} instruments with trades. Pooled: ${pool.trades} trades, ${pool.winRate === null ? '–' : `${Math.round(pool.winRate * 100)}%`} won, ${signed(pool.totalR, 1)} R, mean R ${describeMean(pool.r, 3)}${pool.holdout ? `; holdout mean R ${describeMean(pool.holdout, 3)}` : ''}.`
    results.appendChild(line)
    results.appendChild(
      figuresTable(
        ranOn.map((symbol, i) => {
          const r = rows[i]
          const open = button('kc-button wd-lab-mini', 'Open', () => ctx.open(symbol))
          open.title = `Run the lab on ${symbol}`
          const extra: Array<string | HTMLElement> = holdout ? [signed(r?.holdout?.avgR, 2), signed(r?.holdout?.r.t, 1), open] : [open]
          return {
            label: symbol.startsWith('oanda:') ? symbol.slice(6) : symbol,
            figures: r ? (holdout ? r.fit : r.all) : null,
            error: r?.error ?? (running ? null : 'not run'),
            extra
          }
        }),
        { first: 'instrument', extraHeaders: holdout ? ['holdout avg R', 'holdout t', ''] : [''] }
      )
    )
    if (holdout) {
      const note = el('p', 'wd-lab-note')
      note.textContent = 'With a holdout, each row’s figures are the part before it; the last two columns are the part held back.'
      results.appendChild(note)
    }
  }

  const controls = el('div', 'wd-lab-sweep-controls')
  controls.append(preset, add, offered, go, status)
  const intro = el('p', 'wd-lab-note')
  intro.textContent = `Run the draft on every instrument of the basket over its window, ${CONCURRENCY} at a time. A run of 30 days reads ~10 s cold per instrument.`
  element.append(intro, chips, note, controls, results)
  renderList()

  return {
    element,
    refresh() {
      renderList()
    }
  }
}
