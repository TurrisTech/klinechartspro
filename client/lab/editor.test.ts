import { afterAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// THE EDITOR'S WAY AROUND, in a real DOM (happy-dom): the section bar counts each section's
// problems, a problem link opens its section and focuses its slot, and a click on a name in
// "Fields" writes it into the slot's field at the cursor.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { createStrategyEditor, sectionOf } = await import('./editor')
const { rank85Strategy, strategyProblems } = await import('./model')

function mount() {
  const strategy = rank85Strategy(0)
  let changes = 0
  const editor = createStrategyEditor(strategy, { catalogue: null, intervals: () => ['1m', '3m', '5m', '15m', '1h', '4h', '1D'], counts: () => null }, () => changes++)
  document.body.appendChild(editor.element)
  const section = (key: string) => editor.element.querySelector<HTMLDetailsElement>(`details[data-section="${key}"]`) as HTMLDetailsElement
  const navLink = (key: string) => editor.element.querySelector<HTMLElement>(`.wd-lab-nav [data-section="${key}"]`) as HTMLElement
  const field = (value: string) => [...editor.element.querySelectorAll<HTMLInputElement>('.wd-lab-expr-input')].find((i) => i.value === value) as HTMLInputElement
  const type = (input: HTMLInputElement, value: string): void => {
    input.value = value
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  return { strategy, editor, section, navLink, field, type, changes: () => changes }
}

describe('the editor', () => {
  test('a problem belongs to the section its place names', () => {
    expect(sectionOf({ where: 'Graph · step test 2', message: '' })).toBe('graph')
    expect(sectionOf({ where: 'Signals · AREV21 outlier rank 85', message: '' })).toBe('pool')
    expect(sectionOf({ where: 'Entries · test 1', message: '' })).toBe('entry')
    expect(sectionOf({ where: 'Exits · stop', message: '' })).toBe('exits')
    expect(sectionOf({ where: 'Sizing', message: '' })).toBe('sizing')
    expect(sectionOf({ where: 'Simulation', message: '' })).toBe('sizing')
    // The header's, not the editor's.
    expect(sectionOf({ where: 'Instrument', message: '' })).toBeNull()
    expect(sectionOf({ where: 'Window', message: '' })).toBeNull()
  })

  test('the section bar and the headings count the problems', () => {
    const { strategy, editor, field, type, navLink, section } = mount()
    type(field("node.tf <= tf('5m')"), 'node.depht > 2')
    const problems = strategyProblems(strategy)
    expect(problems.map((p) => p.where)).toEqual(['Entries · test 2'])
    editor.markProblems(problems)
    expect(navLink('entry').classList.contains('has-problems')).toBe(true)
    expect(navLink('entry').dataset.count).toBe('1')
    expect(navLink('graph').classList.contains('has-problems')).toBe(false)
    expect(section('entry').querySelector('.wd-lab-section-problems')?.textContent).toBe('1 problem')

    editor.markProblems([])
    expect(navLink('entry').classList.contains('has-problems')).toBe(false)
  })

  test('revealing a problem opens a closed section and focuses the slot it names', () => {
    const { strategy, editor, field, type, section } = mount()
    type(field("node.tf <= tf('5m')"), 'node.depht > 2')
    section('entry').open = false
    const [problem] = strategyProblems(strategy)
    expect(editor.reveal(problem)).toBe(true)
    expect(section('entry').open).toBe(true)
    const focused = document.activeElement as HTMLInputElement
    expect(focused.value).toBe('node.depht > 2')
    expect(focused.closest<HTMLElement>('[data-where]')?.dataset.where).toBe('Entries · test 2')
    // The header's problems are not the editor's to show.
    expect(editor.reveal({ where: 'Instrument', message: '' })).toBe(false)
  })

  test("a name in Fields is written into the slot's last field, at the cursor", () => {
    const { strategy, editor, field } = mount()
    const input = field("node.tf <= tf('5m')")
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
    input.setRangeText(' and', input.value.length, input.value.length, 'end')
    const fields = [...editor.element.querySelectorAll<HTMLDetailsElement>('details[data-section="entry"] .wd-lab-fields')][0]
    const name = (text: string) => [...fields.querySelectorAll<HTMLButtonElement>('.wd-lab-field-name')].find((b) => b.textContent === text) as HTMLButtonElement
    name('node.depth').click()
    expect(input.value).toBe("node.tf <= tf('5m') and node.depth")
    // ... and the model follows, as if it had been typed.
    expect(strategy.entry.when[1].expr).toBe("node.tf <= tf('5m') and node.depth")
    // A function is written up to its bracket.
    input.setRangeText(' > ', input.value.length, input.value.length, 'end')
    name("atr(period, 'tf')").click()
    expect(input.value).toBe("node.tf <= tf('5m') and node.depth > atr(")
  })

  test('Collapse all and Expand all', () => {
    const { editor, section } = mount()
    const fold = () => editor.element.querySelector<HTMLButtonElement>('.wd-lab-nav-fold') as HTMLButtonElement
    // Some sections start closed.
    expect(fold().textContent).toBe('Expand all')
    fold().click()
    for (const key of ['pool', 'graph', 'entry', 'exits', 'sizing', 'outcomes', 'notes']) expect(section(key).open).toBe(true)
    expect(fold().textContent).toBe('Collapse all')
    fold().click()
    for (const key of ['pool', 'graph', 'entry', 'exits', 'sizing', 'outcomes', 'notes']) expect(section(key).open).toBe(false)
  })
})
