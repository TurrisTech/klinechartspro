import { MTF_INTERVALS } from '../mtf/api'
import { GRAPH_ROOTS } from '../mtf/config'
import { offeredIntervalCodes, resolutionDurationMs } from '../periods'
import { BAR_FIELDS, BUILTIN_INDICATORS, builtinInfo, builtinOutputs, graphTitle, type ServerCatalogue, TIME_ZONES } from './catalogue'
import { defaultGraphSettings, entryIntervals, graphOverlays, type GraphSettings } from './graphentry'
import { defaultLeaf, defaultRightOperand, type EditNode, fromEditable, type GroupMode, type GroupNode, group, leafCount, toEditable } from './editable'
import {
  compile,
  describeRule,
  formatMinute,
  isLabelOperand,
  type Labeller,
  LABEL_OPS,
  NUMERIC_OPS,
  OP_WORDS,
  OPERAND_OPS,
  RuleError,
  TIME_OP_WORDS,
  TIME_OPS,
  WEEKDAYS
} from './rules'
import { normaliseSymbol } from './store'
import type { Alert, AlertDefinition, Operand, RuleLeaf } from './types'
import { ANY_LABEL, DEFAULT_REPEAT, DEFAULT_TRIGGER } from './types'

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
  /** An overlay's graph settings as the active pane has them -- what a graph entry condition
   * copies when it is chosen, and on "Copy from pane". Absent: the overlay's defaults. */
  graphSettings?: (overlayId: string) => GraphSettings
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
  /** Graph entry conditions whose settings are open, by operand. */
  const openGraphs = new Set<string>()
  /** Where the last "Copy from pane" took the settings from, said once beside them. */
  let copied = ''
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
        const before = leaf.left
        leaf.left = next
        // A different kind of value wants a different comparison: start it afresh. The same
        // kind keeps what was set, unless its label no longer exists on the new source.
        if (shape(before) !== shape(next)) resetComparison(leaf, labelChoices(next))
        else if (isLabelOperand(next) && leaf.right && 'label' in leaf.right) {
          const label = leaf.right.label
          if (!labelChoices(next).some((c) => c.value === label)) leaf.right = { label: labelChoices(next)[0]?.value ?? '' }
        }
        render()
      })
    )

    const clock = isClock(leaf.left)
    const ops = isLabelOperand(leaf.left) ? LABEL_OPS : clock ? TIME_OPS : NUMERIC_OPS
    const words = clock ? TIME_OP_WORDS : OP_WORDS
    const op = select(
      ops.map((o) => ({ value: o, label: words[o] ?? OP_WORDS[o] ?? o })),
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
    if (isLabelOperand(leaf.left)) {
      const choices = labelChoices(leaf.left)
      const current = leaf.right && 'label' in leaf.right ? leaf.right.label : ''
      const label = select(choices.length > 0 ? choices : [{ value: current, label: current || '—' }], current, (value) => {
        leaf.right = { label: value }
        refreshSummary()
      })
      label.setAttribute('aria-label', 'Which label')
      box.appendChild(label)
      return box
    }
    if (isClock(leaf.left)) {
      // A time of day is typed as one: HH:MM, kept as minutes past midnight.
      if (leaf.op === 'inside' || leaf.op === 'outside') {
        const band = leaf.right && 'band' in leaf.right ? leaf.right.band : [480, 660]
        const low = timeInput(band[0], (value) => {
          leaf.right = { band: [value, (leaf.right as { band: [number, number] }).band[1]] }
        })
        const high = timeInput(band[1], (value) => {
          leaf.right = { band: [(leaf.right as { band: [number, number] }).band[0], value] }
        })
        low.setAttribute('aria-label', 'From')
        high.setAttribute('aria-label', 'To')
        const and = el('span', 'wd-alert-muted')
        and.textContent = 'to'
        box.append(low, and, high)
        return box
      }
      const at = timeInput(leaf.right && 'value' in leaf.right ? leaf.right.value : 570, (value) => {
        leaf.right = { value }
      })
      at.setAttribute('aria-label', 'Time')
      box.appendChild(at)
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

  /** Timeframe, source, params and line for one operand. `labels` false where a labelled
   * source cannot go -- the right of a comparison, which compares numbers. */
  function operandPicker(operand: Operand, onChange: (next: Operand) => void, labels = true): HTMLElement {
    const box = el('span', 'wd-alert-operand')
    // A graph entry is on the overlay's shortest timeframes, which are the only ones it stars.
    const codes = operand.kind === 'graph' ? entryIntervals() : intervals()
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
    if (labels) {
      optionGroup('Signals', (catalogue?.signals ?? []).map((f) => ({ value: `sig:${f.plugin}/${f.variant}`, label: f.title })))
      optionGroup('Graph entries', graphOverlays().map((o) => ({ value: `gph:${o.id}`, label: `${graphTitle(o.id)} graph entry` })))
      optionGroup('Time', [
        { value: 'tim:minute', label: 'Time of day' },
        { value: 'tim:weekday', label: 'Weekday' }
      ])
    }
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
    } else if (operand.kind === 'graph') {
      box.appendChild(graphSettingsEditor(operand, onChange))
    } else if (operand.kind === 'time') {
      const zones = TIME_ZONES.some((z) => z.zone === operand.zone) ? TIME_ZONES : [{ zone: operand.zone, label: operand.zone }, ...TIME_ZONES]
      const zone = select(
        zones.map((z) => ({ value: z.zone, label: z.label })),
        operand.zone,
        (value) => onChange({ ...operand, zone: value })
      )
      zone.setAttribute('aria-label', 'Clock')
      zone.title = 'Whose clock: the time of day and the weekday are read on it'
      box.appendChild(zone)
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
    if (kind === 'gph') {
      const entry = entryIntervals().includes(interval) ? interval : '5m'
      return withEntry({ kind: 'graph', interval: entry, overlay: rest, ...graphSettingsFor(rest) }, entry)
    }
    if (kind === 'tim') return { kind: 'time', interval, field: rest === 'weekday' ? 'weekday' : 'minute', zone: 'America/New_York' }
    return null
  }

  /** The labels a labelled source can be compared with, "any side" first where that means
   * something (a signal, a graph entry; never a weekday). */
  function labelChoices(operand: Operand): Array<{ value: string; label: string }> {
    if (operand.kind === 'signal') {
      const family = catalogue?.signals.find((f) => f.plugin === operand.plugin && f.variant === operand.variant)
      return [{ value: ANY_LABEL, label: 'any side' }, ...(family?.labels ?? []).map((l) => ({ value: l.id, label: l.label }))]
    }
    if (operand.kind === 'graph') {
      return [
        { value: ANY_LABEL, label: 'any side' },
        { value: 'top', label: 'top (a graph climbing above the price)' },
        { value: 'bottom', label: 'bottom (a graph falling below it)' }
      ]
    }
    if (operand.kind === 'time' && operand.field === 'weekday') return WEEKDAYS.map((d) => ({ value: d, label: d }))
    return []
  }

  /** The graph settings a new graph entry starts from: the active pane's, else the defaults. */
  function graphSettingsFor(overlayId: string): { timeframes: string[]; roots: string[]; maxStep: number } {
    const settings = options.context.graphSettings?.(overlayId) ?? defaultGraphSettings()
    return { timeframes: settings.timeframes, roots: settings.roots, maxStep: settings.maxStep }
  }

  /** Timeframes, roots and the largest step of one graph entry condition: a summary line, the
   * copy from the active pane, and the settings themselves behind a toggle. */
  function graphSettingsEditor(operand: Extract<Operand, { kind: 'graph' }>, onChange: (next: Operand) => void): HTMLElement {
    const box = el('span', 'wd-alert-graph')
    const summary = el('span', 'wd-alert-muted wd-alert-graph-summary')
    summary.textContent = `from ${operand.roots.join(' ') || '—'} · ${operand.timeframes.join(' ')} · step ${operand.maxStep}×`
    summary.title = 'The graph this alert builds: the timeframes it reads, the roots graphs start from, and the largest step down'
    // Keyed by the overlay, not by the settings: an edit to them must not close the panel.
    const key = operand.overlay
    const open = openGraphs.has(key)
    const toggle = button('kc-button wd-alert-link', open ? 'Done' : 'Settings', () => {
      if (open) openGraphs.delete(key)
      else openGraphs.add(key)
      render()
    })
    const copy = button('kc-button wd-alert-link', 'Copy from pane', () => {
      const settings = options.context.graphSettings?.(operand.overlay) ?? defaultGraphSettings()
      copied = settings.from
      onChange(withEntry({ ...operand, timeframes: settings.timeframes, roots: settings.roots, maxStep: settings.maxStep }, operand.interval))
    })
    copy.title = 'Take the active pane\'s settings for this overlay'
    box.append(summary, toggle, copy)
    if (copied) {
      const from = el('span', 'wd-alert-muted')
      from.textContent = `(copied from ${copied})`
      box.appendChild(from)
    }
    if (!open) return box
    const panel = el('div', 'wd-alert-graph-settings')
    const checks = (title: string, all: readonly string[], on: readonly string[], set: (next: string[]) => void): HTMLElement => {
      const row = el('div', 'wd-alert-graph-row')
      const caption = el('span', 'wd-alert-caption')
      caption.textContent = title
      row.appendChild(caption)
      for (const code of all) {
        const label = el('label', 'wd-alert-check')
        const box = document.createElement('input')
        box.type = 'checkbox'
        box.checked = on.includes(code)
        box.addEventListener('change', () => set(box.checked ? [...on, code] : on.filter((c) => c !== code)))
        label.append(box, code)
        row.appendChild(label)
      }
      return row
    }
    const byLength = (codes: string[]): string[] => [...new Set(codes)].sort((a, b) => resolutionDurationMs(a) - resolutionDurationMs(b))
    // A root is a timeframe the graph reads, so switching one on reads it, and switching a
    // timeframe off stops it being a root.
    panel.append(
      checks('Timeframes', MTF_INTERVALS, operand.timeframes, (next) =>
        onChange({ ...operand, timeframes: byLength(next), roots: operand.roots.filter((root) => next.includes(root)) })
      ),
      checks('Roots', GRAPH_ROOTS, operand.roots, (next) =>
        onChange({ ...operand, roots: byLength(next).reverse(), timeframes: byLength([...operand.timeframes, ...next]) })
      )
    )
    const stepRow = el('div', 'wd-alert-graph-row')
    const caption = el('span', 'wd-alert-caption')
    caption.textContent = 'Largest step (×)'
    const step = numberInput(operand.maxStep, () => {})
    step.addEventListener('change', () => {
      const n = Math.round(Number(step.value))
      if (Number.isFinite(n) && n >= 2) onChange({ ...operand, maxStep: n })
    })
    stepRow.append(caption, step)
    panel.appendChild(stepRow)
    box.appendChild(panel)
    return box
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
    case 'graph':
      return `gph:${operand.overlay}`
    case 'time':
      return `tim:${operand.field}`
  }
}

/** Whether an operand reads the clock's time of day (compared with times, not numbers). */
function isClock(operand: Operand): boolean {
  return operand.kind === 'time' && operand.field === 'minute'
}

/** What kind of comparison an operand takes: a label (per source), a time of day, a number. */
function shape(operand: Operand): string {
  if (operand.kind === 'signal') return `signal:${operand.plugin}/${operand.variant}`
  if (operand.kind === 'graph') return 'graph'
  if (operand.kind === 'time') return `time:${operand.field}`
  return 'number'
}

/** A comparison started afresh for a new kind of value: "is any side" for a signal or a graph
 * entry, Monday for a weekday, "reaches 09:30" for a time of day, "crosses above 0" otherwise. */
function resetComparison(leaf: RuleLeaf, labels: Array<{ value: string }>): void {
  if (isLabelOperand(leaf.left)) {
    leaf.op = '=='
    leaf.right = { label: labels[0]?.value ?? '' }
  } else if (isClock(leaf.left)) {
    leaf.op = 'crosses_above'
    leaf.right = { value: 570 }
  } else {
    leaf.op = 'crosses_above'
    leaf.right = { value: 0 }
  }
}

/** A graph entry on `interval` needs the graph to read that timeframe, and a root among what it
 * reads: added when missing, so a pane with 3m and 5m switched off still yields an alert that
 * can fire (the editor's summary shows the result). */
function withEntry(operand: Extract<Operand, { kind: 'graph' }>, interval: string): Extract<Operand, { kind: 'graph' }> {
  const byLength = (codes: string[]): string[] => [...new Set(codes)].sort((a, b) => resolutionDurationMs(a) - resolutionDurationMs(b))
  const timeframes = byLength([...operand.timeframes, interval])
  let roots = operand.roots.filter((root) => timeframes.includes(root))
  if (roots.length === 0) {
    roots = ['1D']
    timeframes.push('1D')
  }
  return { ...operand, interval, timeframes: byLength(timeframes), roots }
}

/** Change a condition's operator, keeping what it compares with where that still makes sense. */
function setOp(leaf: RuleLeaf, op: string): void {
  leaf.op = op
  const right = leaf.right
  if (op === 'changed') {
    leaf.right = undefined
    return
  }
  if (isLabelOperand(leaf.left)) return
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

/** A time of day, typed HH:MM, committed as minutes past midnight. */
function timeInput(minute: number, onValue: (minute: number) => void): HTMLInputElement {
  const i = document.createElement('input')
  i.type = 'time'
  i.className = 'kc-input wd-alert-time'
  i.value = formatMinute(minute)
  const commit = (): void => {
    const m = /^(\d{1,2}):(\d{2})/.exec(i.value)
    if (m) onValue(Number(m[1]) * 60 + Number(m[2]))
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
