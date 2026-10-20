import { button, el } from '../alerts/dom'
import { figuresTable } from './figtable'
import type { Strategy } from './model'
import type { LabRun } from './runner'
import { defaultRange, formatNumber, type ParamInfo, runSweep, type SweepRow, type SweepTarget, sweepTargets, sweepValues } from './sweep'

// GLUE (DOM). The Sweep panel: pick one number of the draft (sweep.ts lists every one), a range
// and how many values, and run the draft once per value; a row of figures per value. "Use" puts a
// value in the draft. With a holdout, the last columns are the holdout's -- choose on the rest,
// check there.

const signed = (v: number | null | undefined, digits: number): string => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}`)

export interface SweepContext {
  /** The draft, as it is now. */
  strategy(): Strategy
  paramInfo: ParamInfo
  /** One run of a copy of the draft; throws `RunCancelled` once `isCancelled` says so. */
  run(strategy: Strategy, isCancelled: () => boolean): Promise<LabRun>
  /** Put `value` in the draft at `target` (an edit like any other). */
  use(target: SweepTarget, value: number): void
}

export interface SweepPanel {
  readonly element: HTMLElement
  /** The draft changed: list its numbers again, keeping the choice. */
  refresh(): void
}

export function createSweepPanel(ctx: SweepContext): SweepPanel {
  const element = el('div', 'wd-lab-panel wd-lab-sweep')
  let targets: SweepTarget[] = []
  let chosen: string | null = null
  let rows: SweepRow[] = []
  let sweptTarget: SweepTarget | null = null
  /** The draft the rows were run on, to say when it has moved on. */
  let sweptDraft = ''
  let token = 0
  let running = false

  const pick = document.createElement('select')
  pick.className = 'kc-input wd-lab-sweep-target'
  pick.setAttribute('aria-label', 'Number to sweep')
  const num = (label: string, step: string): HTMLInputElement => {
    const i = document.createElement('input')
    i.type = 'number'
    i.step = step
    i.className = 'kc-input wd-lab-number'
    i.style.width = '5rem'
    i.setAttribute('aria-label', label)
    return i
  }
  const from = num('From', 'any')
  const to = num('To', 'any')
  const count = num('Values', '1')
  count.min = '2'
  count.max = '50'
  const go = button('kc-button kc-button-primary', 'Run sweep', () => (running ? stop() : void start()))
  const status = el('span', 'wd-lab-muted wd-lab-sweep-status')
  const results = el('div', 'wd-lab-sweep-results')

  const target = (): SweepTarget | null => targets.find((t) => t.id === chosen) ?? null

  function fillRange(): void {
    const t = target()
    if (!t) return
    const r = defaultRange(t)
    from.value = formatNumber(r.from)
    to.value = formatNumber(r.to)
    count.value = String(r.count)
    from.step = to.step = t.integer ? '1' : 'any'
  }

  pick.addEventListener('change', () => {
    chosen = pick.value
    fillRange()
  })

  function listTargets(): void {
    targets = sweepTargets(ctx.strategy(), ctx.paramInfo)
    if (!targets.some((t) => t.id === chosen)) {
      chosen = targets[0]?.id ?? null
      fillRange()
    }
    pick.innerHTML = ''
    const groups = new Map<string, HTMLOptGroupElement>()
    for (const t of targets) {
      let group = groups.get(t.section)
      if (!group) {
        group = document.createElement('optgroup')
        group.label = t.section
        groups.set(t.section, group)
        pick.appendChild(group)
      }
      const option = document.createElement('option')
      option.value = t.id
      option.textContent = `${t.label.replace(`${t.section} · `, '')} (now ${formatNumber(t.value)})`
      group.appendChild(option)
    }
    if (chosen) pick.value = chosen
  }

  function stop(): void {
    token++
    running = false
    go.textContent = 'Run sweep'
    status.textContent = rows.length > 0 ? `Stopped after ${rows.length} value${rows.length === 1 ? '' : 's'}` : ''
  }

  async function start(): Promise<void> {
    const t = target()
    if (!t) return
    const values = sweepValues(Number(from.value), Number(to.value), Number(count.value), t.integer, t.min)
    if (values.length === 0 || values.some((v) => !Number.isFinite(v))) {
      status.textContent = 'Give a range: from, to and how many values'
      return
    }
    const mine = ++token
    running = true
    go.textContent = 'Stop'
    rows = []
    sweptTarget = t
    const draft = ctx.strategy()
    sweptDraft = JSON.stringify(draft)
    renderRows()
    const cancelled = (): boolean => mine !== token
    status.textContent = `Running 1 of ${values.length}…`
    await runSweep(
      draft,
      t,
      values,
      (s) => ctx.run(s, cancelled),
      (row, i) => {
        if (cancelled()) return
        rows.push(row)
        status.textContent = i + 1 < values.length ? `Running ${i + 2} of ${values.length}…` : `${values.length} values`
        renderRows()
      },
      cancelled
    )
    if (mine === token) {
      running = false
      go.textContent = 'Run sweep'
    }
  }

  function renderRows(): void {
    results.innerHTML = ''
    const t = sweptTarget
    if (!t) return
    const draftNow = JSON.stringify(ctx.strategy())
    const holdout = rows.some((r) => r.holdout)
    const head = el('p', 'wd-lab-note')
    head.textContent = `${t.label} -- each value a run of the draft as it was when the sweep started${draftNow !== sweptDraft ? ' (the draft has changed since)' : ''}.${holdout ? ' The last two columns are the holdout: choose on the rest, check there.' : ''}`
    results.appendChild(head)
    const now = targets.find((x) => x.id === t.id)?.value ?? t.value
    results.appendChild(
      figuresTable(
        rows.map((r) => {
          const use = button('kc-button wd-lab-mini', 'Use', () => ctx.use(t, r.value))
          use.title = `Put ${formatNumber(r.value)} in the draft`
          use.disabled = r.value === now
          const extra: Array<string | HTMLElement> = holdout ? [signed(r.holdout?.avgR, 2), signed(r.holdout?.r.t, 1), use] : [use]
          return {
            label: `${formatNumber(r.value)}${r.value === now ? ' (now)' : ''}`,
            // With a holdout, the main figures are the fitting part's.
            figures: holdout ? r.fit : r.all,
            error: r.error,
            className: r.value === now ? 'is-selected' : '',
            extra
          }
        }),
        { first: 'value', extraHeaders: holdout ? ['holdout avg R', 'holdout t', ''] : [''] }
      )
    )
  }

  const controls = el('div', 'wd-lab-sweep-controls')
  const label = (text: string, input: HTMLElement): HTMLElement => {
    const l = el('label', 'wd-lab-param')
    l.append(document.createTextNode(text), input)
    return l
  }
  controls.append(label('Sweep', pick), label('from', from), label('to', to), label('in', count), document.createTextNode('values'), go, status)
  const intro = el('p', 'wd-lab-note')
  intro.textContent =
    'Run the draft once for each value of one of its numbers -- a signal’s parameter, a number written in a condition, a stop or target, the time limit, a cost. The data read for the first value serves the rest unless the number changes what is read.'
  element.append(intro, controls, results)
  listTargets()

  return {
    element,
    refresh() {
      listTargets()
      if (sweptTarget) renderRows()
    }
  }
}
