import { offeredIntervalCodes, resolutionDurationMs } from '../periods'
import type { ServerCatalogue } from './catalogue'
import { button, el, input, labelled, select } from './dom'
import { defaultLeaf, fromEditable, type GroupNode, group, toEditable } from './editable'
import type { GraphSettings } from './graphentry'
import { compile, describeRule, type Labeller, RuleError } from './rules'
import { savedStrategies } from '../lab/store'
import { createRuleTree } from './ruletree'
import { normaliseSymbol } from './store'
import type { Alert, AlertDefinition } from './types'
import { DEFAULT_REPEAT, DEFAULT_TRIGGER } from './types'

// GLUE (DOM). The alert editor: a name, an instrument, a rule, and how it fires.
//
// The rule is a tree of groups (all / any / none) of conditions, one editor for "simple" and
// "compound" alike -- a simple alert is a group of one -- drawn by ./ruletree.ts, which the
// Strategy Lab's rules share. Every condition picks its own timeframe, so a rule may read a 1h
// RSI and a 4h EMA. The sentence under the rule is the rule read back (./rules.ts
// `describeRule`), and it is compiled on every change: what cannot be evaluated says why, and
// cannot be saved.
//
// Plain DOM in the house style (`kc-*` tokens, `wd-*` classes), like every control in client/.
// Selects re-render; typed numbers are committed on change and only refresh the sentence while
// typing, so a keystroke never takes the focus away.

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

  // The rule (./ruletree.ts): it re-renders itself on a structural edit, and a failed save's
  // message goes with the next change to it.
  const tree = createRuleTree({
    root,
    catalogue,
    intervals,
    defaultInterval: () => options.context.interval,
    graphSettings: options.context.graphSettings,
    strategies: savedStrategies,
    onChange: () => {
      failure = ''
      refreshSummary()
    }
  })

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

    tree.render()
    element.appendChild(tree.element)

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

  render()
  return { element }
}

