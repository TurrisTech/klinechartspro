import { defaultLeaf, fromEditable, type GroupNode, group, toEditable } from '../alerts/editable'
import { button, el, iconButton, input, select } from '../alerts/dom'
import { compile, RuleError } from '../alerts/rules'
import { createRuleTree } from '../alerts/ruletree'
import type { Rule } from '../alerts/types'
import { defaultSide, labIndicators, type LabCatalogue, type LabSignalFamily } from './catalogue'
import { exprProblem } from './expr'
import {
  byLength,
  defaultEntryOn,
  defaultRule,
  type Direction,
  followsFor,
  type Level,
  newRuleId,
  type ParentRule,
  type PriceAnchor,
  type Problem,
  type PublishedSource,
  RANK_TIMEFRAMES,
  ROOT_TIMEFRAMES,
  type RootJoin,
  type RuleSource,
  ruleLabel,
  SCOPES,
  scopeFunctions,
  SELF_INTERVAL,
  type Side,
  type SignalSource,
  type SlotCondition,
  type SlotScope,
  type Strategy,
  type StrategyRule,
  stepsBelow,
  withInterval
} from './model'

// GLUE (DOM). The Strategy Lab's editor: a strategy (model.ts) as its RULES first -- the long ones,
// then the short ones -- then the exits, and below them, closed until wanted, the signals the
// rules follow, the account and the outcomes measured.
//
// A rule is a card that reads as a sentence (user, 2026-10-20: "simpler easier to understand
// rules"): from this root, following these signals, stepping down through these timeframes,
// buying (or selling) at these. What the overlay's graph has beyond that -- the longest step,
// "beyond every signal before it", where a signal hangs from, a same-side root, an early end, and
// conditions written in the expression language -- is behind the card's "More".
//
// It edits the strategy it is handed IN PLACE and calls `onChange` after every edit; the page
// decides what an edit means (a draft that differs from the saved strategy, and a re-run). A
// structural edit re-renders the form; a typed expression or number moves the model as it is
// typed and is checked on the spot, so a keystroke never takes the focus away.
//
// An expression slot shows the problem with it as it is typed, and -- behind "Fields" -- every
// name and function that slot can read (model.ts `SCOPES`); a click on one writes it into the
// slot's field last typed in, at the cursor.
//
// Above the sections, a bar that stays in view names them -- a click opens one and brings it on
// screen -- each with the count of problems in it, so a problem in a closed section is not hidden.
// `reveal` takes the page to one problem's slot (the results' problem list links there).

export interface EditorContext {
  catalogue: LabCatalogue | null
  /** The timeframes offered for the strategy's instrument, shortest first. */
  intervals(): string[]
  /** Signals the last run read, by `source|interval`, to show beside each timeframe. */
  counts(): Map<string, number> | null
}

export interface StrategyEditor {
  readonly element: HTMLElement
  render(): void
  /** Edit another strategy (or a reverted one). */
  setStrategy(strategy: Strategy): void
  /** The draft's problems (model.ts `strategyProblems`), counted on the section bar and in each
   * section's heading. */
  markProblems(problems: Problem[]): void
  /** Open the section a problem is in and bring its slot on screen, focused. False when the
   * problem is not the editor's (the instrument and the window are the page header's). */
  reveal(problem: Problem): boolean
}

/** The editor's sections, in order: key, title, and the word a problem's `where` starts with. */
const SECTIONS: Array<{ key: string; title: string; short: string; where: string[] }> = [
  { key: 'long', title: 'Long rules', short: 'Long', where: ['Long', 'Rules'] },
  { key: 'short', title: 'Short rules', short: 'Short', where: ['Short'] },
  { key: 'exits', title: 'Exits', short: 'Exits', where: ['Exits'] },
  { key: 'pool', title: 'Signals', short: 'Signals', where: ['Signals'] },
  { key: 'sizing', title: 'Account, costs & simulation', short: 'Account', where: ['Sizing', 'Costs', 'Simulation'] },
  { key: 'outcomes', title: 'Outcomes', short: 'Outcomes', where: ['Outcomes'] },
  { key: 'notes', title: 'Notes', short: 'Notes', where: [] }
]

/** The section a problem belongs to, by the first word of its `where`. */
export function sectionOf(problem: Problem): string | null {
  const head = problem.where.split(' · ')[0]
  return SECTIONS.find((s) => s.where.includes(head))?.key ?? null
}

export function createStrategyEditor(initial: Strategy, context: EditorContext, onChange: () => void): StrategyEditor {
  let strategy = initial
  const element = el('div', 'wd-lab-editor')
  const nav = el('nav', 'wd-lab-nav')
  nav.setAttribute('aria-label', 'Sections')
  const form = el('div', 'wd-lab-form')
  element.append(nav, form)
  /** Sections and sub-panels the user opened or closed, by key. */
  const open = new Map<string, boolean>()
  /** Editable rule trees, by slot, so an unfinished condition survives a re-render. */
  const trees = new Map<string, GroupNode>()
  /** Each scope's expression field last focused: where a click in its "Fields" list writes. */
  const lastField = new Map<SlotScope, HTMLInputElement>()
  let problems: Problem[] = []

  const changed = (): void => {
    onChange()
  }
  const restructure = (): void => {
    render()
    onChange()
  }

  function render(): void {
    form.innerHTML = ''
    form.append(rulesSection('long'), rulesSection('short'), exitSection(), poolSection(), sizingSection(), outcomeSection(), notesSection())
    renderNav()
    showProblemCounts()
  }

  const sectionEl = (key: string): HTMLDetailsElement | null => form.querySelector<HTMLDetailsElement>(`details[data-section="${key}"]`)

  /** Open a section (it stays open across re-renders) and bring it on screen. */
  function openSection(key: string): HTMLDetailsElement | null {
    open.set(key, true)
    const details = sectionEl(key)
    if (details && !details.open) details.open = true
    return details
  }

  function renderNav(): void {
    nav.innerHTML = ''
    for (const s of SECTIONS) {
      const b = button('wd-lab-nav-link', s.short, () => {
        openSection(s.key)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      })
      b.dataset.section = s.key
      b.title = `Open ${s.title}`
      nav.appendChild(b)
    }
    const allOpen = SECTIONS.every((s) => sectionEl(s.key)?.open ?? false)
    const fold = button('wd-lab-nav-link wd-lab-nav-fold', allOpen ? 'Collapse all' : 'Expand all', () => {
      for (const s of SECTIONS) open.set(s.key, !allOpen)
      render()
    })
    nav.appendChild(fold)
  }

  /** Problem counts on the bar and in each section's heading. */
  function showProblemCounts(): void {
    const counts = new Map<string, number>()
    for (const p of problems) {
      const key = sectionOf(p)
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    for (const link of nav.querySelectorAll<HTMLElement>('[data-section]')) {
      const n = counts.get(link.dataset.section ?? '') ?? 0
      link.classList.toggle('has-problems', n > 0)
      link.dataset.count = n > 0 ? String(n) : ''
      link.setAttribute('aria-label', n > 0 ? `${link.textContent}, ${n} problem${n === 1 ? '' : 's'}` : (link.textContent ?? ''))
    }
    for (const s of SECTIONS) {
      const badge = sectionEl(s.key)?.querySelector<HTMLElement>(':scope > summary .wd-lab-section-problems')
      if (!badge) continue
      const n = counts.get(s.key) ?? 0
      badge.textContent = n > 0 ? `${n} problem${n === 1 ? '' : 's'}` : ''
      badge.hidden = n === 0
    }
  }

  function reveal(problem: Problem): boolean {
    const key = sectionOf(problem)
    if (!key) return false
    const details = openSection(key)
    if (!details) return false
    // The slot it names, when the editor marked one -- else the nearest that holds it ("Long · 1D"
    // for "Long · 1D · ends") -- else the section. A closed "More" around it opens.
    const marked = [...details.querySelectorAll<HTMLElement>('[data-where]')]
    const target =
      marked.find((n) => n.dataset.where === problem.where) ??
      marked.filter((n) => problem.where.startsWith(`${n.dataset.where} · `)).sort((a, b) => (b.dataset.where?.length ?? 0) - (a.dataset.where?.length ?? 0))[0] ??
      details
    for (let n: HTMLElement | null = target; n && n !== details; n = n.parentElement) if (n instanceof HTMLDetailsElement) n.open = true
    target.scrollIntoView({ block: 'center' })
    const field = target.querySelector<HTMLElement>('.is-bad') ?? target.querySelector<HTMLElement>('input:not([type="checkbox"]), select, textarea')
    field?.focus({ preventScroll: true })
    target.classList.remove('is-flash')
    // A reflow between the two restarts the animation when the same slot is revealed twice.
    void target.offsetWidth
    target.classList.add('is-flash')
    return true
  }

  // -- layout helpers -------------------------------------------------------------------------

  function section(key: string, title: string, summary: string, body: (box: HTMLElement) => void, openByDefault = true): HTMLElement {
    const details = document.createElement('details')
    details.className = 'wd-lab-section'
    details.dataset.section = key
    details.open = open.get(key) ?? openByDefault
    details.addEventListener('toggle', () => {
      open.set(key, details.open)
      renderNav()
      showProblemCounts()
    })
    const head = document.createElement('summary')
    const t = el('span', 'wd-lab-section-title')
    t.textContent = title
    const s = el('span', 'wd-lab-section-summary')
    s.textContent = summary
    const p = el('span', 'wd-lab-section-problems')
    p.hidden = true
    head.append(t, s, p)
    details.appendChild(head)
    const box = el('div', 'wd-lab-section-body')
    body(box)
    details.appendChild(box)
    return details
  }

  /** A disclosure inside a card or a section, kept open or closed across re-renders by `key`. */
  function more(key: string, label: string, body: (box: HTMLElement) => void): HTMLElement {
    const details = document.createElement('details')
    details.className = 'wd-lab-more'
    details.open = open.get(key) ?? false
    details.addEventListener('toggle', () => open.set(key, details.open))
    const head = document.createElement('summary')
    head.textContent = label
    details.appendChild(head)
    const box = el('div', 'wd-lab-more-body')
    body(box)
    details.appendChild(box)
    return details
  }

  function row(label: string, ...controls: Array<HTMLElement | string>): HTMLElement {
    const r = el('div', 'wd-lab-row')
    if (label) {
      const caption = el('span', 'wd-lab-caption')
      caption.textContent = label
      r.appendChild(caption)
    }
    for (const c of controls) {
      if (typeof c === 'string') {
        const span = el('span', 'wd-lab-muted')
        span.textContent = c
        r.appendChild(span)
      } else r.appendChild(c)
    }
    return r
  }

  /** `node`, marked as the slot a problem's `where` names (model.ts `strategyProblems`). */
  function slot<T extends HTMLElement>(where: string, node: T): T {
    node.dataset.where = where
    return node
  }

  function words(text: string): HTMLElement {
    const span = el('span', 'wd-lab-muted')
    span.textContent = text
    return span
  }

  function note(text: string): HTMLElement {
    const p = el('p', 'wd-lab-note')
    p.textContent = text
    return p
  }

  function checkbox(label: string, checked: boolean, set: (on: boolean) => void, title = ''): HTMLElement {
    const l = el('label', 'wd-lab-check')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = checked
    box.addEventListener('change', () => {
      set(box.checked)
      restructure()
    })
    l.append(box, document.createTextNode(label))
    if (title) l.title = title
    return l
  }

  /** A number, committed as it is typed when it parses; `empty` lets it be cleared (null). */
  function num(value: number | null, set: (v: number | null) => void, opts: { min?: number; step?: string; empty?: boolean; width?: string } = {}): HTMLInputElement {
    const i = document.createElement('input')
    i.type = 'number'
    i.className = 'kc-input wd-lab-number'
    i.step = opts.step ?? 'any'
    if (opts.min !== undefined) i.min = String(opts.min)
    if (opts.width) i.style.width = opts.width
    i.value = value === null ? '' : String(value)
    i.addEventListener('input', () => {
      if (i.value.trim() === '') {
        if (opts.empty) {
          set(null)
          changed()
        }
        return
      }
      const n = Number(i.value)
      if (!Number.isFinite(n)) return
      set(n)
      changed()
    })
    return i
  }

  function chips(all: readonly string[], on: readonly string[], toggle: (code: string, on: boolean) => void, counts?: (code: string) => number | null): HTMLElement {
    const box = el('span', 'wd-lab-chips')
    for (const code of all) {
      const b = button(`wd-lab-chip${on.includes(code) ? ' is-on' : ''}`, code, () => {
        toggle(code, !on.includes(code))
        restructure()
      })
      b.setAttribute('aria-pressed', String(on.includes(code)))
      // A chip switched on carries its count's place before the first run too: a run finishing
      // must not widen the chips, wrap the row and move every control under it mid-click.
      if (counts && on.includes(code)) {
        const n = counts(code)
        const badge = el('span', 'wd-lab-chip-count')
        badge.textContent = n === null ? '·' : String(n)
        badge.title = n === null ? 'Signals in the window: known after a run' : `${n} signal${n === 1 ? '' : 's'} in the last run's window`
        b.appendChild(badge)
      }
      box.appendChild(b)
    }
    return box
  }

  // -- expressions ------------------------------------------------------------------------------

  /** A text field holding an expression for `scope`, checked as it is typed. */
  function exprField(text: string, scope: SlotScope, set: (text: string) => void, placeholder = ''): HTMLElement {
    const box = el('div', 'wd-lab-expr')
    const field = document.createElement('input')
    field.type = 'text'
    field.className = 'kc-input wd-lab-expr-input'
    field.spellcheck = false
    field.autocomplete = 'off'
    field.value = text
    field.placeholder = placeholder
    const problem = el('div', 'wd-lab-problem')
    const check = (): void => {
      const message = field.value.trim() ? exprProblem(field.value, scope) : placeholder ? '' : 'write a condition'
      problem.textContent = message
      problem.hidden = !message
      field.classList.toggle('is-bad', !!message)
    }
    field.addEventListener('input', () => {
      set(field.value)
      check()
      changed()
    })
    field.addEventListener('focus', () => lastField.set(scope, field))
    check()
    box.append(field, problem)
    return box
  }

  /** Write `text` into the scope's field last typed in, at its cursor. */
  function insertInto(scope: SlotScope, text: string): void {
    const field = lastField.get(scope)
    if (!field?.isConnected) return
    const start = field.selectionStart ?? field.value.length
    const end = field.selectionEnd ?? start
    // A space between it and a word or a closing bracket before it, so `a` + `b` is not `ab`.
    const before = field.value.slice(0, start)
    const pad = before && /[\w).'"]$/.test(before) ? ' ' : ''
    field.setRangeText(`${pad}${text}`, start, end, 'end')
    field.focus()
    field.dispatchEvent(new Event('input', { bubbles: true }))
  }

  /** The names and functions a slot can read. */
  function fieldHelp(key: string, scope: SlotScope): HTMLElement {
    const details = document.createElement('details')
    details.className = 'wd-lab-fields'
    details.open = open.get(key) ?? false
    details.addEventListener('toggle', () => open.set(key, details.open))
    const head = document.createElement('summary')
    head.textContent = 'Fields'
    details.appendChild(head)
    details.appendChild(note(`${scope.note} Click a name to write it into the field you last typed in.`))
    const table = el('dl', 'wd-lab-field-list')
    const entry = (label: string, insert: string, doc: string): void => {
      const dt = el('dt', '')
      const b = button('wd-lab-field-name', label, () => insertInto(scope, insert))
      b.title = `Write ${insert} at the cursor`
      dt.appendChild(b)
      const dd = el('dd', '')
      dd.textContent = doc
      table.append(dt, dd)
    }
    for (const f of scope.fields) entry(f.name, f.name, f.doc)
    // A function writes as far as its opening bracket: the arguments are the user's.
    for (const f of scopeFunctions(scope)) entry(f.signature, `${f.name}(`, f.doc)
    details.appendChild(table)
    return details
  }

  let conditionCounter = 0
  /** A slot of several conditions, all of which must hold. */
  function conditionList(key: string, where: string, conditions: SlotCondition[], scope: SlotScope, presets: (() => SlotCondition[]) | null, presetName: string): HTMLElement {
    const box = el('div', 'wd-lab-conditions')
    conditions.forEach((condition, i) => {
      const line = el('div', `wd-lab-condition${condition.enabled ? '' : ' is-off'}`)
      // What model.ts `strategyProblems` calls it, so a problem can be taken to it.
      line.dataset.where = `${where} ${i + 1}`
      const on = document.createElement('input')
      on.type = 'checkbox'
      on.checked = condition.enabled
      on.title = 'Read this condition'
      on.addEventListener('change', () => {
        condition.enabled = on.checked
        restructure()
      })
      const body = el('div', 'wd-lab-condition-body')
      if (condition.label) {
        const caption = el('div', 'wd-lab-condition-label')
        caption.textContent = condition.label
        body.appendChild(caption)
      }
      const preset = condition.expr
      body.appendChild(
        exprField(condition.expr, scope, (text) => {
          condition.expr = text
          // The preset's words no longer describe a condition that has been rewritten.
          if (condition.label && text !== preset) condition.label = undefined
        })
      )
      const remove = iconButton('×', 'Remove this condition', () => {
        conditions.splice(i, 1)
        restructure()
      })
      line.append(on, body, remove)
      box.appendChild(line)
    })
    if (conditions.length === 0) box.appendChild(note(presetName))
    const actions = el('div', 'wd-lab-actions')
    actions.append(
      button('kc-button wd-alert-link', '+ Condition', () => {
        conditionCounter++
        conditions.push({ id: `c${Date.now().toString(36)}${conditionCounter}`, expr: '', enabled: true })
        restructure()
      })
    )
    if (presets) {
      actions.appendChild(
        button('kc-button wd-alert-link', 'Reset', () => {
          conditions.splice(0, conditions.length, ...presets())
          restructure()
        })
      )
    }
    actions.appendChild(fieldHelp(`${key}:fields`, scope))
    box.appendChild(actions)
    return box
  }

  // -- rules ------------------------------------------------------------------------------------

  /** An optional alert-language rule: off, or the rule tree. `self` offers "the event's own
   * timeframe" (a rule source's rules). */
  function ruleSlot(key: string, rule: Rule | null, set: (rule: Rule | null) => void, opts: { label: string; self?: boolean; defaultInterval: () => string }): HTMLElement {
    const box = el('div', 'wd-lab-rule')
    box.appendChild(
      checkbox(opts.label, rule !== null, (on) => {
        if (!on) {
          trees.delete(key)
          set(null)
          return
        }
        const root = group('all', [{ kind: 'leaf', leaf: defaultLeaf(opts.self ? SELF_INTERVAL : opts.defaultInterval()) }])
        trees.set(key, root)
        set(fromEditable(root))
      })
    )
    if (rule === null) return box
    let root = trees.get(key)
    if (!root) {
      root = toEditable(rule)
      trees.set(key, root)
    }
    const problem = el('div', 'wd-lab-problem')
    const check = (): void => {
      let message = ''
      try {
        const r = fromEditable(root as GroupNode)
        compile(opts.self ? withInterval(r, context.intervals()[0] ?? '1h') : r)
      } catch (err) {
        message = err instanceof RuleError ? err.message : String(err)
      }
      problem.textContent = message
      problem.hidden = !message
    }
    const tree = createRuleTree({
      root,
      catalogue: context.catalogue?.server ?? null,
      intervals: () => context.intervals(),
      defaultInterval: opts.defaultInterval,
      selfInterval: opts.self ? { code: SELF_INTERVAL, label: 'its own' } : undefined,
      // A lab rule reads values; the graph entries it would offer are the lab's own job.
      // nor another strategy's entries, which its runner does not read.
      offer: { graphs: false, strategies: false },
      indicators: labIndicators(),
      onChange: () => {
        set(fromEditable(root as GroupNode))
        check()
        changed()
      }
    })
    tree.element.addEventListener('wd-alert-edited', () => {
      set(fromEditable(root as GroupNode))
      check()
      changed()
    })
    check()
    box.append(tree.element, problem)
    return box
  }

  // -- levels ---------------------------------------------------------------------------------

  function levelEditor(key: string, level: Level | null, role: 'stop' | 'target' | 'trail', set: (level: Level | null) => void): HTMLElement {
    const box = el('div', 'wd-lab-level')
    const kinds = [
      ...(role === 'trail' ? [] : [{ value: 'none', label: role === 'stop' ? 'no stop' : 'no target' }]),
      { value: 'pips', label: 'pips' },
      { value: 'atr', label: '× ATR' },
      ...(role === 'target' ? [{ value: 'r', label: '× the stop (R)' }] : []),
      { value: 'expr', label: 'a price expression' }
    ]
    const kind = select(kinds, level?.kind ?? 'none', (value) => {
      if (value === 'none') set(null)
      else if (value === 'pips') set({ kind: 'pips', value: 10 })
      else if (value === 'atr') set({ kind: 'atr', mult: role === 'stop' ? 1.5 : 1, period: 14, interval: null })
      else if (value === 'r') set({ kind: 'r', mult: 1 })
      else set({ kind: 'expr', expr: role === 'target' ? 'root.price' : 'entry.price - entry.dir * 2 * atr(14)' })
      restructure()
    })
    box.appendChild(kind)
    if (!level) return box
    if (level.kind === 'pips') box.append(num(level.value, (v) => (level.value = v ?? 0), { min: 0, width: '5rem' }))
    if (level.kind === 'r') box.append(num(level.mult, (v) => (level.mult = v ?? 0), { min: 0, width: '5rem' }))
    if (level.kind === 'atr') {
      const tf = select([{ value: '', label: "the entry's timeframe" }, ...context.intervals().map((c) => ({ value: c, label: c }))], level.interval ?? '', (value) => {
        level.interval = value || null
        changed()
      })
      box.append(
        num(level.mult, (v) => (level.mult = v ?? 0), { min: 0, width: '4.5rem' }),
        words('× ATR('),
        num(level.period, (v) => (level.period = Math.max(1, Math.round(v ?? 14))), { min: 1, step: '1', width: '4rem' }),
        words(') on'),
        tf
      )
    }
    if (level.kind === 'expr') box.append(exprField(level.expr, SCOPES.level, (text) => (level.expr = text)), fieldHelp(`${key}:fields`, SCOPES.level))
    return box
  }

  // -- sections ---------------------------------------------------------------------------------

  // -- rules ------------------------------------------------------------------------------------

  /** The timeframes a source can be read on for the strategy's instrument: the outlier overlay's
   * for an outlier signal, every one the server offers otherwise. */
  function offeredFor(source: SignalSource | undefined): string[] {
    const all = byLength(context.intervals())
    if (source?.kind === 'published' && source.plugin === 'arev21_outlier') {
      const ranked = all.filter((c) => RANK_TIMEFRAMES.includes(c))
      return ranked.length > 0 ? ranked : [...RANK_TIMEFRAMES]
    }
    return all.length > 0 ? all : [...RANK_TIMEFRAMES]
  }

  const sourceOf = (rule: StrategyRule): SignalSource | undefined => strategy.sources.find((s) => s.id === rule.source)

  /** What a side of a source's signals is called: "bottoms (short)" -- its labels on that side. */
  function sideWords(source: SignalSource | undefined, side: Side): string {
    const noun = side === 'top' ? 'tops' : 'bottoms'
    if (source?.kind !== 'published') return noun
    const labels = Object.entries(source.sides)
      .filter(([, s]) => s === side)
      .map(([label]) => label)
    return labels.length > 0 ? `${noun} (${labels.join(', ')})` : noun
  }

  function rulesSection(direction: Direction): HTMLElement {
    const mine = strategy.rules.filter((r) => r.direction === direction)
    const on = mine.filter((r) => r.enabled)
    const verb = direction === 'long' ? 'Buy' : 'Sell'
    const summary = on.length === 0 ? 'none' : on.map((r) => ruleLabel(strategy, r).replace(/^(Long|Short) · /, '')).join(' · ')
    return section(direction, direction === 'long' ? 'Long rules' : 'Short rules', summary, (box) => {
      const intro = note(
        direction === 'long'
          ? `${verb}. Each rule follows one root timeframe's signals down to an entry, on its own: the results show each rule alone and all of them together.`
          : `${verb}. The same, the other way; a short rule is independent of the long ones.`
      )
      // "Switch on at least one rule" is taken here.
      box.appendChild(direction === 'long' ? slot('Rules', intro) : intro)
      for (const rule of mine) box.appendChild(ruleCard(rule))
      const actions = el('div', 'wd-lab-actions')
      actions.appendChild(
        button('kc-button kc-button-outline', `+ ${direction === 'long' ? 'Long' : 'Short'} rule`, () => {
          const source = strategy.sources[0]
          const offered = offeredFor(source)
          const used = new Set(mine.map((r) => r.root))
          const root = ROOT_TIMEFRAMES.find((tf) => !used.has(tf) && offered.includes(tf)) ?? offered[offered.length - 1] ?? '1h'
          const graphless = source?.kind === 'rule'
          strategy.rules.push(defaultRule(direction, root, graphless ? [] : offered, source?.id ?? 'rank85', newRuleId(strategy, direction, root)))
          restructure()
        })
      )
      box.appendChild(actions)
    })
  }

  function ruleCard(rule: StrategyRule): HTMLElement {
    const name = ruleLabel(strategy, rule)
    const card = slot(name, el('div', `wd-lab-card wd-lab-rule-card is-${rule.direction}${rule.enabled ? '' : ' is-off'}`))
    const source = sourceOf(rule)
    const offered = offeredFor(source)

    // The head: on/off, its name, copy, remove.
    const head = el('div', 'wd-lab-card-head')
    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.checked = rule.enabled
    toggle.title = rule.enabled ? 'Switch this rule off' : 'Switch this rule on'
    toggle.setAttribute('aria-label', `${name}: on`)
    toggle.addEventListener('change', () => {
      rule.enabled = toggle.checked
      restructure()
    })
    const title = el('span', 'wd-lab-rule-name')
    title.textContent = name
    const copy = iconButton('⧉', 'Copy this rule', () => {
      const twin: StrategyRule = { ...structuredClone(rule), id: newRuleId(strategy, rule.direction, rule.root) }
      strategy.rules.splice(strategy.rules.indexOf(rule) + 1, 0, twin)
      restructure()
    })
    const remove = iconButton('×', 'Remove this rule', () => {
      strategy.rules.splice(strategy.rules.indexOf(rule), 1)
      restructure()
    })
    head.append(toggle, title, copy, remove)
    card.appendChild(head)
    if (!rule.enabled) return card

    // From: the root, the side it follows, and -- with more than one -- whose signals.
    const roots = byLength([...offered, rule.root]).reverse()
    const rootPick = select(
      roots.map((c) => ({ value: c, label: c })),
      rule.root,
      (value) => {
        rule.root = value
        // Keep the steps still under the new root; with none left, all of them.
        const under = stepsBelow(value, offered)
        const kept = rule.steps.filter((tf) => under.includes(tf))
        rule.steps = rule.steps.length === 0 ? [] : kept.length > 0 ? kept : under
        const entries = rule.entryOn.filter((tf) => (rule.steps.length > 0 ? rule.steps : [value]).includes(tf))
        rule.entryOn = entries.length > 0 ? entries : defaultEntryOn(value, rule.steps)
        restructure()
      }
    )
    rootPick.setAttribute('aria-label', 'Root timeframe')
    const followPick = select(
      (['bottom', 'top'] as const).map((side) => ({ value: side, label: sideWords(source, side) })),
      rule.follows,
      (value) => {
        rule.follows = value === 'top' ? 'top' : 'bottom'
        restructure()
      }
    )
    followPick.setAttribute('aria-label', 'Signals it follows')
    const against = el('span', 'wd-lab-muted')
    against.textContent = rule.follows === followsFor(rule.direction) ? 'against the signal' : 'with the signal'
    const from: Array<HTMLElement | string> = [rootPick, followPick]
    if (strategy.sources.length > 1 || !source) {
      const sourcePick = select(
        [...(source ? [] : [{ value: rule.source, label: `${rule.source} (missing)` }]), ...strategy.sources.map((s) => ({ value: s.id, label: s.title || s.id }))],
        rule.source,
        (value) => {
          rule.source = value
          restructure()
        }
      )
      sourcePick.setAttribute('aria-label', 'Signal')
      from.push('of', slot(`${name} · signal`, sourcePick))
    }
    from.push(against)
    card.appendChild(slot(`${name} · root`, row('From', ...from)))

    // Steps: the shorter timeframes a graph steps down through.
    const counts = context.counts()
    const countOf = (code: string): number | null => counts?.get(`${rule.source}|${code}`) ?? null
    const under = stepsBelow(rule.root, byLength([...offered, ...rule.steps]))
    if (under.length > 0) {
      card.appendChild(
        slot(
          `${name} · steps`,
          row(
            'Steps',
            chips(
              under,
              rule.steps,
              (code, on) => {
                rule.steps = on ? byLength([...rule.steps, code]) : rule.steps.filter((c) => c !== code)
                const entries = rule.entryOn.filter((tf) => (rule.steps.length > 0 ? rule.steps : [rule.root]).includes(tf))
                rule.entryOn = entries.length > 0 ? entries : defaultEntryOn(rule.root, rule.steps)
              },
              countOf
            )
          )
        )
      )
    }

    // Entries: which of the steps it trades at -- or, with none, its root's signals.
    const verb = rule.direction === 'long' ? 'Buys at' : 'Sells at'
    if (rule.steps.length > 0) {
      card.appendChild(
        slot(
          `${name} · entries`,
          row(
            verb,
            chips(rule.steps, rule.entryOn, (code, on) => {
              rule.entryOn = on ? byLength([...rule.entryOn, code]) : rule.entryOn.filter((c) => c !== code)
            })
          )
        )
      )
    } else {
      card.appendChild(slot(`${name} · entries`, row(verb, `every ${rule.follows === 'top' ? 'top' : 'bottom'} on ${rule.root} -- no graph`)))
    }

    card.appendChild(
      ruleSlot(`rule:${rule.id}:filter`, rule.filter, (r) => (rule.filter = r), { label: 'Only when this holds at the entry', defaultInterval: () => '1D' })
    )

    // Everything else the overlay's graph has, behind More.
    card.appendChild(
      more(`rule:${rule.id}:more`, 'More', (box) => {
        if (rule.steps.length > 0) {
          box.appendChild(
            slot(
              `${name} · steps`,
              row(
                'A step is at most',
                num(rule.maxStep, (v) => (rule.maxStep = v === null ? null : Math.max(1, v)), { min: 1, empty: true, width: '4.5rem' }),
                '× shorter than the one before (blank: any)'
              )
            )
          )
          box.appendChild(checkbox('Each signal goes beyond every one before it (off: beyond the one it hangs from)', rule.reach, (on) => (rule.reach = on)))
          box.appendChild(
            row(
              'A signal hangs from',
              select(
                [
                  { value: 'supersede', label: "its timeframe's last node if it goes further, else the latest longer one (overlay)" },
                  { value: 'recent', label: 'the most recent node it may step from' },
                  { value: 'nearest', label: 'the node nearest it in price' },
                  { value: 'root', label: 'the latest root' }
                ],
                rule.parent,
                (value) => {
                  rule.parent = value as ParentRule
                  changed()
                }
              )
            )
          )
          box.appendChild(
            row(
              `Another ${rule.follows} on ${rule.root}`,
              select(
                [
                  { value: 'join', label: 'joins the open graph (overlay)' },
                  { value: 'new', label: 'starts a new graph' },
                  { value: 'ignore', label: 'is ignored' }
                ],
                rule.rootJoin,
                (value) => {
                  rule.rootJoin = value as RootJoin
                  changed()
                }
              )
            )
          )
          const end = slot(`${name} · ends when`, el('div', 'wd-lab-subsection'))
          const endHead = el('div', 'wd-lab-subhead')
          endHead.textContent = `A graph ends when ${rule.root} turns the other way, and also`
          end.appendChild(endHead)
          end.appendChild(
            slot(
              `${name} · ends`,
              row('after', num(rule.end.rootBars, (v) => (rule.end.rootBars = v === null ? null : Math.max(1, Math.round(v))), { min: 1, step: '1', empty: true, width: '5rem' }), `${rule.root} bars (blank: never)`)
            )
          )
          const watch = select([{ value: '', label: 'its shortest timeframe' }, ...byLength([rule.root, ...rule.steps]).map((c) => ({ value: c, label: c }))], rule.end.watch ?? '', (value) => {
            rule.end.watch = value || null
            changed()
          })
          end.appendChild(row('at the first close of', watch, 'where'))
          end.appendChild(exprField(rule.end.when, SCOPES.end, (text) => (rule.end.when = text), 'never (e.g. (bar.close - root.price) * dir < 0)'))
          end.appendChild(fieldHelp(`rule:${rule.id}:end:fields`, SCOPES.end))
          box.appendChild(end)
          box.appendChild(condSub(`rule:${rule.id}:step`, `${name} · step condition`, 'A signal may also step only when', rule.stepIf, SCOPES.step))
        }
        box.appendChild(condSub(`rule:${rule.id}:entry`, `${name} · entry condition`, rule.steps.length > 0 ? 'A node on those timeframes is an entry only when' : 'A signal is an entry only when', rule.entryIf, SCOPES.entry))
      })
    )
    return card
  }

  /** A titled list of a rule's own conditions, empty by default. */
  function condSub(key: string, where: string, title: string, conditions: SlotCondition[], scope: SlotScope): HTMLElement {
    const box = el('div', 'wd-lab-subsection')
    const head = el('div', 'wd-lab-subhead')
    head.textContent = title
    box.append(head, conditionList(key, where, conditions, scope, null, 'Nothing more: none written.'))
    return box
  }

  // -- signals ----------------------------------------------------------------------------------

  function poolSection(): HTMLElement {
    const summary = strategy.sources.map((s) => s.title || s.id).join(' · ') || 'none'
    return section(
      'pool',
      'Signals',
      summary,
      (box) => {
        box.appendChild(note('What the rules follow. A rule reads its signal on its own root and steps.'))
        strategy.sources.forEach((source, i) => {
          box.appendChild(sourceCard(source, i))
        })
        const actions = el('div', 'wd-lab-actions')
        actions.append(
          button('kc-button kc-button-outline', '+ Published signal', () => {
            strategy.sources.push(publishedFromFamily(context.catalogue?.signals[0] ?? null, freshId('sig')))
            restructure()
          }),
          button('kc-button kc-button-outline', '+ Rule event', () => {
            strategy.sources.push({
              kind: 'rule',
              id: freshId('rule'),
              title: 'Rule event',
              top: { left: { kind: 'indicator', interval: SELF_INTERVAL, name: 'RSI', params: [14], output: 'rsi1' }, op: 'crosses_below', right: { value: 70 } },
              bottom: { left: { kind: 'indicator', interval: SELF_INTERVAL, name: 'RSI', params: [14], output: 'rsi1' }, op: 'crosses_above', right: { value: 30 } },
              price: 'close'
            })
            restructure()
          })
        )
        box.appendChild(actions)
      },
      false
    )
  }

  function freshId(prefix: string): string {
    const used = new Set(strategy.sources.map((s) => s.id))
    for (let k = 1; ; k++) if (!used.has(`${prefix}${k}`)) return `${prefix}${k}`
  }

  function sourceCard(source: SignalSource, index: number): HTMLElement {
    const card = el('div', 'wd-lab-card')
    card.dataset.where = `Signals · ${source.title || source.id}`
    const head = el('div', 'wd-lab-card-head')
    const title = input('text', source.title, (value) => {
      source.title = value
      changed()
    })
    title.classList.add('wd-lab-title-input')
    title.setAttribute('aria-label', 'Source title')
    const users = strategy.rules.filter((r) => r.source === source.id)
    const remove = iconButton('×', users.length > 0 ? `Remove this signal (${users.length} rule${users.length === 1 ? ' follows' : 's follow'} it)` : 'Remove this signal', () => {
      strategy.sources.splice(index, 1)
      restructure()
    })
    const kind = el('span', 'wd-lab-badge')
    kind.textContent = source.kind === 'published' ? 'signal' : 'rule'
    head.append(kind, title, remove)
    card.appendChild(head)
    if (source.kind === 'published') publishedFields(card, source)
    else ruleFields(card, source)
    card.appendChild(
      more(`source:${source.id}:more`, 'More', (box) => {
        const id = input('text', source.id, (value) => {
          // Renaming a source renames it where the rules name it.
          const before = source.id
          source.id = value.trim()
          for (const r of strategy.rules) if (r.source === before) r.source = source.id
          changed()
        })
        id.classList.add('wd-lab-id-input')
        id.title = 'Its id: what node.source reads'
        id.setAttribute('aria-label', 'Source id')
        box.appendChild(row('Id', id))
        if (source.kind === 'published') box.appendChild(labelsRow(source))
        box.appendChild(
          row(
            'Priced at',
            select(
              [
                { value: 'body', label: "its candle's body (top for a top, bottom for a bottom)" },
                { value: 'wick', label: "its candle's high (top) or low (bottom)" },
                { value: 'close', label: "its candle's close" }
              ],
              source.price,
              (value) => {
                source.price = value as PriceAnchor
                changed()
              }
            )
          )
        )
      })
    )
    return card
  }

  function publishedFields(card: HTMLElement, source: PublishedSource): void {
    const families = context.catalogue?.signals ?? []
    const familyKey = (f: { plugin: string; variant: string }): string => `${f.plugin}/${f.variant}`
    const current = families.find((f) => familyKey(f) === familyKey(source))
    const choices = families.map((f) => ({ value: familyKey(f), label: f.title }))
    if (!current) choices.unshift({ value: familyKey(source), label: `${source.plugin} ${source.variant}` })
    card.appendChild(
      row(
        'Signal',
        select(choices, familyKey(source), (value) => {
          const family = families.find((f) => familyKey(f) === value)
          if (!family) return
          const fresh = publishedFromFamily(family, source.id)
          Object.assign(source, { ...fresh, price: source.price })
          restructure()
        })
      )
    )
    const params = current?.params ?? Object.keys(source.params).map((name) => ({ name, type: 'float' as const, default: source.params[name], min: null, max: null, description: '' }))
    if (params.length > 0) {
      const box = el('div', 'wd-lab-params')
      for (const p of params) {
        const field = num(source.params[p.name] ?? p.default, (v) => {
          source.params[p.name] = v ?? p.default
        })
        field.title = p.description
        const label = el('label', 'wd-lab-param')
        label.append(document.createTextNode(p.name), field)
        box.appendChild(label)
      }
      card.appendChild(row('Read with', box))
    }
  }

  /** Which side of a graph each of a published signal's labels is. */
  function labelsRow(source: PublishedSource): HTMLElement {
    const current = context.catalogue?.signals.find((f) => f.plugin === source.plugin && f.variant === source.variant)
    const labels = current?.labels ?? Object.keys(source.sides).map((id) => ({ id, label: id, side: null }))
    const sides = el('div', 'wd-lab-sides')
    for (const label of labels) {
      const pick = select(
        [
          { value: 'top', label: 'a top' },
          { value: 'bottom', label: 'a bottom' },
          { value: '', label: 'not read' }
        ],
        source.sides[label.id] ?? '',
        (value) => {
          if (value === 'top' || value === 'bottom') source.sides[label.id] = value
          else delete source.sides[label.id]
          restructure()
        }
      )
      const l = el('label', 'wd-lab-param')
      l.append(document.createTextNode(`${label.label} is`), pick)
      sides.appendChild(l)
    }
    return row('Labels', sides)
  }

  function ruleFields(card: HTMLElement, source: RuleSource): void {
    const defaultInterval = (): string => strategy.rules.find((r) => r.source === source.id)?.root ?? '1h'
    card.appendChild(ruleSlot(`${source.id}:top`, source.top, (rule) => (source.top = rule), { label: 'A top where this starts to hold', self: true, defaultInterval }))
    card.appendChild(ruleSlot(`${source.id}:bottom`, source.bottom, (rule) => (source.bottom = rule), { label: 'A bottom where this starts to hold', self: true, defaultInterval }))
    card.appendChild(note("'its own' is the event's timeframe: one rule, read on every timeframe a rule follows it on."))
  }

  function exitSection(): HTMLElement {
    const x = strategy.exits
    const bits = [x.stop ? 'stop' : '', x.target ? 'target' : '', x.breakevenAtR !== null ? 'breakeven' : '', x.trail ? 'trail' : '', x.ruleLong || x.ruleShort ? 'rule' : '', x.maxBars ? `${x.maxBars.count} bars` : ''].filter(Boolean)
    return section('exits', 'Exits', bits.join(' · ') || 'none', (box) => {
      box.appendChild(slot('Exits · stop', row('Stop', levelEditor('stop', x.stop, 'stop', (l) => (x.stop = l)))))
      box.appendChild(slot('Exits · target', row('Target', levelEditor('target', x.target, 'target', (l) => (x.target = l)))))
      box.appendChild(checkbox('Time limit', x.maxBars !== null, (on) => (x.maxBars = on ? { count: 48, interval: null } : null)))
      if (x.maxBars) {
        const limit = x.maxBars
        const tf = select([{ value: '', label: "the entry's timeframe" }, ...context.intervals().map((c) => ({ value: c, label: c }))], limit.interval ?? '', (value) => {
          limit.interval = value || null
          changed()
        })
        box.appendChild(slot('Exits · time', row('close after', num(limit.count, (v) => (limit.count = Math.max(1, Math.round(v ?? 1))), { min: 1, step: '1', width: '5rem' }), 'bars of', tf)))
      }
      box.appendChild(
        more('exits:more', 'More: breakeven, trailing, rule exits', (more) => {
          more.appendChild(
            slot(
              'Exits · breakeven',
              row(
                '',
                checkbox('Breakeven once', x.breakevenAtR !== null, (on) => (x.breakevenAtR = on ? 1 : null)),
                ...(x.breakevenAtR !== null ? [num(x.breakevenAtR, (v) => (x.breakevenAtR = v ?? 1), { min: 0, width: '4.5rem' }), 'R in'] : [])
              )
            )
          )
          more.appendChild(checkbox('Trailing stop', x.trail !== null, (on) => (x.trail = on ? { distance: { kind: 'atr', mult: 1.5, period: 14, interval: null }, activateR: 1 } : null)))
          if (x.trail) {
            const trail = x.trail
            more.appendChild(slot('Exits · trailing stop', row('behind the best close by', levelEditor('trail', trail.distance, 'trail', (l) => (trail.distance = l ?? trail.distance)))))
            more.appendChild(row('once', num(trail.activateR, (v) => (trail.activateR = v ?? 0), { min: 0, width: '4.5rem' }), 'R in (0: at once)'))
          }
          more.appendChild(ruleSlot('exit-long', x.ruleLong, (rule) => (x.ruleLong = rule), { label: 'Close a long where this holds', defaultInterval: () => context.intervals()[0] ?? '1h' }))
          more.appendChild(ruleSlot('exit-short', x.ruleShort, (rule) => (x.ruleShort = rule), { label: 'Close a short where this holds', defaultInterval: () => context.intervals()[0] ?? '1h' }))
          more.appendChild(checkbox('An entry the other way closes what is open first', x.onOpposite, (on) => (x.onOpposite = on)))
        })
      )
    })
  }

  function sizingSection(): HTMLElement {
    const s = strategy.sizing
    const path = strategy.pathInterval
    const c = strategy.costs
    const costWords = [c.commission ? `${c.commission}/M` : '', c.slippagePips ? `${c.slippagePips} pip slip` : '', c.financing ? 'financing' : ''].filter(Boolean)
    return section(
      'sizing',
      'Account, costs & simulation',
      `${s.mode === 'risk' ? `${s.riskPercent}% risk` : `${s.units} units`}${s.maxLeverage !== null ? ` · ≤${s.maxLeverage}:1` : ''} · ${s.maxOpen} open${costWords.length ? ` · ${costWords.join(', ')}` : ''} · path ${path ?? 'auto'}`,
      (box) => {
        box.appendChild(row('Opening balance', num(s.balance, (v) => (s.balance = v ?? 100_000), { min: 0, width: '8rem' }), 'in the quote currency'))
        const mode = select(
          [
            { value: 'risk', label: 'risk a percent of the balance at the stop' },
            { value: 'units', label: 'a fixed number of units' }
          ],
          s.mode,
          (value) => {
            s.mode = value === 'units' ? 'units' : 'risk'
            restructure()
          }
        )
        box.appendChild(
          row(
            'Size',
            mode,
            s.mode === 'risk' ? num(s.riskPercent, (v) => (s.riskPercent = v ?? 1), { min: 0, width: '4.5rem' }) : num(s.units, (v) => (s.units = Math.max(1, Math.round(v ?? 1))), { min: 1, step: '1', width: '7rem' }),
            s.mode === 'risk' ? '%' : 'units'
          )
        )
        box.appendChild(row('At most', num(s.maxOpen, (v) => (s.maxOpen = Math.max(1, Math.round(v ?? 1))), { min: 1, step: '1', width: '4rem' }), 'trades open at once'))
        box.appendChild(
          row(
            '',
            checkbox('Leverage cap', s.maxLeverage !== null, (on) => (s.maxLeverage = on ? 50 : null), 'Cut a position to at most this multiple of the balance in notional'),
            ...(s.maxLeverage !== null ? [num(s.maxLeverage, (v) => (s.maxLeverage = v ?? 50), { min: 1, width: '4.5rem' }), ':1 of the balance (OANDA’s retail limit on the majors is 50)'] : [])
          )
        )

        const costs = el('div', 'wd-lab-subsection')
        const costHead = el('div', 'wd-lab-subhead')
        costHead.textContent = 'Costs beyond the spread -- the fill engine already pays the bid/ask'
        costs.appendChild(costHead)
        costs.appendChild(row('Commission', num(c.commission, (v) => (c.commission = v ?? 0), { min: 0, width: '5.5rem' }), 'per million units, each side, in the quote currency'))
        costs.appendChild(row('Slippage', num(c.slippagePips, (v) => (c.slippagePips = v ?? 0), { min: 0, width: '5.5rem' }), 'pips worse on the entry, a stop and a market exit (a target fills at its price)'))
        costs.appendChild(
          checkbox('Overnight financing', c.financing !== null, (on) => (c.financing = on ? { long: 0, short: 0 } : null), 'Charged at each daily close a trade is held through')
        )
        if (c.financing) {
          const f = c.financing
          costs.appendChild(
            row(
              'a long pays',
              num(f.long, (v) => (f.long = v ?? 0), { width: '5rem' }),
              '% a year, a short pays',
              num(f.short, (v) => (f.short = v ?? 0), { width: '5rem' }),
              '% (negative: earns)'
            )
          )
          costs.appendChild(
            note(
              'Of the notional, at each daily close held through, for the days until the next close (a Friday close carries the weekend; OANDA books the FX weekend on a Wednesday -- the same over a week). Take the rates from OANDA’s financing page for the instrument: they are today’s, applied to all of history.'
            )
          )
        }
        box.appendChild(slot('Costs', costs))
        const tf = select([{ value: '', label: "auto: the longest stored timeframe tiling every entry's" }, ...['5s', '1m', '1h', '1D'].map((c) => ({ value: c, label: c }))], path ?? '', (value) => {
          strategy.pathInterval = value || null
          changed()
        })
        box.appendChild(row('Path bars', tf))
        box.appendChild(note('Trades and outcomes are walked on the path bars, with bid/ask where the store has it. An entry no path bar closes at is refused, never moved.'))
        const lb = strategy.lookback
        box.appendChild(
          slot(
            'Simulation',
            row(
              'History',
              'a root reads back',
              num(lb.rootBars, (v) => (lb.rootBars = Math.max(1, Math.round(v ?? 300))), { min: 1, step: '1', width: '5rem' }),
              'of its bars for the graph in force at the start; a step at most',
              num(lb.maxBars, (v) => (lb.maxBars = Math.max(1, Math.round(v ?? 10000))), { min: 1, step: '1', width: '6rem' })
            )
          )
        )
      },
      false
    )
  }

  function outcomeSection(): HTMLElement {
    const o = strategy.outcomes
    const list = (values: number[], set: (v: number[]) => void): HTMLInputElement => {
      const i = input('text', values.join(', '), (text) => {
        const parsed = text
          .split(/[,\s]+/)
          .filter(Boolean)
          .map(Number)
        if (parsed.length > 0 && parsed.every((n) => Number.isFinite(n) && n > 0)) {
          set(parsed)
          changed()
        }
      })
      i.classList.add('wd-lab-list-input')
      return i
    }
    return section(
      'outcomes',
      'Outcomes',
      `after ${o.horizons.join('/')} bars · touches ${o.touches.join('/')} ATR`,
      (box) => {
        box.appendChild(row('Forward returns after', list(o.horizons, (v) => (o.horizons = v.map((n) => Math.round(n)))), "bars of the entry's timeframe"))
        box.appendChild(row('Which comes first, ±', list(o.touches, (v) => (o.touches = v)), 'ATR'))
        box.appendChild(row('ATR period', num(o.atrPeriod, (v) => (o.atrPeriod = Math.max(1, Math.round(v ?? 14))), { min: 1, step: '1', width: '4rem' })))
      },
      false
    )
  }

  function notesSection(): HTMLElement {
    return section(
      'notes',
      'Notes',
      strategy.notes ? strategy.notes.slice(0, 40) : '',
      (box) => {
        const area = document.createElement('textarea')
        area.className = 'kc-input wd-lab-notes'
        area.rows = 4
        area.value = strategy.notes
        area.placeholder = 'What this strategy is testing, and what you found'
        area.addEventListener('input', () => {
          strategy.notes = area.value
          changed()
        })
        box.appendChild(area)
      },
      false
    )
  }

  render()
  return {
    element,
    render,
    setStrategy(next: Strategy) {
      strategy = next
      trees.clear()
      render()
    },
    markProblems(next) {
      problems = next
      showProblemCounts()
    },
    reveal
  }
}

/** A published source reading `family` with its registry defaults and default sides. */
export function publishedFromFamily(family: LabSignalFamily | null, id: string): PublishedSource {
  if (!family) return { kind: 'published', id, title: 'Signal', plugin: '', variant: '', params: {}, sides: {}, price: 'body' }
  const params: Record<string, number> = {}
  for (const p of family.params) params[p.name] = p.default
  const sides: Record<string, 'top' | 'bottom'> = {}
  for (const label of family.labels) {
    const side = defaultSide(label)
    if (side) sides[label.id] = side
  }
  return {
    kind: 'published',
    id,
    title: family.title,
    plugin: family.plugin,
    variant: family.variant,
    params,
    sides,
    price: 'body'
  }
}
