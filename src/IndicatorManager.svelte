<script lang="ts">
  import CheckIcon from '@lucide/svelte/icons/check'
  import MinusIcon from '@lucide/svelte/icons/minus'
  import XIcon from '@lucide/svelte/icons/x'
  import { Checkbox, Dialog } from 'bits-ui'
  import { untrack } from 'svelte'

  import i18n from './i18n'
  import type { PaneState } from './state/wall.svelte'
  import {
    coverage,
    holds,
    type IndicatorRow,
    rowKey,
    usedIndicators
  } from './state/indicatorMatrix'
  import { type Box, dragOffset, type Offset, resizeBox, type Size } from './utils/drag'

  // Every indicator in use on the wall against every visible pane: a cell is "this indicator on
  // this pane", and ticking it adds or removes it through the pane's own changeIndicator -- the
  // same call the picker makes for the active pane -- so params, persistence and sub-pane
  // bookkeeping stay ChartPane's business.
  let {
    open = $bindable(),
    panes,
    activeId,
    locale,
    portalProps,
    labelFor
  }: {
    open: boolean
    panes: PaneState[]
    activeId: string
    locale: string
    portalProps: { to: HTMLElement } | undefined
    labelFor: (row: IndicatorRow) => string
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
                      <tr>
                        <th scope="row" class="kc-matrix-name" title={row.name}>{labelFor(row)}</th>
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
