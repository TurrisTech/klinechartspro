import { offeredIntervalCodes, resolutionDurationMs } from '../periods'
import { BAR_FIELDS, BUILTIN_INDICATORS, builtinInfo, builtinOutputs, type ServerCatalogue } from './catalogue'
import { defaultLeaf, defaultRightOperand, type EditNode, fromEditable, type GroupMode, type GroupNode, group, leafCount, toEditable } from './editable'
import { compile, describeRule, type Labeller, LABEL_OPS, NUMERIC_OPS, OP_WORDS, OPERAND_OPS, RuleError } from './rules'
import { normaliseSymbol } from './store'
import type { Alert, AlertDefinition, Operand, RuleLeaf } from './types'
import { DEFAULT_REPEAT, DEFAULT_TRIGGER } from './types'

// GLUE (DOM). The alert editor: a name, an instrument, a rule, and how it fires.
//
// The rule is a tree of groups (all / any / none) of conditions (./editable.ts), one editor for
// "simple" and "compound" alike -- a simple alert is a group of one. Each condition is
//
//   [timeframe] [what] (params) [which line]  [operator]  [a number | another series | a range | a label]
//
// and every condition picks its own timeframe, so a rule may read a 1h RSI and a 4h EMA. The
// sentence under the rule is the rule read back (./rules.ts `describeRule`), and it is compiled
// on every change: what cannot be evaluated says why, and cannot be saved.
//
// Plain DOM in the house style (`kc-*` tokens, `wd-*` classes), like every control in client/.
// Selects re-render the form; typed numbers are committed on change and only refresh the
// sentence while typing, so a keystroke never takes the focus away.

export interface EditorContext {
  /** Where a new alert starts: the active pane's instrument and timeframe. */
  symbol: string
  interval: string
  /** Instruments offered by the instrument field (the wall's panes). */
  symbols: string[]
}

export interface AlertEditorOptions {
  /** The alert being edited, or null for a new one. */
  alert: Alert | null
  context: EditorContext
  /** The server's indicators and signals, when loaded: without it only the bar fields and the
   * built-ins are offered. */
  catalogue: ServerCatalogue | null
  label: Labeller
  onSave(definition: AlertDefinition): Promise<void>
  onCancel(): void
}

export interface AlertEditor {
  readonly element: HTMLElement
}

export function createAlertEditor(options: AlertEditorOptions): AlertEditor {
  const { catalogue } = options
  const initial = options.alert
  let symbol = initial?.symbol ?? options.context.symbol
  let name = initial?.name ?? ''
  let note = initial?.note ?? ''
  let trigger = initial?.trigger ?? DEFAULT_TRIGGER
  let repeat = initial?.repeat ?? DEFAULT_REPEAT
  const root: GroupNode = initial ? toEditable(initial.rule) : group('all', [{ kind: 'leaf', leaf: defaultLeaf(options.context.interval) }])
  let saving = false
  let failure = ''

  const element = el('div', 'wd-alert-editor')
  // A typed number moves the model as it is typed; the sentence and the check follow it.
  element.addEventListener('wd-alert-edited', () => refreshSummary())
  let sentence: HTMLElement | null = null
  let problem: HTMLElement | null = null
  let save: HTMLButtonElement | null = null

  function definition(): AlertDefinition {
    const rule = fromEditable(root)
    // Left blank, it is named by the sentence the user is reading.
    return { name: name.trim() || describeRule(rule, options.label), note, enabled: initial?.enabled ?? true, symbol, rule, trigger, repeat, cooldownMs: initial?.cooldownMs ?? 0 }
  }

  /** The rule read back, and whatever stops it being saved. */
  function check(): string {
    try {
      normaliseSymbol(symbol)
      compile(fromEditable(root))
      return ''
    } catch (err) {
      return err instanceof RuleError ? err.message : String(err)
    }
  }

  function refreshSummary(): void {
    const error = check()
    if (sentence) sentence.textContent = describeRule(fromEditable(root), options.label)
    if (problem) {
      problem.textContent = failure || error
      problem.hidden = !(failure || error)
    }
    if (save) save.disabled = saving || error !== ''
  }

  function intervals(): string[] {
    const at = symbol.indexOf(':')
    const offered = at > 0 ? offeredIntervalCodes(symbol.slice(0, at), symbol.slice(at + 1)) : []
    return [...new Set(offered)].sort((a, b) => resolutionDurationMs(a) - resolutionDurationMs(b))
  }

  function render(): void {
    element.innerHTML = ''
    failure = ''

    const head = el('div', 'wd-alert-fields')
    const nameInput = input('text', name, (value) => {
      name = value
    })
    nameInput.placeholder = 'Named after its rule when left blank'
    nameInput.setAttribute('aria-label', 'Name')
    head.appendChild(labelled('Name', nameInput))

    const symbolInput = input('text', symbol, () => {})
    symbolInput.setAttribute('aria-label', 'Instrument')
    symbolInput.setAttribute('list', 'wd-alert-symbols')
    const list = document.createElement('datalist')
    list.id = 'wd-alert-symbols'
    for (const known of options.context.symbols) {
      const option = document.createElement('option')
      option.value = known
      list.appendChild(option)
    }
    symbolInput.addEventListener('change', () => {
      try {
        symbol = normaliseSymbol(symbolInput.value)
      } catch {
        symbol = symbolInput.value.trim()
      }
      render()
    })
    symbolInput.title = 'vendor:TICKER -- every condition reads this instrument'
    head.append(labelled('Instrument', symbolInput), list)
    element.appendChild(head)

    const ruleBox = el('div', 'wd-alert-rule')
    ruleBox.appendChild(renderGroup(root, null))
    element.appendChild(ruleBox)

    sentence = el('div', 'wd-alert-sentence')
    element.appendChild(sentence)

    const policy = el('div', 'wd-alert-fields')
    policy.appendChild(
      labelled(
        'Fires',
        select(
          [
            { value: 'level', label: 'at every bar close where the rule holds' },
            { value: 'edge', label: 'only at the close where it starts holding' }
          ],
          trigger,
          (value) => {
            trigger = value === 'edge' ? 'edge' : 'level'
          }
        )
      )
    )
    policy.appendChild(
      labelled(
        'Then',
        select(
          [
            { value: 'always', label: 'keeps watching' },
            { value: 'once', label: 'stops until re-armed' }
          ],
          repeat,
          (value) => {
            repeat = value === 'once' ? 'once' : 'always'
          }
        )
      )
    )
    const noteInput = input('text', note, (value) => {
      note = value
    })
    noteInput.placeholder = 'Optional, shown in the notification'
    noteInput.setAttribute('aria-label', 'Note')
    policy.appendChild(labelled('Note', noteInput))
    element.appendChild(policy)

    const help = el('div', 'wd-alert-help')
    help.textContent =
      'Evaluated at each bar close, in this browser while a dashboard tab is open. A value counts from its bar’s close; a bar still forming is never read.'
    element.appendChild(help)

    problem = el('div', 'wd-alert-problem')
    element.appendChild(problem)

    const actions = el('div', 'wd-alert-footer')
    const cancel = button('kc-button kc-button-outline', 'Cancel', () => options.onCancel())
    save = button('kc-button kc-button-primary', initial ? 'Save changes' : 'Create alert', () => {
      if (saving || check()) return
      saving = true
      refreshSummary()
      options
        .onSave(definition())
        .catch((err) => {
          failure = err instanceof Error ? err.message : String(err)
        })
        .finally(() => {
          saving = false
          refreshSummary()
        })
    })
    actions.append(cancel, save)
    element.appendChild(actions)
    refreshSummary()
  }

  // -- the tree -------------------------------------------------------------------------------

  function renderGroup(node: GroupNode, parent: GroupNode | null): HTMLElement {
    const box = el('div', `wd-alert-group${parent ? ' is-nested' : ''}`)
    const head = el('div', 'wd-alert-group-head')
    const words: Record<GroupMode, string> = { all: 'all of these hold', any: 'any of these holds', none: 'none of these holds' }
    const mode = select(
      (Object.keys(words) as GroupMode[]).map((m) => ({ value: m, label: words[m] })),
      node.mode,
      (value) => {
        node.mode = value as GroupMode
        render()
      }
    )
    mode.setAttribute('aria-label', 'How the conditions combine')
    const lead = el('span', 'wd-alert-muted')
    lead.textContent = parent ? 'and where' : 'When'
    head.append(lead, mode)
    if (parent) {
      const remove = iconButton('×', 'Remove this group', () => {
        if (leafCount(root) - leafCount(node) < 1) return
        parent.terms.splice(parent.terms.indexOf(node), 1)
        render()
      })
      remove.disabled = leafCount(root) - leafCount(node) < 1
      head.appendChild(remove)
    }
    box.appendChild(head)

    for (const term of node.terms) {
      box.appendChild(term.kind === 'group' ? renderGroup(term, node) : renderLeaf(term.leaf, node))
    }

    const add = el('div', 'wd-alert-add')
    const lastInterval = (): string => {
      const leaves = node.terms.filter((t): t is Extract<EditNode, { kind: 'leaf' }> => t.kind === 'leaf')
      return leaves.at(-1)?.leaf.left.interval ?? options.context.interval
    }
    add.append(
      button('kc-button wd-alert-link', '+ Condition', () => {
        node.terms.push({ kind: 'leaf', leaf: defaultLeaf(lastInterval()) })
        render()
      }),
      button('kc-button wd-alert-link', '+ Group', () => {
        node.terms.push(group(node.mode === 'any' ? 'all' : 'any', [{ kind: 'leaf', leaf: defaultLeaf(lastInterval()) }]))
        render()
      })
    )
    box.appendChild(add)
    return box
  }

  function renderLeaf(leaf: RuleLeaf, parent: GroupNode): HTMLElement {
    const row = el('div', 'wd-alert-leaf')
    row.appendChild(
      operandPicker(leaf.left, (next) => {
        const wasSignal = leaf.left.kind === 'signal'
        leaf.left = next
        if (next.kind === 'signal' && !wasSignal) {
          leaf.op = '=='
          leaf.right = { label: signalLabels(next)[0]?.id ?? '' }
        } else if (next.kind !== 'signal' && wasSignal) {
          leaf.op = 'crosses_above'
          leaf.right = { value: 0 }
        } else if (next.kind === 'signal' && leaf.right && 'label' in leaf.right && !signalLabels(next).some((l) => l.id === (leaf.right as { label: string }).label)) {
          leaf.right = { label: signalLabels(next)[0]?.id ?? '' }
        }
        render()
      })
    )

    const ops = leaf.left.kind === 'signal' ? LABEL_OPS : NUMERIC_OPS
    const op = select(
      ops.map((o) => ({ value: o, label: OP_WORDS[o] ?? o })),
      leaf.op,
      (value) => {
        setOp(leaf, value)
        render()
      }
    )
    op.classList.add('wd-alert-op')
    op.setAttribute('aria-label', 'Comparison')
    row.appendChild(op)
    row.appendChild(renderRight(leaf))

    const remove = iconButton('×', 'Remove this condition', () => {
      if (leafCount(root) <= 1) return
      parent.terms.splice(parent.terms.findIndex((t) => t.kind === 'leaf' && t.leaf === leaf), 1)
      // An emptied group goes with its last condition.
      prune(root)
      render()
    })
    remove.disabled = leafCount(root) <= 1
    row.appendChild(remove)
    return row
  }

  function renderRight(leaf: RuleLeaf): HTMLElement {
    const box = el('span', 'wd-alert-right')
    if (leaf.op === 'changed') return box
    if (leaf.left.kind === 'signal') {
      const labels = signalLabels(leaf.left)
      const current = leaf.right && 'label' in leaf.right ? leaf.right.label : ''
      box.appendChild(
        select(
          labels.length > 0 ? labels.map((l) => ({ value: l.id, label: l.label })) : [{ value: current, label: current || '—' }],
          current,
          (value) => {
            leaf.right = { label: value }
            refreshSummary()
          }
        )
      )
      return box
    }
    if (leaf.op === 'inside' || leaf.op === 'outside') {
      const band = leaf.right && 'band' in leaf.right ? leaf.right.band : [0, 0]
      const low = numberInput(band[0], (value) => {
        leaf.right = { band: [value, (leaf.right as { band: [number, number] }).band[1]] }
      })
      const high = numberInput(band[1], (value) => {
        leaf.right = { band: [(leaf.right as { band: [number, number] }).band[0], value] }
      })
      low.setAttribute('aria-label', 'Low')
      high.setAttribute('aria-label', 'High')
      const and = el('span', 'wd-alert-muted')
      and.textContent = 'and'
      box.append(low, and, high)
      return box
    }
    const comparesSeries = leaf.right !== undefined && 'operand' in leaf.right
    if ((OPERAND_OPS as readonly string[]).includes(leaf.op)) {
      const kind = select(
        [
          { value: 'value', label: 'the value' },
          { value: 'series', label: 'the series' }
        ],
        comparesSeries ? 'series' : 'value',
        (value) => {
          leaf.right = value === 'series' ? { operand: defaultRightOperand(leaf.left) } : { value: 0 }
          render()
        }
      )
      kind.setAttribute('aria-label', 'Compare with')
      box.appendChild(kind)
    }
    if (comparesSeries && leaf.right && 'operand' in leaf.right) {
      box.appendChild(
        operandPicker(
          leaf.right.operand,
          (next) => {
            leaf.right = { operand: next }
            render()
          },
          false
        )
      )
      return box
    }
    const value = leaf.right && 'value' in leaf.right ? leaf.right.value : 0
    const field = numberInput(value, (next) => {
      leaf.right = { value: next }
    })
    field.setAttribute('aria-label', 'Value')
    box.appendChild(field)
    return box
  }

  /** Timeframe, source, params and line for one operand. `signals` false where a signal
   * cannot go (the right of a comparison). */
  function operandPicker(operand: Operand, onChange: (next: Operand) => void, signals = true): HTMLElement {
    const box = el('span', 'wd-alert-operand')
    const codes = intervals()
    const tf = select(
      (codes.includes(operand.interval) ? codes : [operand.interval, ...codes]).map((c) => ({ value: c, label: c })),
      operand.interval,
      (value) => onChange({ ...operand, interval: value })
    )
    tf.classList.add('wd-alert-tf')
    tf.setAttribute('aria-label', 'Timeframe')
    box.appendChild(tf)

    const source = document.createElement('select')
    source.className = 'kc-input wd-alert-source'
    source.setAttribute('aria-label', 'What to read')
    const optionGroup = (title: string, options: Array<{ value: string; label: string }>): void => {
      if (options.length === 0) return
      const groupEl = document.createElement('optgroup')
      groupEl.label = title
      for (const o of options) {
        const option = document.createElement('option')
        option.value = o.value
        option.textContent = o.label
        groupEl.appendChild(option)
      }
      source.appendChild(groupEl)
    }
    optionGroup('Price', BAR_FIELDS.map((f) => ({ value: `bar:${f.field}`, label: f.label })))
    optionGroup('Indicators', BUILTIN_INDICATORS.filter((n) => builtinInfo(n)).map((n) => ({ value: `ind:${n}`, label: n })))
    optionGroup('Server indicators', (catalogue?.stored ?? []).map((s) => ({ value: `ser:${s.entry.name}`, label: s.entry.title })))
    if (signals) optionGroup('Signals', (catalogue?.signals ?? []).map((f) => ({ value: `sig:${f.plugin}/${f.variant}`, label: f.title })))
    const current = sourceValue(operand)
    if (![...source.options].some((o) => o.value === current)) {
      // A server row this page has no catalogue entry for: keep it, by its own spelling.
      const option = document.createElement('option')
      option.value = current
      option.textContent = operand.kind === 'series' ? operand.indicator : current
      source.prepend(option)
    }
    source.value = current
    source.addEventListener('change', () => onChange(operandFor(source.value, operand.interval) ?? operand))
    box.appendChild(source)

    if (operand.kind === 'indicator') {
      const params = input('text', operand.params.join(','), () => {})
      params.className = 'kc-input wd-alert-params'
      params.setAttribute('aria-label', `${operand.name} parameters`)
      params.title = 'Parameters, comma separated (the periods)'
      params.addEventListener('change', () => {
        const next = params.value
          .split(/[,\s]+/)
          .filter(Boolean)
          .map(Number)
        if (next.length === 0 || next.some((n) => !Number.isFinite(n) || n <= 0)) {
          params.value = operand.params.join(',')
          return
        }
        const outputs = builtinOutputs(operand.name, next)
        const output = outputs.some((o) => o.key === operand.output) ? operand.output : (outputs[0]?.key ?? operand.output)
        onChange({ ...operand, params: next, output })
      })
      box.appendChild(params)
      const outputs = builtinOutputs(operand.name, operand.params)
      if (outputs.length > 1) {
        const line = select(
          outputs.map((o) => ({ value: o.key, label: o.title })),
          operand.output,
          (value) => onChange({ ...operand, output: value })
        )
        line.setAttribute('aria-label', 'Which line')
        box.appendChild(line)
      }
    } else if (operand.kind === 'series') {
      const row = catalogue?.stored.find((s) => s.entry.name === operand.indicator)
      if (row && row.series.length > 1) {
        const line = select(
          row.series.map((s) => ({ value: s.key, label: s.label || s.key })),
          operand.key,
          (value) => onChange({ ...operand, key: value })
        )
        line.setAttribute('aria-label', 'Which series')
        box.appendChild(line)
      }
    }
    return box
  }

  function operandFor(value: string, interval: string): Operand | null {
    const [kind, rest] = [value.slice(0, 3), value.slice(4)]
    if (kind === 'bar') return { kind: 'bar', interval, field: rest as never }
    if (kind === 'ind') {
      const info = builtinInfo(rest)
      if (!info) return null
      return { kind: 'indicator', interval, name: rest, params: info.defaultParams, output: builtinOutputs(rest, info.defaultParams)[0]?.key ?? '' }
    }
    if (kind === 'ser') {
      const row = catalogue?.stored.find((s) => s.entry.name === rest)
      return row ? { kind: 'series', interval, indicator: rest, key: row.series[0].key } : null
    }
    if (kind === 'sig') {
      const [plugin, variant = ''] = rest.split('/')
      return { kind: 'signal', interval, plugin, variant }
    }
    return null
  }

  function signalLabels(operand: Operand): Array<{ id: string; label: string }> {
    if (operand.kind !== 'signal') return []
    return catalogue?.signals.find((f) => f.plugin === operand.plugin && f.variant === operand.variant)?.labels ?? []
  }

  render()
  return { element }
}

/** The source select's value for an operand. */
function sourceValue(operand: Operand): string {
  switch (operand.kind) {
    case 'bar':
      return `bar:${operand.field}`
    case 'indicator':
      return `ind:${operand.name}`
    case 'series':
      return `ser:${operand.indicator}`
    case 'signal':
      return `sig:${operand.plugin}/${operand.variant}`
  }
}

/** Change a condition's operator, keeping what it compares with where that still makes sense. */
function setOp(leaf: RuleLeaf, op: string): void {
  leaf.op = op
  const right = leaf.right
  if (op === 'changed') {
    leaf.right = undefined
    return
  }
  if (leaf.left.kind === 'signal') return
  if (op === 'inside' || op === 'outside') {
    if (!right || !('band' in right)) {
      const v = right && 'value' in right ? right.value : 0
      leaf.right = { band: [v, v] }
    }
    return
  }
  if (right && 'operand' in right && (OPERAND_OPS as readonly string[]).includes(op)) return
  if (!right || !('value' in right)) leaf.right = { value: right && 'band' in right ? right.band[0] : 0 }
}

/** Drop groups left empty, so a removed last condition takes its group with it. */
function prune(node: GroupNode): void {
  node.terms = node.terms.filter((term) => {
    if (term.kind === 'leaf') return true
    prune(term)
    return term.terms.length > 0
  })
}

// -- DOM helpers ----------------------------------------------------------------------------------

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = className
  b.textContent = text
  b.addEventListener('click', onClick)
  return b
}

function iconButton(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = button('kc-button wd-alert-icon', text, onClick)
  b.title = title
  b.setAttribute('aria-label', title)
  return b
}

function select(options: Array<{ value: string; label: string }>, value: string, onChange: (value: string) => void): HTMLSelectElement {
  const s = document.createElement('select')
  s.className = 'kc-input'
  for (const o of options) {
    const option = document.createElement('option')
    option.value = o.value
    option.textContent = o.label
    s.appendChild(option)
  }
  s.value = value
  s.addEventListener('change', () => onChange(s.value))
  return s
}

function input(type: string, value: string, onInput: (value: string) => void): HTMLInputElement {
  const i = document.createElement('input')
  i.type = type
  i.className = 'kc-input'
  i.value = value
  i.addEventListener('input', () => onInput(i.value))
  return i
}

/** A number committed on change; while typing, the model follows and the sentence with it. */
function numberInput(value: number, onValue: (value: number) => void): HTMLInputElement {
  const i = document.createElement('input')
  i.type = 'number'
  i.step = 'any'
  i.className = 'kc-input wd-alert-number'
  i.value = String(value)
  const commit = (): void => {
    const n = Number(i.value)
    if (i.value.trim() !== '' && Number.isFinite(n)) onValue(n)
  }
  i.addEventListener('input', () => {
    commit()
    i.dispatchEvent(new CustomEvent('wd-alert-edited', { bubbles: true }))
  })
  i.addEventListener('change', commit)
  return i
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const label = el('label', 'wd-alert-field')
  const caption = el('span', 'wd-alert-caption')
  caption.textContent = text
  label.append(caption, control)
  return label
}
