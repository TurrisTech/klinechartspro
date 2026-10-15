import { defaultLeaf, fromEditable, type GroupNode, group, toEditable } from '../alerts/editable'
import { button, el, iconButton, input, select } from '../alerts/dom'
import { compile, RuleError } from '../alerts/rules'
import { createRuleTree } from '../alerts/ruletree'
import type { Rule } from '../alerts/types'
import { resolutionDurationMs } from '../periods'
import { defaultSide, labIndicators, type LabCatalogue, type LabSignalFamily } from './catalogue'
import { exprProblem } from './expr'
import {
  defaultGraphEntry,
  defaultStep,
  type Level,
  type ParentRule,
  type PriceAnchor,
  type PublishedSource,
  RANK_TIMEFRAMES,
  type RootJoin,
  type RuleSource,
  SCOPES,
  scopeFunctions,
  SELF_INTERVAL,
  type SignalSource,
  type SlotCondition,
  type SlotScope,
  type Strategy,
  withInterval
} from './model'

// GLUE (DOM). The Strategy Lab's editor: every slot of a strategy (model.ts), in the order a run
// reads them -- the signal pool, the graph, the entries, the exits, the account, the outcomes.
//
// It edits the strategy it is handed IN PLACE and calls `onChange` after every edit; the page
// decides what an edit means (a draft that differs from the saved strategy, and a re-run). A
// structural edit re-renders the form; a typed expression or number moves the model as it is
// typed and is checked on the spot, so a keystroke never takes the focus away.
//
// An expression slot shows the condition the preset wrote ("goes further its graph's way") until
// its text is edited, the problem with it as it is typed, and -- behind "Fields" -- every name and
// function that slot can read (model.ts `SCOPES`).

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
}

export function createStrategyEditor(initial: Strategy, context: EditorContext, onChange: () => void): StrategyEditor {
  let strategy = initial
  const element = el('div', 'wd-lab-editor')
  /** Sections and sub-panels the user opened or closed, by key. */
  const open = new Map<string, boolean>()
  /** Editable rule trees, by slot, so an unfinished condition survives a re-render. */
  const trees = new Map<string, GroupNode>()

  const changed = (): void => {
    onChange()
  }
  const restructure = (): void => {
    render()
    onChange()
  }

  function render(): void {
    const scroll = element.scrollTop
    element.innerHTML = ''
    element.append(poolSection(), graphSection(), entrySection(), exitSection(), sizingSection(), outcomeSection(), notesSection())
    element.scrollTop = scroll
  }

  // -- layout helpers -------------------------------------------------------------------------

  function section(key: string, title: string, summary: string, body: (box: HTMLElement) => void, openByDefault = true): HTMLElement {
    const details = document.createElement('details')
    details.className = 'wd-lab-section'
    details.open = open.get(key) ?? openByDefault
    details.addEventListener('toggle', () => open.set(key, details.open))
    const head = document.createElement('summary')
    const t = el('span', 'wd-lab-section-title')
    t.textContent = title
    const s = el('span', 'wd-lab-section-summary')
    s.textContent = summary
    head.append(t, s)
    details.appendChild(head)
    const box = el('div', 'wd-lab-section-body')
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
      const n = counts?.(code)
      if (n !== null && n !== undefined && on.includes(code)) {
        const badge = el('span', 'wd-lab-chip-count')
        badge.textContent = String(n)
        badge.title = `${n} signal${n === 1 ? '' : 's'} in the last run's window`
        b.appendChild(badge)
      }
      box.appendChild(b)
    }
    return box
  }

  const byLength = (codes: Iterable<string>): string[] => [...new Set(codes)].sort((a, b) => resolutionDurationMs(a) - resolutionDurationMs(b))

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
    check()
    box.append(field, problem)
    return box
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
    details.appendChild(note(scope.note))
    const table = el('dl', 'wd-lab-field-list')
    for (const f of scope.fields) {
      const dt = el('dt', '')
      dt.textContent = f.name
      const dd = el('dd', '')
      dd.textContent = f.doc
      table.append(dt, dd)
    }
    for (const f of scopeFunctions(scope)) {
      const dt = el('dt', '')
      dt.textContent = f.signature
      const dd = el('dd', '')
      dd.textContent = f.doc
      table.append(dt, dd)
    }
    details.appendChild(table)
    return details
  }

  let conditionCounter = 0
  /** A slot of several conditions, all of which must hold. */
  function conditionList(key: string, conditions: SlotCondition[], scope: SlotScope, presets: () => SlotCondition[], presetName: string): HTMLElement {
    const box = el('div', 'wd-lab-conditions')
    conditions.forEach((condition, i) => {
      const line = el('div', `wd-lab-condition${condition.enabled ? '' : ' is-off'}`)
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
    if (conditions.length === 0) box.appendChild(note('No conditions: every one passes.'))
    const actions = el('div', 'wd-lab-actions')
    actions.append(
      button('kc-button wd-alert-link', '+ Condition', () => {
        conditionCounter++
        conditions.push({ id: `c${Date.now().toString(36)}${conditionCounter}`, expr: '', enabled: true })
        restructure()
      }),
      button('kc-button wd-alert-link', `Reset to ${presetName}`, () => {
        conditions.splice(0, conditions.length, ...presets())
        restructure()
      }),
      fieldHelp(`${key}:fields`, scope)
    )
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

  function poolSection(): HTMLElement {
    const n = strategy.sources.length
    return section('pool', 'Signals', `${n} source${n === 1 ? '' : 's'}`, (box) => {
      box.appendChild(note('The signal pool: what graphs are built from, or -- with the graph off -- the events entries are chosen among. Each source is read on the timeframes switched on.'))
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
            timeframes: [context.intervals().includes('1h') ? '1h' : (context.intervals()[0] ?? '1h')],
            top: { left: { kind: 'indicator', interval: SELF_INTERVAL, name: 'RSI', params: [14], output: 'rsi1' }, op: 'crosses_below', right: { value: 70 } },
            bottom: { left: { kind: 'indicator', interval: SELF_INTERVAL, name: 'RSI', params: [14], output: 'rsi1' }, op: 'crosses_above', right: { value: 30 } },
            price: 'close'
          })
          restructure()
        })
      )
      box.appendChild(actions)
    })
  }

  function freshId(prefix: string): string {
    const used = new Set(strategy.sources.map((s) => s.id))
    for (let k = 1; ; k++) if (!used.has(`${prefix}${k}`)) return `${prefix}${k}`
  }

  function sourceCard(source: SignalSource, index: number): HTMLElement {
    const card = el('div', 'wd-lab-card')
    const head = el('div', 'wd-lab-card-head')
    const title = input('text', source.title, (value) => {
      source.title = value
      changed()
    })
    title.classList.add('wd-lab-title-input')
    title.setAttribute('aria-label', 'Source title')
    const id = input('text', source.id, (value) => {
      // Renaming a source renames it where the graph names it.
      const before = source.id
      source.id = value.trim()
      if (strategy.graph.rootSources) strategy.graph.rootSources = strategy.graph.rootSources.map((s) => (s === before ? source.id : s))
      changed()
    })
    id.classList.add('wd-lab-id-input')
    id.title = 'Its id: what node.source reads, and what the graph names it by'
    id.setAttribute('aria-label', 'Source id')
    const remove = iconButton('×', 'Remove this source', () => {
      strategy.sources.splice(index, 1)
      if (strategy.graph.rootSources) strategy.graph.rootSources = strategy.graph.rootSources.filter((s) => s !== source.id)
      restructure()
    })
    const kind = el('span', 'wd-lab-badge')
    kind.textContent = source.kind === 'published' ? 'signal' : 'rule'
    head.append(kind, title, id, remove)
    card.appendChild(head)

    const counts = context.counts()
    const countOf = (code: string): number | null => counts?.get(`${source.id}|${code}`) ?? null
    const offered = byLength([...context.intervals(), ...source.timeframes])
    card.appendChild(
      row(
        'Timeframes',
        chips(
          source.kind === 'published' && source.plugin === 'arev21_outlier' ? offered.filter((c) => RANK_TIMEFRAMES.includes(c) || source.timeframes.includes(c)) : offered,
          source.timeframes,
          (code, on) => {
            source.timeframes = on ? byLength([...source.timeframes, code]) : source.timeframes.filter((c) => c !== code)
          },
          countOf
        )
      )
    )
    if (source.kind === 'published') publishedFields(card, source)
    else ruleFields(card, source)
    card.appendChild(
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
          Object.assign(source, { ...fresh, timeframes: source.timeframes, price: source.price })
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
          changed()
        }
      )
      const l = el('label', 'wd-lab-param')
      l.append(document.createTextNode(`${label.label} is`), pick)
      sides.appendChild(l)
    }
    card.appendChild(row('Labels', sides))
  }

  function ruleFields(card: HTMLElement, source: RuleSource): void {
    const defaultInterval = (): string => source.timeframes[0] ?? '1h'
    card.appendChild(ruleSlot(`${source.id}:top`, source.top, (rule) => (source.top = rule), { label: 'A top where this starts to hold', self: true, defaultInterval }))
    card.appendChild(ruleSlot(`${source.id}:bottom`, source.bottom, (rule) => (source.bottom = rule), { label: 'A bottom where this starts to hold', self: true, defaultInterval }))
    card.appendChild(note("'its own' is the event's timeframe: one rule, read on every timeframe switched on above."))
  }

  function graphSection(): HTMLElement {
    const g = strategy.graph
    const summary = g.enabled ? `from ${g.roots.join(' ') || '—'} · ${g.step.filter((c) => c.enabled).length} step conditions` : 'off: entries straight from the events'
    return section('graph', 'Graph', summary, (box) => {
      box.appendChild(checkbox('Build graphs from the signals', g.enabled, (on) => (g.enabled = on), 'Off: every event of the pool is a candidate entry, read by the entry test alone'))
      if (!g.enabled) return
      const pool = byLength(strategy.sources.flatMap((s) => s.timeframes))
      box.appendChild(
        row(
          'Roots',
          chips(pool, g.roots, (code, on) => {
            g.roots = on ? byLength([...g.roots, code]).reverse() : g.roots.filter((c) => c !== code)
          })
        )
      )
      if (strategy.sources.length > 1) {
        const which = el('span', 'wd-lab-chips')
        const any = g.rootSources === null
        which.appendChild(checkbox('any source', any, (on) => (g.rootSources = on ? null : strategy.sources.map((s) => s.id))))
        if (!any) {
          for (const s of strategy.sources) {
            which.appendChild(
              checkbox(s.title || s.id, g.rootSources?.includes(s.id) ?? false, (on) => {
                const list = g.rootSources ?? []
                g.rootSources = on ? [...list, s.id] : list.filter((x) => x !== s.id)
              })
            )
          }
        }
        box.appendChild(row('Rooted by', which))
      }
      box.appendChild(
        row(
          'A same-side root',
          select(
            [
              { value: 'join', label: 'joins the open graph as another root (overlay)' },
              { value: 'new', label: 'starts a new graph' },
              { value: 'ignore', label: 'is ignored: the first root of a run is the only one' }
            ],
            g.rootJoin,
            (value) => {
              g.rootJoin = value as RootJoin
              changed()
            }
          )
        )
      )
      box.appendChild(checkbox("A signal already stepping in a longer root's graph roots nothing", g.takenDontRoot, (on) => (g.takenDontRoot = on)))
      box.appendChild(checkbox('A graph only goes further: each node beyond every node before it', g.reach, (on) => (g.reach = on)))
      box.appendChild(
        row(
          'A signal hangs from',
          select(
            [
              { value: 'supersede', label: "its timeframe's last node if it goes further, else the latest longer-timeframe node (overlay)" },
              { value: 'recent', label: 'the most recent node it may step from' },
              { value: 'nearest', label: 'the node nearest it in price' },
              { value: 'root', label: "the graph's latest root" }
            ],
            g.parent,
            (value) => {
              g.parent = value as ParentRule
              changed()
            }
          )
        )
      )
      const step = el('div', 'wd-lab-subsection')
      const stepHead = el('div', 'wd-lab-subhead')
      stepHead.textContent = 'Step test -- a signal may hang from a node when all of these hold (and it is the same side, and strictly later)'
      step.append(stepHead, conditionList('step', g.step, SCOPES.step, () => defaultStep(), "the overlay's"))
      box.appendChild(step)

      const end = el('div', 'wd-lab-subsection')
      const endHead = el('div', 'wd-lab-subhead')
      endHead.textContent = 'A graph also ends -- besides its root switching side'
      end.appendChild(endHead)
      end.appendChild(row('after', num(g.end.rootBars, (v) => (g.end.rootBars = v === null ? null : Math.max(1, Math.round(v))), { min: 1, step: '1', empty: true, width: '5rem' }), 'bars of its root timeframe (blank: never)'))
      const watch = select([{ value: '', label: 'the shortest pooled timeframe' }, ...pool.map((c) => ({ value: c, label: c }))], g.end.watch ?? '', (value) => {
        g.end.watch = value || null
        changed()
      })
      end.appendChild(row('at the first close of', watch, 'where'))
      end.appendChild(exprField(g.end.when, SCOPES.end, (text) => (g.end.when = text), 'never (e.g. (bar.close - root.price) * dir < 0)'))
      end.appendChild(fieldHelp('end:fields', SCOPES.end))
      box.appendChild(end)

      box.appendChild(
        row(
          'History',
          'a root reads back',
          num(g.lookback.rootBars, (v) => (g.lookback.rootBars = Math.max(1, Math.round(v ?? 300))), { min: 1, step: '1', width: '5rem' }),
          'of its bars; any other timeframe at most',
          num(g.lookback.maxBars, (v) => (g.lookback.maxBars = Math.max(1, Math.round(v ?? 10000))), { min: 1, step: '1', width: '6rem' })
        )
      )
    })
  }

  function entrySection(): HTMLElement {
    const e = strategy.entry
    const summary = `${e.when.filter((c) => c.enabled).length} conditions${e.filter ? ' · filtered' : ''} · tops ${e.direction.top}, bottoms ${e.direction.bottom}`
    return section('entry', 'Entries', summary, (box) => {
      const head = el('div', 'wd-lab-subhead')
      head.textContent = strategy.graph.enabled ? 'A node is an entry when all of these hold, as it joins its graph' : 'An event is an entry when all of these hold'
      box.append(head, conditionList('entry', e.when, SCOPES.entry, () => (strategy.graph.enabled ? defaultGraphEntry() : []), strategy.graph.enabled ? "the overlay's stars" : 'none'))
      box.appendChild(ruleSlot('filter', e.filter, (rule) => (e.filter = rule), { label: 'Only where this holds at the entry (each timeframe at its latest close)', defaultInterval: () => '1D' }))
      const dir = (side: 'top' | 'bottom'): HTMLSelectElement =>
        select(
          [
            { value: 'long', label: 'long' },
            { value: 'short', label: 'short' }
          ],
          e.direction[side],
          (value) => {
            e.direction[side] = value === 'short' ? 'short' : 'long'
            changed()
          }
        )
      box.appendChild(row('A top entry goes', dir('top'), 'and a bottom entry', dir('bottom')))
    })
  }

  function exitSection(): HTMLElement {
    const x = strategy.exits
    const bits = [x.stop ? 'stop' : '', x.target ? 'target' : '', x.breakevenAtR !== null ? 'breakeven' : '', x.trail ? 'trail' : '', x.ruleLong || x.ruleShort ? 'rule' : '', x.maxBars ? `${x.maxBars.count} bars` : ''].filter(Boolean)
    return section('exits', 'Exits', bits.join(' · ') || 'none', (box) => {
      box.appendChild(row('Stop', levelEditor('stop', x.stop, 'stop', (l) => (x.stop = l))))
      box.appendChild(row('Target', levelEditor('target', x.target, 'target', (l) => (x.target = l))))
      box.appendChild(
        row(
          '',
          checkbox('Breakeven once', x.breakevenAtR !== null, (on) => (x.breakevenAtR = on ? 1 : null)),
          ...(x.breakevenAtR !== null ? [num(x.breakevenAtR, (v) => (x.breakevenAtR = v ?? 1), { min: 0, width: '4.5rem' }), 'R in'] : [])
        )
      )
      box.appendChild(checkbox('Trailing stop', x.trail !== null, (on) => (x.trail = on ? { distance: { kind: 'atr', mult: 1.5, period: 14, interval: null }, activateR: 1 } : null)))
      if (x.trail) {
        const trail = x.trail
        box.appendChild(row('behind the best close by', levelEditor('trail', trail.distance, 'trail', (l) => (trail.distance = l ?? trail.distance))))
        box.appendChild(row('once', num(trail.activateR, (v) => (trail.activateR = v ?? 0), { min: 0, width: '4.5rem' }), 'R in (0: at once)'))
      }
      box.appendChild(ruleSlot('exit-long', x.ruleLong, (rule) => (x.ruleLong = rule), { label: 'Close a long where this holds', defaultInterval: () => context.intervals()[0] ?? '1h' }))
      box.appendChild(ruleSlot('exit-short', x.ruleShort, (rule) => (x.ruleShort = rule), { label: 'Close a short where this holds', defaultInterval: () => context.intervals()[0] ?? '1h' }))
      box.appendChild(checkbox('Time limit', x.maxBars !== null, (on) => (x.maxBars = on ? { count: 48, interval: null } : null)))
      if (x.maxBars) {
        const limit = x.maxBars
        const tf = select([{ value: '', label: "the entry's timeframe" }, ...context.intervals().map((c) => ({ value: c, label: c }))], limit.interval ?? '', (value) => {
          limit.interval = value || null
          changed()
        })
        box.appendChild(row('close after', num(limit.count, (v) => (limit.count = Math.max(1, Math.round(v ?? 1))), { min: 1, step: '1', width: '5rem' }), 'bars of', tf))
      }
      box.appendChild(checkbox('An entry the other way closes what is open first', x.onOpposite, (on) => (x.onOpposite = on)))
    })
  }

  function sizingSection(): HTMLElement {
    const s = strategy.sizing
    const path = strategy.pathInterval
    return section(
      'sizing',
      'Account & simulation',
      `${s.mode === 'risk' ? `${s.riskPercent}% risk` : `${s.units} units`} · ${s.maxOpen} open · path ${path ?? 'auto'}`,
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
        const tf = select([{ value: '', label: "auto: the longest stored timeframe tiling every entry's" }, ...['5s', '1m', '1h', '1D'].map((c) => ({ value: c, label: c }))], path ?? '', (value) => {
          strategy.pathInterval = value || null
          changed()
        })
        box.appendChild(row('Path bars', tf))
        box.appendChild(note('Trades and outcomes are walked on the path bars, with bid/ask where the store has it. An entry no path bar closes at is refused, never moved.'))
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
    }
  }
}

/** A published source reading `family` with its registry defaults and default sides. */
export function publishedFromFamily(family: LabSignalFamily | null, id: string): PublishedSource {
  if (!family) return { kind: 'published', id, title: 'Signal', plugin: '', variant: '', params: {}, timeframes: ['1h'], sides: {}, price: 'body' }
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
    timeframes: ['1h'],
    sides,
    price: 'body'
  }
}
