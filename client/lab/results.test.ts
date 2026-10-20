import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// THE RESULTS VIEW, in a real DOM (happy-dom), over a whole run of the fake data source: what a
// user does with it -- sort a table, step the chart through its rows, and keep the last run in
// view while a half-typed edit has a problem.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { createResultsView } = await import('./results')
const { runStrategy } = await import('./runner')
const { rank85Strategy, defaultStep } = await import('./model')
const { FakeData, NOW, D } = await import('./testdata')

import type { Problem } from './model'
import type { Pick } from './results'
import type { LabRun } from './runner'

let run: LabRun

beforeAll(async () => {
  const s = rank85Strategy(NOW)
  s.sources[0].timeframes = ['3m', '5m', '15m', '1h', '4h']
  s.graph = { ...s.graph, roots: ['4h', '1h'], step: defaultStep(8) }
  run = await runStrategy(s, new FakeData(), { from: NOW - 10 * D, to: NOW, catalogue: null, now: NOW })
})

function mount() {
  // The view remembers its tab per device; every test starts on the Summary.
  window.localStorage.clear()
  const picks: Pick[] = []
  const problems: Problem[] = []
  const view = createResultsView({ onPick: (p) => picks.push(p), onProblem: (p) => problems.push(p) })
  document.body.appendChild(view.element)
  const tab = (label: string): void => {
    const b = [...view.element.querySelectorAll<HTMLButtonElement>('.wd-lab-tab')].find((x) => x.textContent?.startsWith(label))
    b?.click()
  }
  const rows = (): HTMLElement[] => [...view.element.querySelectorAll<HTMLElement>('tbody tr[data-id]')]
  const header = (label: string): HTMLElement => [...view.element.querySelectorAll<HTMLElement>('th')].find((th) => th.textContent?.replace(/ [▴▾]$/, '') === label) as HTMLElement
  return { view, picks, problems, tab, rows, header }
}

describe('the results view', () => {
  test('a header click sorts the trades, again reverses them, a third time puts them back', () => {
    const { view, tab, rows, header } = mount()
    view.showRun(run)
    tab('Trades')
    const trades = run.sim?.trades ?? []
    expect(trades.length).toBeGreaterThan(2)
    const inTime = rows().map((r) => r.dataset.id)
    expect(inTime).toEqual(trades.map((t) => t.entry.id))

    const rOf = (id: string | undefined): number => trades.find((t) => t.entry.id === id)?.r ?? Number.NaN
    header('R').click()
    const ascending = rows().map((r) => rOf(r.dataset.id))
    expect(ascending).toEqual([...ascending].sort((a, b) => a - b))
    expect(header('R').getAttribute('aria-sort')).toBe('ascending')

    header('R').click()
    const descending = rows().map((r) => rOf(r.dataset.id))
    expect(descending).toEqual([...descending].sort((a, b) => b - a))

    header('R').click()
    expect(rows().map((r) => r.dataset.id)).toEqual(inTime)
    expect(header('R').getAttribute('aria-sort')).toBe('none')
  })

  test('the stepper walks the rows in the order shown, and stops at the ends', () => {
    const { view, picks, tab, rows, header } = mount()
    view.showRun(run)
    tab('Trades')
    header('R').click()
    const order = rows().map((r) => r.dataset.id)

    expect(view.step(1)).toBe(true)
    expect(picks.at(-1)?.entryId).toBe(order[0])
    expect(view.step(1)).toBe(true)
    expect(picks.at(-1)?.entryId).toBe(order[1])
    expect(view.element.querySelector('tr.is-selected')?.getAttribute('data-id')).toBe(order[1])
    expect(view.element.querySelector('.wd-lab-step-label')?.textContent).toBe(`trade 2 / ${order.length}`)
    // A trade's pick is its opening instant.
    const trade = run.sim?.trades.find((t) => t.entry.id === order[1])
    expect(picks.at(-1)?.at).toBe(trade?.openedAt as number)

    expect(view.step(-1)).toBe(true)
    expect(view.step(-1)).toBe(false)
    expect(picks.at(-1)?.entryId).toBe(order[0])
  })

  test('on the Summary the stepper walks the entries in time, not the filtered ones', () => {
    const { view, picks } = mount()
    view.showRun(run)
    const times = run.entries.map((e) => e.at).sort((a, b) => a - b)
    for (let i = 0; i < Math.min(3, times.length); i++) {
      expect(view.step(1)).toBe(true)
      expect(picks.at(-1)?.at).toBe(times[i])
    }
  })

  test('a problem keeps the last run in view, marked out of date, and links to its slot', () => {
    const { view, problems, tab, rows } = mount()
    view.showRun(run)
    tab('Entries')
    const before = rows().length
    expect(before).toBe(run.entries.length + run.filtered.length)

    const problem = { where: 'Entries · test 2', message: "no field 'node.depht' here (at 25)" }
    view.showProblems([problem], '1 problem to fix before it can run')
    const banner = view.element.querySelector('.wd-lab-banner') as HTMLElement
    expect(banner.hidden).toBe(false)
    expect(banner.textContent).toContain("the results below are the last run's")
    expect(view.element.querySelector('.wd-lab-results-body')?.classList.contains('is-stale')).toBe(true)
    expect(rows().length).toBe(before)

    banner.querySelector<HTMLButtonElement>('.wd-lab-problem-link')?.click()
    expect(problems).toEqual([problem])

    // The next run clears it.
    view.showRun(run)
    expect(banner.hidden).toBe(true)
    expect(view.element.querySelector('.wd-lab-results-body')?.classList.contains('is-stale')).toBe(false)
  })

  test('an edit with no run coming marks the results out of date; a message replaces them', () => {
    const { view, rows, tab } = mount()
    view.showStale('Edited since this run')
    // Nothing to mark before a first run.
    expect((view.element.querySelector('.wd-lab-banner') as HTMLElement).hidden).toBe(true)

    view.showRun(run)
    tab('Entries')
    view.showStale('Edited since this run')
    expect(view.element.querySelector('.wd-lab-banner')?.textContent).toBe('Edited since this run')
    expect(rows().length).toBeGreaterThan(0)

    view.showMessage('Press Run to evaluate the strategy over its window.')
    expect(rows().length).toBe(0)
    expect(view.step(1)).toBe(false)
  })

  test('sizes and money are grouped by thousands', () => {
    const { view, tab } = mount()
    view.showRun(run)
    tab('Trades')
    const units = [...view.element.querySelectorAll('tbody tr')].map((tr) => tr.children[3]?.textContent ?? '')
    const big = run.sim?.trades.filter((t) => t.units >= 1000) ?? []
    expect(big.length).toBeGreaterThan(0)
    for (const text of units) expect(text).toMatch(/^\d{1,3}(,\d{3})*$/)
  })
})
