import { describeLayout } from '../layout'
import { MAX_WORKSPACES, type Workspace, type WorkspaceStore } from './store'

// The toolbar switcher: which workspace this device is on, and everything you can do to the
// set (switch, rename, duplicate, delete, add). Plain imperative DOM, positioned and
// dismissed exactly like client/chartlayers/settings.ts's panel -- `position: fixed` off the
// anchor's viewport rect so it escapes `.klinecharts-pro`'s `overflow: hidden`, appended
// inside `.klinecharts-pro` so it still resolves the chart's theme tokens. See that file's
// header for why client/ builds its popovers by hand instead of reaching for the library's
// bits-ui chain.

const SVG_NS = 'http://www.w3.org/2000/svg'

function icon(paths: string[], filled = false): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', filled ? '2.5' : '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
  }
  return svg
}

const ICONS = {
  grid: () =>
    icon([
      'M3 3h7v7H3z',
      'M14 3h7v7h-7z',
      'M14 14h7v7h-7z',
      'M3 14h7v7H3z'
    ]),
  chevron: () => icon(['m6 9 6 6 6-6']),
  check: () => icon(['M20 6 9 17l-5-5'], true),
  pencil: () => icon(['M12 20h9', 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z']),
  copy: () => icon(['M9 9h11a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1']),
  trash: () => icon(['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2']),
  plus: () => icon(['M12 5v14', 'M5 12h14'])
}

// Coarse on purpose: the question a row answers is "did I touch this on the other machine
// today", not "when exactly".
function ago(timestamp: number): string {
  if (!timestamp) return ''
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000))
  if (seconds < 90) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return days < 30 ? `${days}d ago` : new Date(timestamp).toLocaleDateString()
}

export interface WorkspaceSwitcher {
  /** The toolbar button. Hand it to attachToSlot(chartPro, 'toolbar', …) on every mount --
   * the same element is re-attached to each freshly built chart rather than rebuilt. */
  element: HTMLElement
  /** Re-reads the store: after a switch, or after anything else edits the set. */
  refresh(): void
  close(): void
}

export interface WorkspaceSwitcherOptions {
  store: WorkspaceStore
  /** Non-null while the wall on screen is NOT a workspace -- today only a `?symbol=` deep
   * link, which opens one instrument and deliberately saves nothing. The button says so, and
   * picking any workspace from the menu leaves that mode. Read on every refresh, not captured
   * once, because leaving the mode is exactly what switching does. */
  transientLabel?: () => string | null
  /** Remount the chart on the given workspace. Called only when the id actually changes. */
  onSwitch: (id: string) => void
}

export function createWorkspaceSwitcher(options: WorkspaceSwitcherOptions): WorkspaceSwitcher {
  const { store, onSwitch } = options
  const transientLabel = options.transientLabel ?? (() => null)

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'kc-button wd-ws-button'
  button.setAttribute('aria-haspopup', 'menu')
  button.setAttribute('aria-expanded', 'false')

  const buttonLabel = document.createElement('span')
  buttonLabel.className = 'kc-truncate'
  button.append(ICONS.grid(), buttonLabel, ICONS.chevron())

  let panel: HTMLElement | null = null
  // The row currently showing an inline editor or a delete confirmation, so re-rendering the
  // list doesn't blow it away and reopening the menu doesn't restore it.
  let editing: string | null = null
  let confirming: string | null = null

  const syncButton = (): void => {
    const active = store.active()
    const transient = transientLabel()
    buttonLabel.textContent = transient ?? active.name
    button.title = transient
      ? `${transient} — a deep link, not saved to a workspace`
      : `Workspace: ${active.name}`
    button.classList.toggle('is-transient', Boolean(transient))
  }

  const switchTo = (id: string): void => {
    close()
    // Re-picking the workspace already on screen is a no-op -- except out of the deep-link
    // scratch wall, where it is how you get back to the saved one.
    if (!transientLabel() && id === store.getActiveId()) return
    onSwitch(id)
  }

  function renderRow(workspace: Workspace): HTMLElement {
    const row = document.createElement('div')
    row.className = 'wd-ws-row'
    const isActive = !transientLabel() && workspace.id === store.getActiveId()
    if (isActive) row.classList.add('is-active')

    if (confirming === workspace.id) {
      const question = document.createElement('span')
      question.className = 'wd-ws-confirm-text'
      question.textContent = `Delete “${workspace.name}”?`
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'kc-button kc-button-outline wd-ws-confirm-button'
      cancel.textContent = 'Cancel'
      cancel.addEventListener('click', () => {
        confirming = null
        renderList()
      })
      const confirm = document.createElement('button')
      confirm.type = 'button'
      confirm.className = 'kc-button wd-ws-confirm-button is-danger'
      confirm.textContent = 'Delete'
      confirm.addEventListener('click', () => {
        const wasActive = workspace.id === store.getActiveId()
        const nowActive = store.remove(workspace.id)
        confirming = null
        // Deleting the wall you are looking at has to put you on another one; deleting any
        // other leaves the chart exactly where it was.
        if (wasActive && nowActive !== workspace.id) switchTo(nowActive)
        else {
          renderList()
          syncButton()
        }
      })
      row.append(question, cancel, confirm)
      return row
    }

    const pick = document.createElement('button')
    pick.type = 'button'
    pick.className = 'wd-ws-pick'
    const mark = document.createElement('span')
    mark.className = 'wd-ws-mark'
    if (isActive) mark.appendChild(ICONS.check())
    const text = document.createElement('span')
    text.className = 'wd-ws-text'

    if (editing === workspace.id) {
      const input = document.createElement('input')
      input.className = 'kc-input wd-ws-rename'
      input.value = workspace.name
      input.maxLength = 40
      const commit = (save: boolean): void => {
        if (editing !== workspace.id) return
        editing = null
        if (save) store.rename(workspace.id, input.value)
        renderList()
        syncButton()
      }
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') commit(true)
        else if (event.key === 'Escape') {
          // Stops the panel's own Escape handler from closing the whole menu -- the first
          // Escape cancels the rename, a second closes the menu.
          event.stopPropagation()
          commit(false)
        }
      })
      input.addEventListener('blur', () => commit(true))
      text.appendChild(input)
      row.append(mark, text)
      queueMicrotask(() => {
        input.focus()
        input.select()
      })
      return row
    }

    const name = document.createElement('span')
    name.className = 'wd-ws-name kc-truncate'
    name.textContent = workspace.name
    const meta = document.createElement('span')
    meta.className = 'wd-ws-meta kc-truncate'
    const when = ago(workspace.updatedAt)
    meta.textContent = when
      ? `${describeLayout(workspace.layout)} · ${when}`
      : describeLayout(workspace.layout)
    text.append(name, meta)
    pick.append(mark, text)
    pick.addEventListener('click', () => switchTo(workspace.id))

    const actions = document.createElement('span')
    actions.className = 'wd-ws-actions'
    const action = (
      label: string,
      glyph: SVGSVGElement,
      handler: () => void,
      disabled = false
    ): HTMLButtonElement => {
      const element = document.createElement('button')
      element.type = 'button'
      element.className = 'wd-ws-action'
      element.title = label
      element.setAttribute('aria-label', `${label} ${workspace.name}`)
      element.disabled = disabled
      element.appendChild(glyph)
      element.addEventListener('click', handler)
      return element
    }
    actions.append(
      action('Rename', ICONS.pencil(), () => {
        editing = workspace.id
        renderList()
      }),
      action(
        'Duplicate',
        ICONS.copy(),
        () => {
          store.duplicate(workspace.id)
          renderList()
        },
        !store.canCreate()
      ),
      action(
        'Delete',
        ICONS.trash(),
        () => {
          confirming = workspace.id
          renderList()
        },
        store.list().length <= 1
      )
    )

    row.append(pick, actions)
    return row
  }

  let list: HTMLElement | null = null
  let footer: HTMLElement | null = null

  function renderList(): void {
    if (!list || !footer) return
    list.innerHTML = ''
    for (const workspace of store.list()) list.appendChild(renderRow(workspace))
    footer.innerHTML = ''
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'kc-button kc-button-outline wd-ws-add'
    add.append(ICONS.plus(), document.createTextNode('New workspace'))
    add.disabled = !store.canCreate()
    add.title = store.canCreate() ? '' : `A user keeps at most ${MAX_WORKSPACES} workspaces`
    add.addEventListener('click', () => {
      const created = store.create('Workspace')
      if (created) switchTo(created.id)
    })
    footer.appendChild(add)
  }

  function onOutsideClick(event: MouseEvent): void {
    if (!panel) return
    const target = event.target as Node
    if (!panel.contains(target) && !button.contains(target)) close()
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') close()
  }

  function close(): void {
    if (!panel) return
    document.removeEventListener('mousedown', onOutsideClick)
    document.removeEventListener('keydown', onKeydown)
    panel.remove()
    panel = null
    list = null
    footer = null
    editing = null
    confirming = null
    button.setAttribute('aria-expanded', 'false')
  }

  function open(): void {
    panel = document.createElement('div')
    panel.className = 'kc-popover wd-ws-panel'
    panel.setAttribute('role', 'menu')
    panel.setAttribute('aria-label', 'Workspaces')

    const header = document.createElement('div')
    header.className = 'kc-popover-header'
    header.textContent = 'Workspaces'
    list = document.createElement('div')
    list.className = 'wd-ws-list'
    footer = document.createElement('div')
    footer.className = 'wd-ws-footer'
    panel.append(header, list, footer)
    renderList()

    const mountPoint = button.closest('.klinecharts-pro') ?? document.body
    mountPoint.appendChild(panel)

    const rect = button.getBoundingClientRect()
    panel.style.position = 'fixed'
    panel.style.top = `${rect.bottom + 6}px`
    const maxLeft = window.innerWidth - panel.offsetWidth - 8
    panel.style.left = `${Math.max(8, Math.min(rect.left, maxLeft))}px`

    // Deferred one microtask so the click that opened the panel doesn't immediately close it.
    queueMicrotask(() => document.addEventListener('mousedown', onOutsideClick))
    document.addEventListener('keydown', onKeydown)
    button.setAttribute('aria-expanded', 'true')
  }

  button.addEventListener('click', () => {
    if (panel) close()
    else open()
  })

  syncButton()

  return {
    element: button,
    refresh(): void {
      syncButton()
      renderList()
    },
    close
  }
}
