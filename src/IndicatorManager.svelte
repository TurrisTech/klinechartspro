<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check'
  import ChevronRightIcon from '@lucide/svelte/icons/chevron-right'
  import MinusIcon from '@lucide/svelte/icons/minus'
  import SettingsIcon from '@lucide/svelte/icons/settings-2'
  import XIcon from '@lucide/svelte/icons/x'
  import { Checkbox, Dialog } from 'bits-ui'
  import { untrack } from 'svelte'

  import { type IndicatorParamSetting, indicatorSettingsFor } from './config/indicators'
  import i18n from './i18n'
  import type { PaneState } from './state/wall.svelte'
  import {
    coverage,
    holds,
    type IndicatorRow,
    lineApplies,
    type ParamInput,
    type ParamProblem,
    resolveParams,
    rowKey,
    type SettingLine,
    settingLines,
    settleSetting,
    sharedParam,
    sharedSetting,
    usedIndicators,
    valueAt,
    withParam
  } from './state/indicatorMatrix'
  import type { IndicatorParamsValidator, IndicatorSettingField, IndicatorSettingsModel } from './types'
  import { type Box, dragOffset, type Offset, resizeBox, type Size } from './utils/drag'

  // Every indicator in use on the wall against every visible pane: a cell is "this indicator on
  // this pane", and ticking it adds or removes it through the pane's own changeIndicator -- the
  // same call the picker makes for the active pane -- so params, persistence and sub-pane
  // bookkeeping stay ChartPane's business.
  //
  // A row expands to that indicator's parameters, one line each, with the value it has on every
  // pane under that pane's column: each pane keeps its own, as the gear on its legend always
  // has, so an MA can be 20 on the 1h pane and 50 on the daily one. An edit goes through the
  // pane's setIndicatorParams, the gear dialog's own path, so it persists the same way.
  let {
    open = $bindable(),
    panes,
    activeId,
    locale,
    portalProps,
    labelFor,
    validate,
    settingsOwned,
    settingsModel,
    openSettings
  }: {
    open: boolean
    panes: PaneState[]
    activeId: string
    locale: string
    portalProps: { to: HTMLElement } | undefined
    labelFor: (row: IndicatorRow) => string
    /** The app's params check (ChartProOptions.indicatorParamsValidator); null when nobody checks. */
    validate: IndicatorParamsValidator | null
    /** ChartProOptions.indicatorSettingsOwned: such a row offers the app's own settings UI. */
    settingsOwned: ((indicatorName: string) => boolean) | null
    /** ChartProOptions.indicatorSettingsModel: such a row edits the app's per-pane config inline. */
    settingsModel: ((indicatorName: string) => IndicatorSettingsModel | null) | null
    /** The gear for one indicator on one pane, as its legend would press it. */
    openSettings: (pane: PaneState, row: IndicatorRow) => void
  } = $props()

  // The rows shown since the dialog opened, so a row whose last cell was just unticked stays
  // put and can be ticked back (see usedIndicators). Reset on every open.
  let shown = $state.raw<IndicatorRow[]>([])
  $effect(() => {
    if (open) shown = untrack(() => usedIndicators(panes))
  })
  const rows = $derived(usedIndicators(panes, shown))
  $effect(() => {
    // Remember a row that appeared while open (another pane's picker, a restored layout).
    if (open && rows.length !== untrack(() => shown.length)) shown = rows
  })

  function set(pane: PaneState, row: IndicatorRow, on: boolean): void {
    if (holds(pane, row) === on) return
    pane.api?.changeIndicator(row.name, row.main, on)
  }

  function setRow(row: IndicatorRow, on: boolean): void {
    for (const pane of panes) set(pane, row, on)
  }

  // -- Parameters ------------------------------------------------------------------------------

  // Rows showing their parameters, by rowKey. Kept across a close, like the size and position.
  let expanded = $state.raw<ReadonlySet<string>>(new Set())
  function toggle(row: IndicatorRow): void {
    const next = new Set(expanded)
    if (!next.delete(rowKey(row))) next.add(rowKey(row))
    expanded = next
  }

  // Bumped after every write this dialog makes. klinecharts' own copy of the params, which
  // liveParams reads, is not reactive; the pane's record of them is, but an edit that lands on
  // the value already recorded (a cleared cell falling back to the default it had) changes
  // nothing there, and its cell must still be redrawn.
  let revision = $state(0)

  /** What the indicator is drawing with on this pane right now, or null when the pane does not
   * hold it. Read from the chart rather than from pane.indicatorParams, which has no entry for
   * an indicator never edited (the template default) and one entry for a template sitting both
   * on the price pane and in a sub-pane. */
  function liveParams(pane: PaneState, row: IndicatorRow): unknown[] | null {
    void revision
    void pane.indicatorParams // a change from the legend's gear dialog
    const api = pane.api
    const chartPaneId = api?.indicatorPaneId(row.name, row.main)
    if (!api || !chartPaneId) return null
    return api.chart.getIndicators({ name: row.name, paneId: chartPaneId })[0]?.calcParams ?? null
  }

  function display(value: unknown): string {
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
  }

  function typed(input: HTMLInputElement): ParamInput {
    const value = input.valueAsNumber
    return Number.isFinite(value) ? value : ''
  }

  function sameParams(a: readonly unknown[], b: readonly unknown[]): boolean {
    return a.length === b.length && a.every((value, index) => value === b[index])
  }

  function paneTitle(pane: PaneState): string {
    const symbol = pane.symbol?.shortName ?? pane.symbol?.ticker ?? ''
    return `${i18n('pane', locale)} ${panes.indexOf(pane) + 1} · ${symbol} ${pane.period?.text ?? ''}`
  }

  function describe(problem: ParamProblem, settings: readonly IndicatorParamSetting[]): string {
    if (problem.kind === 'empty') return i18n('indicator_param_empty', locale)
    const name = i18n(settings[problem.index]?.paramNameKey ?? '', locale)
    const text = i18n(`indicator_param_${problem.kind}`, locale).replace('{name}', name)
    return 'bound' in problem ? text.replace('{bound}', String(problem.bound)) : text
  }

  // Refusals, by the input holding the value refused (one parameter's cell on a pane, or in the
  // All column), each a sentence naming the pane it was refused for. Shown under the row until
  // that input is edited again; forgotten on open, when every input is back to what the panes
  // hold.
  let refusals = $state.raw<Record<string, string[]>>({})
  // Inputs waiting on the app's check, by the same key.
  let checking = $state.raw<Record<string, true>>({})
  // Last write wins per input: an answer for "1" must not land after the one for "14".
  const sequence = new Map<string, number>()
  // The app's advisory note for the value an input last applied (a warm-up cost, say).
  let hints = $state.raw<Record<string, string>>({})

  function inputKey(row: IndicatorRow, param: number, column: PaneState | 'all'): string {
    return `${rowKey(row)}|${param}|${column === 'all' ? 'all' : column.id}`
  }

  function setEntry<T>(record: Record<string, T>, key: string, value: T | undefined): Record<string, T> {
    const next = { ...record }
    if (value === undefined) delete next[key]
    else next[key] = value
    return next
  }

  $effect(() => {
    if (!open) return
    untrack(() => {
      refusals = {}
      checking = {}
      hints = {}
      sequence.clear()
    })
  })

  /** One pane's params with one of them replaced by what was typed: checked against the
   * settings table, then by the app for this pane's own symbol and timeframe, then applied.
   * Answers the refusal, or the app's advisory note once applied (none when there was nothing
   * to apply). */
  async function applyParam(
    pane: PaneState,
    row: IndicatorRow,
    index: number,
    value: ParamInput
  ): Promise<{ hint: string | null } | { refused: string }> {
    const current = liveParams(pane, row)
    if (!current) return { hint: null }
    const settings = indicatorSettingsFor(row.name)
    const resolved = resolveParams(withParam(current, index, value), settings)
    if ('problem' in resolved) return { refused: describe(resolved.problem, settings) }
    if (sameParams(resolved.params, current)) return { hint: null }
    let hint: string | null = null
    if (validate && pane.symbol && pane.period) {
      // An unreachable or older server must not refuse what it could not check: the dialog's
      // rule, and the same answer as nobody checking.
      const check = await validate({
        indicatorName: row.name,
        calcParams: [...resolved.params],
        symbol: pane.symbol,
        period: pane.period
      }).catch(() => null)
      if (check && !check.ok) return { refused: check.reason || i18n('indicator_param_refused', locale) }
      hint = check?.hint ?? null
    }
    // The indicator may have left the pane while the check was out.
    const chartPaneId = pane.api?.indicatorPaneId(row.name, row.main)
    if (!pane.api || !chartPaneId) return { hint: null }
    pane.api.setIndicatorParams(chartPaneId, row.name, resolved.params)
    return { hint }
  }

  /** An input committed (Enter, leaving it, a spinner step): apply to its pane, or to every
   * pane holding the row for the All column, and put the input back to what it now shows. */
  async function commit(event: Event, row: IndicatorRow, index: number, column: PaneState | 'all'): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const value = typed(input)
    const key = inputKey(row, index, column)
    const seq = (sequence.get(key) ?? 0) + 1
    sequence.set(key, seq)
    const targets = column === 'all' ? panes.filter((pane) => liveParams(pane, row)) : [column]
    checking = setEntry(checking, key, validate ? true : undefined)
    const results = await Promise.all(targets.map((pane) => applyParam(pane, row, index, value)))
    if (sequence.get(key) !== seq) return
    checking = setEntry(checking, key, undefined)
    revision++
    const refused = results.flatMap((result, at) =>
      'refused' in result ? [`${paneTitle(targets[at])}: ${result.refused}`] : []
    )
    refusals = setEntry(refusals, key, refused.length > 0 ? refused : undefined)
    const hint = results.flatMap((result) => ('hint' in result && result.hint ? [result.hint] : []))[0]
    hints = setEntry(hints, key, hint)
    // What was refused stays in the input, beside its reason; otherwise the input shows what the
    // pane now holds -- which a cleared cell or a closed-up optional line may not have changed
    // enough for the template to rewrite it.
    if (refused.length === 0) {
      input.value =
        column === 'all'
          ? paramShared(row, index)
          : display(liveParams(column, row)?.[index])
    }
  }

  function paramShared(row: IndicatorRow, index: number): string {
    const shared = sharedParam(panes.map((pane) => liveParams(pane, row)), index)
    return shared === 'mixed' ? '' : display(shared)
  }

  function rowRefusals(row: IndicatorRow): string[] {
    const prefix = `${rowKey(row)}|`
    return Object.entries(refusals).flatMap(([key, reasons]) => (key.startsWith(prefix) ? reasons : []))
  }

  // -- An app's own settings (IndicatorSettingsModel) ---------------------------------------------
  // The fields of the app's own settings panel, one line each, a heading per group. Values are
  // written as the panel writes them -- a number settled to its bounds, a switch, a choice or a
  // colour as soon as it changes -- so there is nothing to refuse and no message to show.

  /** A pane's config for the row, or null where the pane does not hold it. Not reactive on the
   * app's side: `revision` is what re-reads it after a write from here. */
  function readConfig(pane: PaneState, row: IndicatorRow, model: IndicatorSettingsModel): object | null {
    void revision
    if (!pane.api?.indicatorPaneId(row.name, row.main)) return null
    return model.read(pane.id)
  }

  // Groups opened or closed by hand, by `${rowKey}/${group id}`. Unset, a top-level group is
  // open unless the fields fall into more than three -- the MTF overlay's eleven (its graph, then
  // a group per timeframe) would otherwise be some sixty lines in one row -- and a nested group
  // is open: it is reached by opening the one around it (the AREV lab's "arev21 settings" inside
  // "arev21"), and closed it would put every lever two clicks deep.
  let groupOpen = $state.raw<Record<string, boolean>>({})
  function isGroupOpen(row: IndicatorRow, id: string, fields: readonly IndicatorSettingField[]): boolean {
    const set = groupOpen[`${rowKey(row)}/${id}`]
    if (set !== undefined) return set
    return id.includes('.') || fields.filter((field) => field.kind === 'group').length <= 3
  }
  function toggleGroup(row: IndicatorRow, id: string, fields: readonly IndicatorSettingField[]): void {
    groupOpen = { ...groupOpen, [`${rowKey(row)}/${id}`]: !isGroupOpen(row, id, fields) }
  }

  /** Where one field is written to: its pane, or for the All column every pane it applies to. */
  function settingTargets(line: SettingLine, configs: ReadonlyArray<object | null>, column: PaneState | 'all'): PaneState[] {
    if (column !== 'all') return [column]
    return panes.filter((_, index) => lineApplies(line, configs[index]))
  }

  function writeSetting(
    model: IndicatorSettingsModel,
    line: SettingLine,
    configs: ReadonlyArray<object | null>,
    column: PaneState | 'all',
    value: unknown
  ): void {
    if (line.kind !== 'field') return
    for (const pane of settingTargets(line, configs, column)) model.write(pane.id, line.field.key, value)
    revision++
  }

  /** A number committed: settled to the field's bounds, written, and the input set to what the
   * pane now draws with. An emptied input goes back to what it held. */
  function commitSetting(
    event: Event,
    model: IndicatorSettingsModel,
    line: SettingLine,
    configs: ReadonlyArray<object | null>,
    column: PaneState | 'all',
    held: string
  ): void {
    if (line.kind !== 'field' || line.field.kind !== 'number') return
    const input = event.currentTarget as HTMLInputElement
    const typed = input.valueAsNumber
    if (!Number.isFinite(typed)) {
      input.value = held
      return
    }
    const settled = settleSetting(line.field, typed)
    writeSetting(model, line, configs, column, settled)
    input.value = String(settled)
  }

  // The app's own settings UI lives outside this dialog, which is modal and would keep it from
  // being used: close the dialog first, and open that UI on the next task, after the close has
  // restored focus to the manager's button -- otherwise the restore lands afterwards and takes
  // focus from whatever that UI put it on.
  function openOwnSettings(pane: PaneState, row: IndicatorRow): void {
    open = false
    setTimeout(() => openSettings(pane, row), 0)
  }

  // Moved by its header, so the charts behind it can be seen while ticking cells. The offset
  // outlives a close: reopened, the dialog comes back where it was put. A phone-sized shell
  // shows it full screen, where there is nowhere to move it to.
  let content = $state<HTMLElement | null>(null)
  let offset = $state<Offset>({ x: 0, y: 0 })
  // Null until the corner grip is dragged: the dialog then fits its table (app.css). Kept across a
  // close like the offset; a double-click on the grip goes back to fitting.
  let size = $state<Size | null>(null)
  const MIN_SIZE: Size = { width: 320, height: 240 }

  // The shell less the gutter a dialog keeps from its edges when it is not moved (app.css).
  const GUTTER = 16
  function boundsOf(element: HTMLElement): Box | null {
    const shell = element.closest<HTMLElement>('.klinecharts-pro-shell')
    if (!shell || shell.dataset.size === 'phone') return null
    const r = shell.getBoundingClientRect()
    return { left: r.left + GUTTER, top: r.top + GUTTER, right: r.right - GUTTER, bottom: r.bottom - GUTTER }
  }

  // One pointer gesture on a handle: `apply` gets the pointer's travel since pointerdown along
  // with where the dialog and the shell were when it began.
  function track(event: PointerEvent, apply: (delta: Offset, start: Box, bounds: Box, from: Offset) => void): void {
    if (event.button !== 0 || !content) return
    const bounds = boundsOf(content)
    if (!bounds) return
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    const start = content.getBoundingClientRect()
    const from = offset
    const x0 = event.clientX
    const y0 = event.clientY
    const move = (e: PointerEvent): void => apply({ x: e.clientX - x0, y: e.clientY - y0 }, start, bounds, from)
    const end = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  function startDrag(event: PointerEvent): void {
    track(event, (delta, start, bounds, from) => {
      offset = dragOffset(from, delta, start, bounds)
    })
  }

  function startResize(event: PointerEvent): void {
    track(event, (delta, start, bounds, from) => {
      const next = resizeBox(from, delta, start, bounds, MIN_SIZE)
      size = next.size
      offset = next.offset
    })
  }

  // Back to fitting the table. The top-left corner stays where it is, as it does during a resize:
  // measure the fitted box, then move the offset by half of the change in size.
  function fitToTable(): void {
    if (!content || !size) return
    const before = content.getBoundingClientRect()
    size = null
    const element = content
    requestAnimationFrame(() => {
      const after = element.getBoundingClientRect()
      const next = {
        x: offset.x + (after.width - before.width) / 2,
        y: offset.y + (after.height - before.height) / 2
      }
      const bounds = boundsOf(element)
      offset = bounds ? dragOffset(next, { x: 0, y: 0 }, shifted(after, next.x - offset.x, next.y - offset.y), bounds) : next
    })
  }

  function shifted(box: Box, dx: number, dy: number): Box {
    return { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy }
  }

  // Reopened into a shell that has since shrunk (or gone phone-sized), a remembered offset could
  // put the dialog partly outside it: pull it back in, once it is laid out.
  $effect(() => {
    if (!open || !content) return
    const element = content
    requestAnimationFrame(() => {
      const bounds = boundsOf(element)
      if (!bounds) {
        offset = { x: 0, y: 0 }
        return
      }
      const current = untrack(() => offset)
      offset = dragOffset(current, { x: 0, y: 0 }, element.getBoundingClientRect(), bounds)
    })
  })
</script>

<!-- An expanded row's lines: one per parameter the settings table describes, a pane's value
     under that pane's column and, under All, the value every pane holding it shares. An
     indicator whose settings the app shows in its own UI gets a way to that UI per pane
     instead, and one with no parameters says so. -->
{#snippet parameters(row: IndicatorRow)}
  {@const settings = indicatorSettingsFor(row.name)}
  {@const held = panes.map((pane) => liveParams(pane, row))}
  {@const columns = panes.length + 2}
  {@const model = settingsModel?.(row.name) ?? null}
  {#if model}
    {@render modelSettings(row, model)}
  {:else if settingsOwned?.(row.name)}
    <tr class="kc-matrix-param">
      <th scope="row" class="kc-matrix-name kc-matrix-param-name">{i18n('setting', locale)}</th>
      <td class="kc-matrix-all"></td>
      {#each panes as pane, index (pane.id)}
        <td class="kc-matrix-cell" data-active={pane.id === activeId || undefined}>
          {#if held[index]}
            <button
              type="button"
              class="kc-button kc-icon-button kc-matrix-gear"
              aria-label={`${labelFor(row)}: ${i18n('indicator_open_settings', locale)}, ${i18n('pane', locale)} ${index + 1}`}
              title={i18n('indicator_open_settings', locale)}
              onclick={() => openOwnSettings(pane, row)}
            >
              <SettingsIcon />
            </button>
          {/if}
        </td>
      {/each}
    </tr>
  {:else if settings.length === 0}
    <tr class="kc-matrix-param">
      <td colspan={columns} class="kc-matrix-note">
        <span class="kc-muted-text">{i18n('indicator_no_params', locale)}</span>
      </td>
    </tr>
  {:else}
    {#each settings as setting, param (param)}
      {@const label = i18n(setting.paramNameKey, locale)}
      {@const shared = sharedParam(held, param)}
      {@const allKey = inputKey(row, param, 'all')}
      <tr class="kc-matrix-param">
        <th scope="row" class="kc-matrix-name kc-matrix-param-name" title={label}>{label}</th>
        <td class="kc-matrix-all">
          <input
            class="kc-input kc-matrix-input"
            type="number"
            min={setting.min}
            max={setting.max}
            step={10 ** -setting.precision}
            aria-label={`${labelFor(row)} ${label}: ${i18n('all_panes', locale)}`}
            disabled={held.every((params) => params === null)}
            placeholder={shared === 'mixed' ? i18n('indicator_param_mixed', locale) : '–'}
            value={shared === 'mixed' ? '' : display(shared)}
            title={hints[allKey]}
            data-invalid={refusals[allKey] ? true : undefined}
            data-checking={checking[allKey] || undefined}
            onchange={(event) => commit(event, row, param, 'all')}
          />
        </td>
        {#each panes as pane, index (pane.id)}
          {@const key = inputKey(row, param, pane)}
          <td class="kc-matrix-cell" data-active={pane.id === activeId || undefined}>
            {#if held[index]}
              <input
                class="kc-input kc-matrix-input"
                type="number"
                min={setting.min}
                max={setting.max}
                step={10 ** -setting.precision}
                aria-label={`${labelFor(row)} ${label}: ${i18n('pane', locale)} ${index + 1}`}
                placeholder={setting.default === undefined ? '–' : String(setting.default)}
                value={display(held[index]?.[param])}
                title={hints[key]}
                data-invalid={refusals[key] ? true : undefined}
                data-checking={checking[key] || undefined}
                onchange={(event) => commit(event, row, param, pane)}
              />
            {/if}
          </td>
        {/each}
      </tr>
    {/each}
    {@const reasons = rowRefusals(row)}
    {#if reasons.length > 0}
      <tr class="kc-matrix-param">
        <td colspan={columns} class="kc-matrix-note">
          {#each reasons as reason (reason)}
            <p class="kc-field-error" role="alert">{reason}</p>
          {/each}
        </td>
      </tr>
    {/if}
  {/if}
{/snippet}

<!-- The lines of an app-owned indicator's settings (IndicatorSettingsModel): group headings that
     open and close, and a field per line with a control under each pane it applies to. -->
{#snippet modelSettings(row: IndicatorRow, model: IndicatorSettingsModel)}
  {@const configs = panes.map((pane) => readConfig(pane, row, model))}
  {#each settingLines(model.fields) as line, index (index)}
    {#if line.groups.every((id) => isGroupOpen(row, id, model.fields)) && configs.some((config) => lineApplies(line, config))}
      {#if line.kind === 'group'}
        {@const isOpen = isGroupOpen(row, line.id, model.fields)}
        <tr class="kc-matrix-param kc-matrix-group">
          <th scope="row" class="kc-matrix-name kc-matrix-param-name" style={`--kc-depth: ${line.depth}`}>
            <button
              type="button"
              class="kc-matrix-expand"
              aria-expanded={isOpen}
              onclick={() => toggleGroup(row, line.id, model.fields)}
            >
              <ChevronRightIcon />
              <span>{line.label}</span>
            </button>
          </th>
          <td colspan={panes.length + 1}></td>
        </tr>
      {:else}
        <tr class="kc-matrix-param">
          <th scope="row" class="kc-matrix-name kc-matrix-param-name" style={`--kc-depth: ${line.depth}`} title={line.field.label}>
            {line.field.label}
          </th>
          <td class="kc-matrix-all">
            {@render settingControl(row, model, line, configs, 'all')}
          </td>
          {#each panes as pane, index (pane.id)}
            <td class="kc-matrix-cell" data-active={pane.id === activeId || undefined}>
              {#if lineApplies(line, configs[index])}
                {@render settingControl(row, model, line, configs, pane)}
              {/if}
            </td>
          {/each}
        </tr>
      {/if}
    {/if}
  {/each}
{/snippet}

<!-- One field's control, for one pane or for All -- where it shows what the panes it applies to
     agree on, and marks where they differ. -->
{#snippet settingControl(
  row: IndicatorRow,
  model: IndicatorSettingsModel,
  line: SettingLine,
  configs: ReadonlyArray<object | null>,
  column: PaneState | 'all'
)}
  {#if line.kind === 'field'}
    {@const field = line.field}
    {@const shared =
      column === 'all'
        ? sharedSetting(configs.map((config) => (lineApplies(line, config) ? config : null)), field.key)
        : { value: valueAt(configs[panes.indexOf(column)], field.key) }}
    {@const mixed = shared === 'mixed'}
    {@const value = shared && shared !== 'mixed' ? shared.value : undefined}
    {@const where = column === 'all' ? i18n('all_panes', locale) : `${i18n('pane', locale)} ${panes.indexOf(column) + 1}`}
    {@const label = `${labelFor(row)} ${field.label}: ${where}`}
    {#if field.kind === 'number'}
      <input
        class="kc-input kc-matrix-input"
        type="number"
        min={field.min}
        max={field.max}
        step={field.step}
        aria-label={label}
        disabled={shared === null}
        placeholder={mixed ? i18n('indicator_param_mixed', locale) : ''}
        value={typeof value === 'number' ? String(value) : ''}
        onchange={(event) => commitSetting(event, model, line, configs, column, typeof value === 'number' ? String(value) : '')}
      />
    {:else if field.kind === 'switch'}
      <Checkbox.Root
        class="kc-checkbox"
        aria-label={label}
        disabled={shared === null}
        checked={value === true}
        indeterminate={mixed}
        onCheckedChange={(checked) => writeSetting(model, line, configs, column, checked === true)}
      >
        {#snippet children({ checked, indeterminate })}
          {#if indeterminate}<MinusIcon />{:else if checked}<CheckIcon />{/if}
        {/snippet}
      </Checkbox.Root>
    {:else if field.kind === 'select'}
      <select
        class="kc-select-trigger kc-matrix-select"
        aria-label={label}
        disabled={shared === null}
        value={mixed ? '' : String(value ?? '')}
        onchange={(event) => writeSetting(model, line, configs, column, event.currentTarget.value)}
      >
        {#if mixed}<option value="" disabled>{i18n('indicator_param_mixed', locale)}</option>{/if}
        {#each field.options as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    {:else if field.kind === 'color'}
      <input
        class="kc-matrix-color"
        type="color"
        aria-label={label}
        disabled={shared === null}
        title={mixed ? i18n('indicator_param_mixed', locale) : String(value ?? '')}
        data-mixed={mixed || undefined}
        value={typeof value === 'string' ? value : '#000000'}
        oninput={(event) => writeSetting(model, line, configs, column, event.currentTarget.value)}
      />
    {/if}
  {/if}
{/snippet}

<Dialog.Root bind:open>
  <Dialog.Portal {...portalProps}>
    <Dialog.Overlay class="kc-dialog-overlay" />
    <Dialog.Content
      class="kc-dialog-content kc-matrix-dialog"
      bind:ref={content}
      style={`--kc-drag-x: ${offset.x}px; --kc-drag-y: ${offset.y}px;${size ? ` --kc-size-w: ${size.width}px; --kc-size-h: ${size.height}px;` : ''}`}
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="kc-dialog-header kc-dialog-drag-handle" onpointerdown={startDrag}>
        <Dialog.Title>{i18n('indicator_manager', locale)}</Dialog.Title>
        <Dialog.Description>{i18n('indicator_manager_hint', locale)}</Dialog.Description>
      </div>
      <Dialog.Close class="kc-button kc-icon-button kc-dialog-close" aria-label="Close"><XIcon /></Dialog.Close>
      {#if rows.length === 0}
        <p class="kc-muted-text">{i18n('indicator_manager_empty', locale)}</p>
      {:else}
        <!-- A plain scroller rather than a ScrollArea: the dialog sizes itself to the table, and
             only a view too small for it scrolls, in whichever direction it does not fit. -->
        <div class="kc-matrix-scroll">
            <table class="kc-indicator-matrix">
              <thead>
                <tr>
                  <th scope="col" class="kc-matrix-name">{i18n('indicator', locale)}</th>
                  <th scope="col" class="kc-matrix-all">{i18n('all_panes', locale)}</th>
                  {#each panes as pane, index (pane.id)}
                    <th
                      scope="col"
                      class="kc-matrix-pane"
                      data-active={pane.id === activeId || undefined}
                      title={`${pane.symbol?.shortName ?? pane.symbol?.ticker ?? ''} ${pane.period?.text ?? ''}`}
                    >
                      <span class="kc-pane-tab-index">{index + 1}</span>
                      <span class="kc-matrix-pane-symbol">{pane.symbol?.shortName ?? pane.symbol?.ticker ?? ''}</span>
                      <span class="kc-pane-tab-period">{pane.period?.text ?? ''}</span>
                    </th>
                  {/each}
                </tr>
              </thead>
              {#each [true, false] as main (main)}
                {@const section = rows.filter((row) => row.main === main)}
                {#if section.length > 0}
                  <tbody>
                    <tr class="kc-matrix-section">
                      <th scope="colgroup" colspan={panes.length + 2}>
                        <span>{i18n(main ? 'main_indicator' : 'sub_indicator', locale)}</span>
                      </th>
                    </tr>
                    {#each section as row (rowKey(row))}
                      {@const state = coverage(panes, row)}
                      {@const isExpanded = expanded.has(rowKey(row))}
                      <tr data-expanded={isExpanded || undefined}>
                        <th scope="row" class="kc-matrix-name" title={row.name}>
                          <button
                            type="button"
                            class="kc-matrix-expand"
                            aria-expanded={isExpanded}
                            onclick={() => toggle(row)}
                          >
                            <ChevronRightIcon />
                            <span>{labelFor(row)}</span>
                          </button>
                        </th>
                        <td class="kc-matrix-all">
                          <Checkbox.Root
                            class="kc-checkbox"
                            aria-label={`${labelFor(row)}: ${i18n('all_panes', locale)}`}
                            checked={state === 'all'}
                            indeterminate={state === 'some'}
                            onCheckedChange={() => setRow(row, state !== 'all')}
                          >
                            {#snippet children({ checked, indeterminate })}
                              {#if indeterminate}<MinusIcon />{:else if checked}<CheckIcon />{/if}
                            {/snippet}
                          </Checkbox.Root>
                        </td>
                        {#each panes as pane, index (pane.id)}
                          <td class="kc-matrix-cell" data-active={pane.id === activeId || undefined}>
                            <Checkbox.Root
                              class="kc-checkbox"
                              aria-label={`${labelFor(row)}: ${i18n('pane', locale)} ${index + 1}`}
                              disabled={pane.api === null}
                              checked={holds(pane, row)}
                              onCheckedChange={(checked) => set(pane, row, checked === true)}
                            >
                              {#snippet children({ checked })}{#if checked}<CheckIcon />{/if}{/snippet}
                            </Checkbox.Root>
                          </td>
                        {/each}
                      </tr>
                      {#if isExpanded}
                        {@render parameters(row)}
                      {/if}
                    {/each}
                  </tbody>
                {/if}
              {/each}
            </table>
        </div>
      {/if}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="kc-dialog-resize-grip"
        title={i18n('indicator_manager_resize', locale)}
        onpointerdown={startResize}
        ondblclick={fitToTable}
      ></div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
