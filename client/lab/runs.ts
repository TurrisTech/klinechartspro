import { button, el } from '../alerts/dom'
import { describeChanges, strategyChanges } from './changes'
import { figuresTable } from './figtable'
import { type Figures, figuresOf } from './figures'
import type { Strategy } from './model'
import type { LabRun } from './runner'

// THE RUNS OF THIS SESSION, and the BASELINE: every run the page makes is kept here -- the copy
// of the strategy it ran, where and when, and its figures (figures.ts) -- with what changed since
// the run before it, so editing a rule reads as a list of experiments and their results. Any of
// them can be PINNED as the baseline, which the Summary then compares every run with; and any can
// be RESTORED into the draft, to go back to a version that did better.
//
// Kept per strategy, in the page only: a reload starts a new session. The figures are kept, never
// a run's bars.

export interface RunRecord {
  id: number
  /** When it ran. */
  ranAt: number
  strategy: Strategy
  symbol: string
  from: number
  to: number
  split: number | null
  figures: Figures
  fit: Figures | null
  holdout: Figures | null
  /** Since the run before it, in the editor's words; null for a strategy's first run. */
  changes: string[] | null
}

/** Runs kept per strategy; older ones go first, but never the baseline. */
export const HISTORY_LIMIT = 40

export class RunHistory {
  private readonly records = new Map<string, RunRecord[]>()
  private readonly baselines = new Map<string, number>()
  private counter = 0

  /** Keep a run. A run that changed nothing and found the same takes the place of the last one
   * (an auto-run after Revert, a re-run) rather than filling the list with copies. */
  add(run: LabRun, ranAt = Date.now()): RunRecord {
    const id = run.strategy.id
    const list = this.records.get(id) ?? []
    const last = list.at(-1)
    const figures = figuresOf(run)
    const split = run.split !== null
    const record: RunRecord = {
      id: ++this.counter,
      ranAt,
      strategy: structuredClone(run.strategy),
      symbol: run.symbol,
      from: run.from,
      to: run.to,
      split: run.split,
      figures,
      fit: split ? figuresOf(run, 'fit') : null,
      holdout: split ? figuresOf(run, 'holdout') : null,
      changes: last ? strategyChanges(last.strategy, run.strategy) : null
    }
    if (last && record.changes?.length === 0 && JSON.stringify(last.figures) === JSON.stringify(figures) && this.baselines.get(id) !== last.id) {
      record.changes = last.changes
      list[list.length - 1] = record
    } else list.push(record)
    const baseline = this.baselines.get(id)
    while (list.length > HISTORY_LIMIT) {
      const drop = list.findIndex((r) => r.id !== baseline)
      list.splice(drop, 1)
    }
    this.records.set(id, list)
    return record
  }

  list(strategyId: string): readonly RunRecord[] {
    return this.records.get(strategyId) ?? []
  }

  baseline(strategyId: string): RunRecord | null {
    const id = this.baselines.get(strategyId)
    return this.list(strategyId).find((r) => r.id === id) ?? null
  }

  /** Pin a run as the strategy's baseline; null unpins. */
  pin(strategyId: string, recordId: number | null): void {
    if (recordId === null) this.baselines.delete(strategyId)
    else this.baselines.set(strategyId, recordId)
  }
}

export interface RunsPanel {
  readonly element: HTMLElement
  /** Show `records` (oldest first), marking the baseline and the run on the chart. */
  render(records: readonly RunRecord[], baseline: RunRecord | null, current: number | null): void
}

export function createRunsPanel(handlers: { onPin(record: RunRecord | null): void; onRestore(record: RunRecord): void }): RunsPanel {
  const element = el('div', 'wd-lab-panel wd-lab-runs')
  const time = (ms: number): string => new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(ms)
  const day = (ms: number): string => new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(ms)

  return {
    element,
    render(records, baseline, current) {
      element.innerHTML = ''
      const intro = el('p', 'wd-lab-note')
      intro.textContent =
        records.length === 0
          ? 'Every run of this strategy in this session is listed here with what changed since the one before. Pin one as the baseline and the Summary compares every run with it; restore one to go back to that version.'
          : `${records.length} run${records.length === 1 ? '' : 's'} of this strategy in this session, newest first. ${baseline ? `Baseline: run ${records.indexOf(baseline) + 1}, which the Summary compares every run with.` : 'Pin one as the baseline and the Summary compares every run with it.'}`
      element.appendChild(intro)
      if (records.length === 0) return
      const rows = [...records].reverse().map((r) => {
        const n = records.indexOf(r) + 1
        const isBaseline = baseline?.id === r.id
        const label = el('div', 'wd-lab-run-label')
        const headline = el('div', '')
        headline.textContent = `${n} · ${time(r.ranAt)} · ${r.symbol.split(':')[1] ?? r.symbol} ${day(r.from)}–${day(r.to)}`
        const what = el('div', 'wd-lab-muted wd-lab-run-changes')
        what.textContent = r.changes === null ? 'first run' : describeChanges(r.changes)
        what.title = r.changes?.join('\n') ?? ''
        label.append(headline, what)
        const pin = button(`kc-button wd-lab-mini${isBaseline ? ' is-on' : ''}`, isBaseline ? '★ Baseline' : '☆ Pin', () => handlers.onPin(isBaseline ? null : r))
        pin.title = isBaseline ? 'Unpin: the Summary stops comparing with it' : 'Compare every run with this one'
        pin.setAttribute('aria-pressed', String(isBaseline))
        const restore = button('kc-button wd-lab-mini', 'Restore', () => handlers.onRestore(r))
        restore.title = 'Put this version of the strategy in the draft (Revert or Save as usual afterwards)'
        restore.disabled = r.id === current
        return {
          label,
          figures: r.figures,
          compareTo: baseline && !isBaseline ? baseline.figures : null,
          className: `${isBaseline ? 'is-baseline' : ''}${r.id === current ? ' is-selected' : ''}`,
          extra: [pin, restore]
        }
      })
      element.appendChild(figuresTable(rows, { first: 'run', extraHeaders: ['', ''], className: 'is-runs' }))
    }
  }
}
