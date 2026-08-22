import { loadWorkspaces, type ServerIndicatorPrefs, type WorkspaceStore } from '../workspaces/store'

// Per-pane parameters of the server indicators a user has on the wall. client/layout.ts holds
// only indicator NAMES per pane (klinecharts' calcParams are not part of PaneSnapshot), so
// these are stored beside the layout — keyed by pane position and template name, so a
// restored wall gets its RSI back at 9, not 14.
//
// They live INSIDE the active workspace (client/workspaces/store.ts), not in a preference key
// of their own: a pane index means nothing outside the layout it indexes into, so a set shared
// across workspaces would hand the RSI(9) of one wall's third pane to whatever happens to sit
// third on another. Duplicating a workspace copies them; deleting one drops them.

export type { ServerIndicatorPrefs }

let store: WorkspaceStore | null = null

/** Resolves against whichever workspace is active when it is called. The indicator
 * controller is rebuilt on every chart mount, so a workspace switch re-reads this rather
 * than needing to be told about it. */
export async function loadServerIndicatorPrefs(): Promise<ServerIndicatorPrefs> {
  try {
    store = await loadWorkspaces()
    return store.active().indicatorParams
  } catch {
    return {}
  }
}

// Mutated in place, deliberately: the object handed out by loadServerIndicatorPrefs is the
// live one the controller keeps reading to decide whether a mounted indicator's params were
// user-set. Replacing it would leave that reader looking at a stale snapshot.
function edit(mutate: (prefs: ServerIndicatorPrefs) => boolean): void {
  if (!store) return
  const prefs = store.active().indicatorParams
  if (!mutate(prefs)) return
  store.setIndicatorParams(prefs)
}

export function saveServerIndicatorParams(paneIndex: number, name: string, calcParams: number[]): void {
  edit((prefs) => {
    const pane = prefs[String(paneIndex)] ?? {}
    pane[name] = calcParams
    prefs[String(paneIndex)] = pane
    return true
  })
}

export function forgetServerIndicatorParams(paneIndex: number, name: string): void {
  edit((prefs) => {
    const pane = prefs[String(paneIndex)]
    if (!pane || !(name in pane)) return false
    delete pane[name]
    return true
  })
}
