<script lang="ts">
  import Link2Icon from '@lucide/svelte/icons/link-2'
  import { Popover, Switch, Tooltip } from 'bits-ui'

  import i18n from './i18n'

  let {
    crosshair = $bindable(),
    time = $bindable(),
    locale,
    portalProps
  }: {
    crosshair: boolean
    time: boolean
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
          class={`kc-button kc-icon-button${crosshair || time ? ' is-active' : ''}`}
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
          <Switch.Root class="kc-switch" id="sync-time" checked={time} onCheckedChange={(checked) => { time = checked }}>
            <Switch.Thumb class="kc-switch-thumb" />
          </Switch.Root>
        </div>
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
