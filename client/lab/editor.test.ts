import { afterAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// THE EDITOR'S WAY AROUND, in a real DOM (happy-dom): the rules as cards, long then short; the
// section bar counts each section's problems, a problem link opens its section (and a rule's
// More) and focuses its slot; a click on a name in "Fields" writes it into the slot's field at
// the cursor; a rule's chips, root, copy, off and remove.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { createStrategyEditor, sectionOf } = await import('./editor')
const { rank85Strategy, strategyProblems } = await import('./model')

function mount(prepare: (s: ReturnType<typeof rank85Strategy>) => void = () => {}) {
  const strategy = rank85Strategy(0)
  prepare(strategy)
  let changes = 0
  const editor = createStrategyEditor(strategy, { catalogue: null, intervals: () => ['1m', '3m', '5m', '15m', '1h', '4h', '1D'], counts: () => null }, () => changes++)
  document.body.innerHTML = ''
  document.body.appendChild(editor.element)
  const section = (key: string) => editor.element.querySelector<HTMLDetailsElement>(`details[data-section="${key}"]`) as HTMLDetailsElement
  const navLink = (key: string) => editor.element.querySelector<HTMLElement>(`.wd-lab-nav [data-section="${key}"]`) as HTMLElement
  const field = (value: string) => [...editor.element.querySelectorAll<HTMLInputElement>('.wd-lab-expr-input')].find((i) => i.value === value) as HTMLInputElement
  const type = (input: HTMLInputElement, value: string): void => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const card = (name: string) => editor.element.querySelector<HTMLElement>(`.wd-lab-rule-card[data-where="${name}"]`) as HTMLElement
  const chip = (scope: HTMLElement, where: string, code: string) =>
    [...scope.querySelectorAll<HTMLButtonElement>(`[data-where="${where}"] .wd-lab-chip`)].find((b) => b.firstChild?.textContent === code) as HTMLButtonElement
  return { strategy, editor, section, navLink, field, type, card, chip, changes: () => changes }
}

/** A long rule with one entry condition of its own, to type in. */
const withCondition = (s: ReturnType<typeof rank85Strategy>): void => {
  s.rules[0].entryIf = [{ id: 'c1', expr: 'node.depth >= 1', enabled: true }]
}

describe('the editor', () => {
  test('a problem belongs to the section its place names', () => {
    expect(sectionOf({ where: 'Long · 1D · steps', message: '' })).toBe('long')
    expect(sectionOf({ where: 'Short · 4h #2 · entry condition 1', message: '' })).toBe('short')
    expect(sectionOf({ where: 'Rules', message: '' })).toBe('long')
    expect(sectionOf({ where: 'Signals · AREV21 outlier rank 85', message: '' })).toBe('pool')
    expect(sectionOf({ where: 'Exits · stop', message: '' })).toBe('exits')
    expect(sectionOf({ where: 'Sizing', message: '' })).toBe('sizing')
    expect(sectionOf({ where: 'Simulation', message: '' })).toBe('sizing')
    // The header's, not the editor's.
    expect(sectionOf({ where: 'Instrument', message: '' })).toBeNull()
    expect(sectionOf({ where: 'Window', message: '' })).toBeNull()
  })

  test('the rules come first, long then short, a card each', () => {
    const { editor, card } = mount()
    const keys = [...editor.element.querySelectorAll<HTMLDetailsElement>('details[data-section]')].map((d) => d.dataset.section)
    expect(keys).toEqual(['long', 'short', 'exits', 'pool', 'sizing', 'outcomes', 'notes'])
    expect(card('Long · 1D').querySelector('.wd-lab-rule-name')?.textContent).toBe('Long · 1D')
    expect(card('Short · 1D')).toBeTruthy()
    // A long rule follows the bottoms: against the signal, and it says so.
    expect(card('Long · 1D').textContent).toContain('against the signal')
    // The overlay's slots beyond the sentence are behind More, closed.
    expect(card('Long · 1D').querySelector<HTMLDetailsElement>('details.wd-lab-more')?.open).toBe(false)
  })

  test('the section bar and the headings count the problems', () => {
    const { strategy, editor, field, type, navLink, section } = mount(withCondition)
    type(field('node.depth >= 1'), 'node.depht > 2')
    const problems = strategyProblems(strategy)
    expect(problems.map((p) => p.where)).toEqual(['Long · 1D · entry condition 1'])
    editor.markProblems(problems)
    expect(navLink('long').classList.contains('has-problems')).toBe(true)
    expect(navLink('long').dataset.count).toBe('1')
    expect(navLink('short').classList.contains('has-problems')).toBe(false)
    expect(section('long').querySelector('.wd-lab-section-problems')?.textContent).toBe('1 problem')

    editor.markProblems([])
    expect(navLink('long').classList.contains('has-problems')).toBe(false)
  })

  test('revealing a problem opens its section and the More around it, and focuses the slot', () => {
    const { strategy, editor, field, type, section, card } = mount(withCondition)
    type(field('node.depth >= 1'), 'node.depht > 2')
    section('long').open = false
    const [problem] = strategyProblems(strategy)
    expect(editor.reveal(problem)).toBe(true)
    expect(section('long').open).toBe(true)
    expect(card('Long · 1D').querySelector<HTMLDetailsElement>('details.wd-lab-more')?.open).toBe(true)
    const focused = document.activeElement as HTMLInputElement
    expect(focused.value).toBe('node.depht > 2')
    expect(focused.closest<HTMLElement>('[data-where]')?.dataset.where).toBe('Long · 1D · entry condition 1')
    // A problem with no slot of its own goes to its rule's card.
    strategy.rules[0].entryOn = []
    const [noEntries] = strategyProblems(strategy).filter((p) => p.where.endsWith('entries'))
    expect(noEntries.where).toBe('Long · 1D · entries')
    expect(editor.reveal(noEntries)).toBe(true)
    // The header's problems are not the editor's to show.
    expect(editor.reveal({ where: 'Instrument', message: '' })).toBe(false)
  })

  test("a name in Fields is written into the slot's last field, at the cursor", () => {
    const { strategy, editor, field } = mount(withCondition)
    const input = field('node.depth >= 1')
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    input.setRangeText(' and', input.value.length, input.value.length, 'end')
    const fields = [...editor.element.querySelectorAll<HTMLDetailsElement>('details[data-section="long"] .wd-lab-fields')].at(-1) as HTMLDetailsElement
    const name = (text: string) => [...fields.querySelectorAll<HTMLButtonElement>('.wd-lab-field-name')].find((b) => b.textContent === text) as HTMLButtonElement
    name('node.tf').click()
    expect(input.value).toBe('node.depth >= 1 and node.tf')
    // ... and the model follows, as if it had been typed.
    expect(strategy.rules[0].entryIf[0].expr).toBe('node.depth >= 1 and node.tf')
    // A function is written up to its bracket.
    input.setRangeText(' > ', input.value.length, input.value.length, 'end')
    name("atr(period, 'tf')").click()
    expect(input.value).toBe('node.depth >= 1 and node.tf > atr(')
  })

  test('a step chip off takes it out of the entries too; the entries fall back to the shortest step', () => {
    const { strategy, card, chip } = mount()
    const long = strategy.rules[0]
    expect(long.entryOn).toEqual(['3m', '5m'])
    chip(card('Long · 1D'), 'Long · 1D · steps', '5m').click()
    expect(long.steps).not.toContain('5m')
    expect(long.entryOn).toEqual(['3m'])
    chip(card('Long · 1D'), 'Long · 1D · steps', '3m').click()
    expect(long.entryOn).toEqual(['15m'])
    // and the entry chips offer only the steps
    chip(card('Long · 1D'), 'Long · 1D · entries', '1h').click()
    expect(long.entryOn).toEqual(['15m', '1h'])
  })

  test('a new root keeps the steps under it; + Long rule takes the next root; Copy, off and remove', () => {
    const { strategy, editor, card, section } = mount()
    const long = strategy.rules[0]
    const rootPick = card('Long · 1D').querySelector<HTMLSelectElement>('select[aria-label="Root timeframe"]') as HTMLSelectElement
    rootPick.value = '1h'
    rootPick.dispatchEvent(new Event('change'))
    expect(long.root).toBe('1h')
    // The steps under 1h this instrument offers (no 20m or 30m here).
    expect(long.steps).toEqual(['3m', '5m', '15m'])
    expect(long.entryOn).toEqual(['3m', '5m'])

    const add = [...section('long').querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '+ Long rule') as HTMLButtonElement
    add.click()
    const added = strategy.rules.at(-1)
    // 1D is free again: the overlay's roots in turn, among those the instrument offers.
    expect(added && [added.direction, added.root, added.follows]).toEqual(['long', '1D', 'bottom'])
    expect(added?.steps).toEqual(['3m', '5m', '15m', '1h', '4h'])

    const copy = card('Long · 1h').querySelector<HTMLButtonElement>('button[title="Copy this rule"]') as HTMLButtonElement
    copy.click()
    expect(strategy.rules.filter((r) => r.direction === 'long' && r.root === '1h')).toHaveLength(2)
    expect(card('Long · 1h #2')).toBeTruthy()

    const off = card('Long · 1h #2').querySelector<HTMLInputElement>('input[type="checkbox"]') as HTMLInputElement
    off.checked = false
    off.dispatchEvent(new Event('change'))
    expect(strategy.rules.find((r) => r.id !== long.id && r.root === '1h')?.enabled).toBe(false)
    expect(card('Long · 1h #2').classList.contains('is-off')).toBe(true)

    const remove = card('Long · 1h #2').querySelector<HTMLButtonElement>('button[title="Remove this rule"]') as HTMLButtonElement
    remove.click()
    expect(strategy.rules.filter((r) => r.root === '1h')).toHaveLength(1)
    void editor
  })

  test('Collapse all and Expand all', () => {
    const { editor, section } = mount()
    const fold = () => editor.element.querySelector<HTMLButtonElement>('.wd-lab-nav-fold') as HTMLButtonElement
    const keys = ['long', 'short', 'exits', 'pool', 'sizing', 'outcomes', 'notes']
    // Some sections start closed.
    expect(fold().textContent).toBe('Expand all')
    fold().click()
    for (const key of keys) expect(section(key).open).toBe(true)
    expect(fold().textContent).toBe('Collapse all')
    fold().click()
    for (const key of keys) expect(section(key).open).toBe(false)
  })
})
