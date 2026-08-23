import { loadWorkspaces, type MtfPanePrefs, type WorkspaceStore } from '../workspaces/store'
import { MTF_DEFAULTS, loadLegacyGlobalMtfConfig, type MtfConfig } from './config'

// The AREV21 multi-timeframe overlay's settings, PER PANE.
//
// They live inside the active workspace (client/workspaces/store.ts) keyed by pane position,
// exactly where server-indicator parameters live and for the same reason: a pane index means
// nothing outside the layout it indexes into, so a set shared across workspaces would hand
// one wall's third pane's palette to whatever happens to sit third on another. Duplicating a
// workspace copies them; deleting one drops them.
//
// Per pane rather than per user, which is what this was until now. The argument for one
// shared set was that a colour meaning 4h on one pane and 1D on another defeats colouring by
// timeframe — true when every pane is showing the same thing, and wrong as soon as they are
// not: a wall is several charts on purpose, and a 1h pane wants a different set of source
// timeframes from a 1D pane. Consistency across panes is now something a user can choose by
// setting them the same way, rather than something the code imposes.

export type { MtfPanePrefs }

let store: WorkspaceStore | null = null
/** The pre-per-pane global config, used to seed a pane that has none — see configFor. */
let seed: MtfConfig = MTF_DEFAULTS

/** Resolves against whichever workspace is active when it is called. The controller is
 * rebuilt on every chart mount, so a workspace switch re-reads this rather than needing to
 * be told about it. */
export async function loadMtfPrefs(): Promise<MtfPanePrefs> {
  try {
    seed = await loadLegacyGlobalMtfConfig()
  } catch {
    seed = MTF_DEFAULTS
  }
  try {
    store = await loadWorkspaces()
    return store.active().mtfConfig
  } catch {
    return {}
  }
}

/** This pane's settings: its own if it has any, otherwise a fresh copy of the seed.
 *
 * The seed is the single global config this overlay used to keep, so a user who had already
 * chosen their timeframes and colours sees them carried onto every pane rather than being
 * reset to the palette — and where no such config was ever written, it reads as MTF_DEFAULTS,
 * which is the same answer. Cloned, because the caller mutates what it is given and two
 * panes must not end up sharing one object. */
export function configFor(prefs: MtfPanePrefs, paneIndex: number): MtfConfig {
  const own = prefs[String(paneIndex)]
  return structuredClone(own ?? seed)
}

// Mutated in place, deliberately: the object handed out by loadMtfPrefs is the live one the
// controller keeps reading. Replacing it would leave that reader on a stale snapshot.
export function saveMtfPaneConfig(paneIndex: number, config: MtfConfig): void {
  if (!store) return
  const prefs = store.active().mtfConfig
  prefs[String(paneIndex)] = structuredClone(config)
  store.setMtfConfig(prefs)
}
