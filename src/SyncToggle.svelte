<script lang="ts">
  import Link2Icon from '@lucide/svelte/icons/link-2'
  import { Popover, Switch, Tooltip } from 'bits-ui'

  import i18n from './i18n'

  let {
    crosshair = $bindable(),
    time = $bindable(),
    auto,
    locale,
    portalProps
  }: {
    crosshair: boolean
    time: boolean
    // Read-only here: auto sync is its own toolbar button (ChartPro.svelte), not a switch in
    // this popover. It appears at all so this popover can say WHY click-to-scroll is inert
    // while auto sync owns the time axis, instead of offering a switch that does nothing.
    auto: boolean
    locale: string
    portalProps: { to: HTMLElement } | undefined
  } = $props()
</script>

<Popover.Root>
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <Popover.Trigger
          {...props}
          class={`kc-button kc-icon-button${crosshair || (time && !auto) ? ' is-active' : ''}`}
          aria-label={i18n('sync', locale)}
        >
          <Link2Icon />
        </Popover.Trigger>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Portal {...portalProps}>
      <Tooltip.Content class="kc-tooltip">{i18n('sync', locale)}</Tooltip.Content>
    </Tooltip.Portal>
  </Tooltip.Root>
  <Popover.Portal {...portalProps}>
    <Popover.Content align="end" sideOffset={4} class="kc-popover kc-sync-popover">
      <div class="kc-popover-header">{i18n('sync', locale)}</div>
      <div class="kc-field-group">
        <div class="kc-field kc-field-horizontal">
          <label for="sync-crosshair">{i18n('sync_crosshair', locale)}</label>
          <Switch.Root class="kc-switch" id="sync-crosshair" checked={crosshair} onCheckedChange={(checked) => { crosshair = checked }}>
            <Switch.Thumb class="kc-switch-thumb" />
          </Switch.Root>
        </div>
        <div class="kc-field kc-field-horizontal">
          <label for="sync-time">{i18n('sync_time', locale)}</label>
          <Switch.Root class="kc-switch" id="sync-time" disabled={auto} checked={time && !auto} onCheckedChange={(checked) => { time = checked }}>
            <Switch.Thumb class="kc-switch-thumb" />
          </Switch.Root>
        </div>
        {#if auto}
          <p class="kc-field-hint">{i18n('sync_time_auto_hint', locale)}</p>
        {/if}
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
