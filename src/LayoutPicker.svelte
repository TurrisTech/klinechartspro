<script lang="ts">
  import LayoutGridIcon from '@lucide/svelte/icons/layout-grid'
  import { Popover, Tooltip } from 'bits-ui'

  import i18n from './i18n'
  import type { Wall } from './state/wall.svelte'

  let { wall, locale, portalProps }: {
    wall: Wall
    locale: string
    portalProps: { to: HTMLElement } | undefined
  } = $props()

  // Each preset's mini-preview is built from the exact same `rows` its real grid renders
  // with (src/config/layouts.ts) -- there is no second source of truth to drift out of sync.
  function previewStyle(rows: readonly string[]): string {
    const columns = rows[0].trim().split(/\s+/).length
    return `grid-template-areas: ${rows.map((row) => `"${row}"`).join(' ')};` +
      `grid-template-columns: repeat(${columns}, 1fr);` +
      `grid-template-rows: repeat(${rows.length}, 1fr);`
  }

  function previewCells(rows: readonly string[]): string[] {
    const seen = new Set<string>()
    for (const row of rows) {
      for (const token of row.trim().split(/\s+/)) seen.add(token)
    }
    return [...seen]
  }
</script>

<Popover.Root>
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Popover.Trigger {...props} class="kc-button kc-icon-button" aria-label={i18n('layout', locale)}>
          <LayoutGridIcon />
        </Popover.Trigger>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Portal {...portalProps}>
      <Tooltip.Content class="kc-tooltip">{i18n('layout', locale)}</Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
  <Popover.Portal {...portalProps}>
    <Popover.Content align="end" sideOffset={4} class="kc-popover kc-layout-popover">
      <div class="kc-popover-header">{i18n('layout', locale)}</div>
      <div class="kc-layout-grid">
        {#each wall.layouts as preset (preset.id)}
          <Popover.Close
            class="kc-layout-option"
            aria-checked={preset.id === wall.layoutId}
            aria-label={i18n(`layout_${preset.id}`, locale)}
            onclick={() => wall.setLayout(preset.id)}
          >
            <div class="kc-layout-preview" style={previewStyle(preset.rows)}>
              {#each previewCells(preset.rows) as cell (cell)}
                <span class="kc-layout-cell" style={`grid-area: ${cell};`}></span>
              {/each}
            </div>
          </Popover.Close>
        {/each}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
