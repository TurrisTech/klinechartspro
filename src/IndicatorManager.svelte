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
</script>

<Dialog.Root bind:open>
  <Dialog.Portal {...portalProps}>
    <Dialog.Overlay class="kc-dialog-overlay" />
    <Dialog.Content class="kc-dialog-content kc-matrix-dialog">
      <div class="kc-dialog-header">
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
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
