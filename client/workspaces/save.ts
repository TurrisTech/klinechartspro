import { anchoredPopover } from '../chrome/popover'
import { icon } from './menu'
import type { WorkspaceStore } from './store'

// Save and Revert, beside the workspace switcher. A wall is not written as it changes: every
// change is a draft in the store (see store.ts's header), and this is where the user commits
// it or throws it away. Plain imperative DOM, and the confirm is an anchored popover like the
// switcher's panel (menu.ts; client/chrome/popover.ts).
//
// Save has three looks, because a draft can differ from what is saved in two ways:
//   - disabled         nothing differs, nothing to write;
//   - plain            only where the panes are looking (a pan, a zoom, the active pane), which
//                      Save still writes but nobody would call unsaved work;
//   - highlighted      a setting changed (store.isDirty) -- the one that also marks the
//                      switcher's row and holds a closing page.
// Revert is enabled whenever there is a draft, and confirms first: it rebuilds the wall, and
// what it throws away cannot be had back.

const ICONS = {
  save: () =>
    icon([
      'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z',
      'M17 21v-8H7v8',
      'M7 3v5h8'
    ]),
  saved: () => icon(['M20 6 9 17l-5-5'], true),
  revert: () => icon(['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'])
}

// How long the button reads "Saved" after a save -- long enough to be seen, short enough that
// the next change finds it saying "Save" again.
const SAVED_FLASH_MS = 1500

export interface WorkspaceSaveControls {
  /** The Save and Revert pair. Hand it to attachToSlot(chartPro, 'toolbar', …) on every
   * mount, after the switcher -- like the switcher's button, it outlives the wall. */
  element: HTMLElement
  /** Re-reads the store. Also bound to store.onChange, so it rarely needs calling by hand. */
  refresh(): void
  /** Closes the Revert confirmation, if open. */
  close(): void
}

interface WorkspaceSaveControlsOptions {
  store: WorkspaceStore
  /** True while the wall on screen belongs to no workspace -- the `?symbol=` scratch wall,
   * which saves nothing -- and the controls are hidden. Read on every refresh. */
  transient: () => boolean
  /** Rebuild the wall from what is saved. Called after the store has dropped the draft. */
  onRevert: () => void
}

function labelled(className: string, glyph: SVGSVGElement, text: string): {
  button: HTMLButtonElement
  setContent(glyph: SVGSVGElement, text: string): void
} {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = `kc-button ${className}`
  const setContent = (next: SVGSVGElement, value: string): void => {
    const label = document.createElement('span')
    label.className = 'wd-ws-save-label'
    label.textContent = value
    button.replaceChildren(next, label)
  }
  setContent(glyph, text)
  return { button, setContent }
}

export function createWorkspaceSaveControls(options: WorkspaceSaveControlsOptions): WorkspaceSaveControls {
  const { store, transient, onRevert } = options

  const element = document.createElement('span')
  element.className = 'wd-ws-save'

  const save = labelled('wd-ws-save-button', ICONS.save(), 'Save')
  const revert = labelled('wd-ws-revert-button', ICONS.revert(), 'Revert')
  element.append(save.button, revert.button)

  let flashTimer: ReturnType<typeof setTimeout> | null = null

  function refresh(): void {
    element.classList.toggle('is-hidden', transient())
    const name = store.active().name
    const draft = store.hasDraft()
    const dirty = store.isDirty()
    // A save that just happened keeps its "Saved" until the flash ends -- unless a new change
    // arrives first, which is a draft again and has to say so at once.
    if (draft && flashTimer) {
      clearTimeout(flashTimer)
      flashTimer = null
      save.button.classList.remove('is-saved')
      save.setContent(ICONS.save(), 'Save')
    }
    save.button.disabled = !draft
    save.button.classList.toggle('is-dirty', dirty)
    save.button.title = dirty
      ? `Save the changes to “${name}”`
      : draft
        ? `Save where the panes of “${name}” are looking`
        : `“${name}” is saved`
    save.button.setAttribute('aria-label', save.button.title)
    revert.button.disabled = !draft
    revert.button.title = draft ? `Discard the unsaved changes to “${name}”` : `“${name}” is saved`
    revert.button.setAttribute('aria-label', revert.button.title)
    if (!draft) close()
  }

  save.button.addEventListener('click', () => {
    close()
    if (!store.saveActive()) return
    // saveActive notified, so refresh() has already run and disabled the button; the flash
    // is drawn over that.
    save.setContent(ICONS.saved(), 'Saved')
    save.button.classList.add('is-saved')
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => {
      flashTimer = null
      save.button.classList.remove('is-saved')
      save.setContent(ICONS.save(), 'Save')
    }, SAVED_FLASH_MS)
  })

  function close(): void {
    revertPopover.close()
  }

  // The confirmation's Cancel, focused once it is open.
  let cancel: HTMLButtonElement | null = null
  revert.button.setAttribute('aria-haspopup', 'dialog')
  revert.button.setAttribute('aria-expanded', 'false')
  const revertPopover = anchoredPopover(revert.button, {
    build: () => {
      const name = store.active().name
      const panel = document.createElement('div')
      panel.className = 'kc-popover wd-ws-revert-panel'
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', 'Revert workspace')

      const question = document.createElement('p')
      question.className = 'wd-ws-revert-text'
      question.textContent = store.isDirty()
        ? `Discard the unsaved changes to “${name}” and reload it as last saved?`
        : `Put the panes of “${name}” back where they were last saved?`

      const actions = document.createElement('div')
      actions.className = 'wd-ws-revert-actions'
      cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.className = 'kc-button kc-button-outline wd-ws-confirm-button'
      cancel.textContent = 'Cancel'
      cancel.addEventListener('click', close)
      const confirm = document.createElement('button')
      confirm.type = 'button'
      confirm.className = 'kc-button wd-ws-confirm-button is-danger'
      confirm.textContent = 'Revert'
      confirm.addEventListener('click', () => {
        close()
        store.revertActive()
        onRevert()
      })
      actions.append(cancel, confirm)
      panel.append(question, actions)
      return panel
    },
    // On Cancel, not on Revert: Enter on an opened confirmation must not be what throws the
    // work away.
    onOpen: () => cancel?.focus()
  })

  store.onChange(refresh)
  refresh()

  return { element, refresh, close }
}
