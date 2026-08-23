// A declarative settings field schema and a plain-DOM renderer for it — deliberately the
// same shape as the library's own src/config/settings.ts (dotted `key` path + a component
// kind), so a layer's settings read like the chart's own settings dialog, but built without
// Svelte: client/ is plain imperative DOM throughout (see client/login.ts), and the
// bits-ui Popover/Portal chain that backs the library's dialogs is the exact thing that
// went dark under the dev server in d382ce5 — pulling that chain into client/ would risk
// the same failure mode for a feature with no test coverage to catch it.

export type SettingsField =
  | { kind: 'group'; label: string; fields: SettingsField[] }
  | { kind: 'select'; key: string; label: string; options: { value: string; label: string }[] }
  | { kind: 'number'; key: string; label: string; min: number; max: number; step: number }
  | { kind: 'switch'; key: string; label: string }
  | { kind: 'color'; key: string; label: string }

// Both assume `source`/`target` are a complete, already-valid config (every intermediate
// container the path walks through already exists) — every caller here builds a field's
// `key` against a full defaults object, so there is nothing to auto-vivify. A numeric path
// segment (e.g. 'emphasis.age.domain.1') indexes into an array the same way it indexes into
// an object property, which is what lets a field reach one element of a [min, max] tuple.
function getByPath(source: object, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc === null || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[key]
  }, source)
}

function setByPath(target: object, path: string, value: unknown): void {
  const keys = path.split('.')
  let current = target as Record<string, unknown>
  for (const key of keys.slice(0, -1)) {
    current = current[key] as Record<string, unknown>
  }
  current[keys.at(-1) as string] = value
}

export interface SettingsPanelHandle {
  close(): void
}

export interface SettingsPanelOptions<T extends object> {
  anchor: HTMLElement
  title: string
  /** Whether the layer itself is on — rendered as the panel's first row, ahead of `fields`.
   * Kept separate from `config`/`onChange` rather than folded into T: every layer has this
   * regardless of what it configures, so it's a framework-level concern, not a per-layer one.
   *
   * OPTIONAL as a pair: omit `onToggleEnabled` and the row is not rendered at all. Not every
   * caller has an on/off of its own — an indicator's is being on the pane, which is the
   * picker's and the legend's business, not this panel's — and a switch that ignores clicks
   * is worse than no switch. */
  enabled?: boolean
  onToggleEnabled?: (enabled: boolean) => void
  fields: SettingsField[]
  config: T
  defaults: T
  onChange: (next: T) => void
  /** Fires however the panel closes — outside click, Esc, or the caller's own `close()` —
   * so a caller tracking "is my panel open" (to make a second button-click toggle it
   * instead of stacking a duplicate) doesn't hold a stale handle. */
  onClose?: () => void
  /** Where to hang the panel, in viewport coordinates. Defaults to `anchor`'s own rect,
   * which is right when the anchor IS the control that was clicked — a toolbar button.
   * It is wrong when the anchor is merely the element the panel must live INSIDE: a chart
   * container is the full height of the pane, so hanging the panel under its bottom edge
   * puts it below the fold. A caller whose control is drawn on a canvas, and so has no
   * element of its own to point at, passes the rect it wants instead. */
  anchorRect?: { top: number; bottom: number; left: number }
}

// Opens a `.kc-popover`-styled panel anchored under `anchor`, positioned with `position:
// fixed` off the anchor's own viewport rect so it escapes `.klinecharts-pro`'s
// `overflow: hidden` (the same reason the library's own Popover/Dialog portal their content
// rather than nesting it in place). Appended into `anchor.closest('.klinecharts-pro')` — the
// element `KLineChartPro.ts` puts the `dark` class on — so the panel still resolves the
// chart's own theme tokens (`--popover`, `--border`, …) despite living outside normal flow.
export function openSettingsPanel<T extends object>(
  options: SettingsPanelOptions<T>
): SettingsPanelHandle {
  const { anchor, title, fields, defaults, onChange, onClose, onToggleEnabled } = options
  let config = structuredClone(options.config)
  let enabled = options.enabled ?? true

  const panel = document.createElement('div')
  panel.className = 'kc-popover wd-layer-panel'
  panel.setAttribute('role', 'dialog')
  panel.setAttribute('aria-label', title)

  const header = document.createElement('div')
  header.className = 'kc-popover-header'
  header.textContent = title
  panel.appendChild(header)

  const body = document.createElement('div')
  body.className = 'kc-field-group wd-layer-panel-body'
  panel.appendChild(body)

  function commit(next: T): void {
    config = next
    onChange(structuredClone(config))
  }

  // Shared by the "Enabled" row and every `kind: 'switch'` field — a `data-state`-driven
  // button matching the library's own `.kc-switch` (src/app.css), so a hand-rolled control
  // here still reads as native.
  function createSwitch(id: string, getChecked: () => boolean, onToggle: (next: boolean) => void): HTMLButtonElement {
    const button = document.createElement('button')
    button.type = 'button'
    button.id = id
    button.className = 'kc-switch'
    button.setAttribute('role', 'switch')
    button.appendChild(Object.assign(document.createElement('span'), { className: 'kc-switch-thumb' }))
    const sync = (): void => {
      const checked = getChecked()
      button.dataset.state = checked ? 'checked' : 'unchecked'
      button.setAttribute('aria-checked', String(checked))
    }
    sync()
    button.addEventListener('click', () => {
      onToggle(!getChecked())
      sync()
    })
    return button
  }

  function renderField(field: SettingsField): HTMLElement {
    if (field.kind === 'group') {
      const fieldset = document.createElement('fieldset')
      fieldset.className = 'kc-fieldset'
      const legend = document.createElement('legend')
      legend.textContent = field.label
      fieldset.appendChild(legend)
      const groupBody = document.createElement('div')
      groupBody.className = 'kc-field-group'
      for (const child of field.fields) groupBody.appendChild(renderField(child))
      fieldset.appendChild(groupBody)
      return fieldset
    }

    const row = document.createElement('div')
    row.className = 'kc-field kc-field-horizontal'
    const label = document.createElement('label')
    const id = `wd-field-${field.key.replace(/\./g, '-')}`
    label.htmlFor = id
    label.textContent = field.label
    row.appendChild(label)
    row.appendChild(renderControl(field, id))
    return row
  }

  function renderControl(
    field: Exclude<SettingsField, { kind: 'group' }>,
    id: string
  ): HTMLElement {
    if (field.kind === 'switch') {
      return createSwitch(
        id,
        () => Boolean(getByPath(config, field.key)),
        (next) => {
          const nextConfig = structuredClone(config)
          setByPath(nextConfig, field.key, next)
          commit(nextConfig)
        }
      )
    }

    if (field.kind === 'select') {
      const select = document.createElement('select')
      select.id = id
      select.className = 'kc-select-trigger kc-setting-select'
      for (const option of field.options) {
        const opt = document.createElement('option')
        opt.value = option.value
        opt.textContent = option.label
        select.appendChild(opt)
      }
      select.value = String(getByPath(config, field.key))
      select.addEventListener('change', () => {
        const next = structuredClone(config)
        setByPath(next, field.key, select.value)
        commit(next)
      })
      return select
    }

    if (field.kind === 'color') {
      const input = document.createElement('input')
      input.id = id
      input.type = 'color'
      input.className = 'wd-color-input'
      input.value = String(getByPath(config, field.key))
      input.addEventListener('input', () => {
        const next = structuredClone(config)
        setByPath(next, field.key, input.value)
        commit(next)
      })
      return input
    }

    // 'number'
    const input = document.createElement('input')
    input.id = id
    input.type = 'number'
    input.className = 'kc-input'
    input.min = String(field.min)
    input.max = String(field.max)
    input.step = String(field.step)
    input.value = String(getByPath(config, field.key))
    input.addEventListener('input', () => {
      if (input.value === '') return
      const next = structuredClone(config)
      setByPath(next, field.key, Number(input.value))
      commit(next)
    })
    return input
  }

  // The enable/disable switch is the panel's first row, ahead of anything layer-specific —
  // rendered once here (not by refresh()) since it isn't part of `fields`/`config` and Reset
  // to defaults must not touch it. Skipped entirely for a caller that has no such toggle.
  if (onToggleEnabled) {
    const enabledRow = document.createElement('div')
    enabledRow.className = 'kc-field kc-field-horizontal'
    const enabledId = 'wd-field-enabled'
    const enabledLabel = document.createElement('label')
    enabledLabel.htmlFor = enabledId
    enabledLabel.textContent = 'Enabled'
    enabledRow.appendChild(enabledLabel)
    enabledRow.appendChild(
      createSwitch(
        enabledId,
        () => enabled,
        (next) => {
          enabled = next
          onToggleEnabled(next)
        }
      )
    )
    body.appendChild(enabledRow)
  }

  const fieldsBody = document.createElement('div')
  fieldsBody.className = 'kc-field-group'
  body.appendChild(fieldsBody)

  function refresh(): void {
    fieldsBody.innerHTML = ''
    for (const field of fields) fieldsBody.appendChild(renderField(field))
  }
  refresh()

  const footer = document.createElement('div')
  footer.className = 'kc-dialog-footer wd-layer-panel-footer'
  const resetButton = document.createElement('button')
  resetButton.type = 'button'
  resetButton.className = 'kc-button kc-button-outline'
  resetButton.textContent = 'Reset to defaults'
  resetButton.addEventListener('click', () => {
    commit(structuredClone(defaults))
    refresh()
  })
  footer.appendChild(resetButton)
  panel.appendChild(footer)

  const mountPoint = anchor.closest('.klinecharts-pro') ?? document.body
  mountPoint.appendChild(panel)

  const anchorRect = options.anchorRect ?? anchor.getBoundingClientRect()
  const gap = 6
  panel.style.position = 'fixed'
  const maxLeft = window.innerWidth - panel.offsetWidth - 8
  panel.style.left = `${Math.max(8, Math.min(anchorRect.left, maxLeft))}px`
  // Below the anchor by preference, but never off the bottom of the window: the panel's
  // height depends on how many fields the layer declares, and a tall one hung off a low
  // anchor would otherwise render partly or entirely out of view with nothing to say so.
  // Measured after the append above, so offsetHeight is the laid-out height (capped by the
  // stylesheet's own max-height) rather than zero.
  const maxTop = window.innerHeight - panel.offsetHeight - 8
  panel.style.top = `${Math.max(8, Math.min(anchorRect.bottom + gap, maxTop))}px`

  function onOutsideClick(event: MouseEvent): void {
    if (!panel.contains(event.target as Node) && event.target !== anchor) close()
  }
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
  }
  // Deferred a whole TASK, not a microtask, so the interaction that opened the panel cannot
  // also close it. A microtask checkpoint runs BETWEEN listener callbacks during dispatch,
  // so a listener added from one can still receive the very event that is propagating; a
  // task cannot run until dispatch has finished. The guard above (target is the anchor, or
  // inside the panel) covers the toolbar-button case either way, but it does not cover a
  // caller whose control is drawn on a canvas and so has no element of its own to exempt.
  setTimeout(() => document.addEventListener('mousedown', onOutsideClick), 0)
  document.addEventListener('keydown', onKeydown)

  let closed = false
  function close(): void {
    if (closed) return
    closed = true
    document.removeEventListener('mousedown', onOutsideClick)
    document.removeEventListener('keydown', onKeydown)
    panel.remove()
    onClose?.()
  }

  return { close }
}
