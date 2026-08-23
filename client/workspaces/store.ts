import { hasFeature } from '../capabilities'
import {
  defaultLayout,
  isPersistedLayout,
  type PersistedLayout
} from '../layout'
import type { MtfConfig } from '../mtf/config'
import { loadPreferences, removePreference, savePreference } from '../preferences'

// A WORKSPACE is one saved wall: its layout preset, every pane's symbol/timeframe/indicators,
// the sync toggles, and the parameters of any server indicator on it. A user keeps several —
// one per desk or device ("Laptop", "Home 4K"), one per book ("Majors", "Metals"), one per
// strategy ("Reversals", "Levels review") — and switches between them from the toolbar.
//
// Storage layout, and why it is one key PER WORKSPACE rather than one array under one key:
// /preferences is a single JSON document behind an optimistic `revision`, and
// client/preferences.ts resolves a 412 by re-fetching and replaying only the KEYS it had
// pending. With one key per workspace, a laptop renaming "Majors" and a desktop re-arranging
// "Metals" at the same moment merge cleanly; under a single `workspaces` array the later
// writer would silently drop the other's edit — which is exactly the multi-device case this
// feature exists for.
//
//   workspaces          -> { version, order: string[], lastActive: string }   (the index)
//   workspace.<id>      -> { id, name, updatedAt, layout, indicatorParams }   (one per workspace)
//
// WHICH workspace this device is looking at is deliberately NOT part of the shared document:
// it lives in localStorage, so opening the dashboard on a second screen doesn't yank the
// first one to a different wall. The index's `lastActive` is only the seed a device with no
// choice of its own starts from.

const INDEX_KEY = 'workspaces'
const DOC_PREFIX = 'workspace.'
// Deliberately NOT 'wd.workspace.active': that would sit inside the `wd.workspace.<id>`
// document prefix the local backend enumerates, so this device's own choice would read back
// as a (malformed) workspace.
const ACTIVE_LOCAL_KEY = 'wd.activeWorkspace'
const LOCAL_PREFIX = 'wd.'
// The single `layout` preference the client wrote before workspaces existed. Read once, at
// first boot after the upgrade, and turned into the user's first workspace.
const LEGACY_KEY = 'layout'

const WORKSPACES_VERSION = 1

// A ceiling, not a quota: the whole set shares one 64 KiB /preferences document
// (appstate.py's MAX_PREFERENCES_BYTES) and a 12-pane wall is ~2 KiB, so this is where a
// user gets a clear "you have enough" instead of a 413 from a PUT they can't see.
export const MAX_WORKSPACES = 12

/** paneIndex -> template name -> calcParams. Lives here rather than in
 * client/indicators/prefs.ts because it is part of a workspace: a pane index means nothing
 * outside the layout it indexes into, so duplicating or deleting a workspace has to carry
 * (or drop) its indicator parameters in the same breath. */
export type ServerIndicatorPrefs = Record<string, Record<string, number[]>>

/** paneIndex -> that pane's AREV21 multi-timeframe overlay settings (which timeframes it
 * draws, and each one's colour and sizes). Here for exactly the reason above, and separate
 * from ServerIndicatorPrefs because these are not klinecharts calcParams: the overlay's
 * settings are a record per timeframe, not a flat numeric array, which is why it owns its
 * own settings panel in the first place (client/mtf/config.ts). */
export type MtfPanePrefs = Record<string, MtfConfig>

export interface Workspace {
  id: string
  name: string
  /** Epoch ms of the last change made anywhere. Shown in the switcher, and what makes
   * "which of these did I touch on the other machine" answerable. */
  updatedAt: number
  layout: PersistedLayout
  indicatorParams: ServerIndicatorPrefs
  mtfConfig: MtfPanePrefs
}

interface WorkspaceIndex {
  version: number
  order: string[]
  lastActive: string
}

function isWorkspaceIndex(value: unknown): value is WorkspaceIndex {
  if (!value || typeof value !== 'object') return false
  const index = value as Record<string, unknown>
  return (
    typeof index.version === 'number' &&
    Array.isArray(index.order) &&
    index.order.every((id) => typeof id === 'string') &&
    typeof index.lastActive === 'string'
  )
}

// Tolerant in exactly the way isPersistedLayout is: a document this client can't read is
// dropped from the set, never mounted half-formed and never thrown over.
function toWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== 'object') return null
  const doc = value as Record<string, unknown>
  if (typeof doc.id !== 'string' || typeof doc.name !== 'string') return null
  if (!isPersistedLayout(doc.layout)) return null
  const params = doc.indicatorParams
  const mtf = doc.mtfConfig
  return {
    id: doc.id,
    name: doc.name,
    updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : 0,
    layout: doc.layout,
    indicatorParams: params && typeof params === 'object' ? (params as ServerIndicatorPrefs) : {},
    // Absent on every document written before the overlay's settings became per-pane, which
    // is why it is filled in rather than validated: an empty set means "no pane has been
    // configured", and client/mtf/prefs.ts seeds those.
    mtfConfig: mtf && typeof mtf === 'object' ? (mtf as MtfPanePrefs) : {}
  }
}

// --- storage backends -----------------------------------------------------------------
//
// Two, with the same key space. The server document is authoritative wherever the server
// advertises `preferences` (dev); prod has no appstate database, so localStorage is the only
// persistence there. Writes ALSO go to localStorage even when the server copy is
// authoritative — it costs nothing and it is what a same-tab reload falls back to when
// /preferences is unreachable, which is the behaviour client/layout.ts had before this.

interface Backend {
  readAll(): Promise<Record<string, unknown>>
  write(key: string, value: unknown): void
  remove(key: string): void
}

const localBackend: Backend = {
  async readAll() {
    const data: Record<string, unknown> = {}
    const keys: string[] = []
    try {
      // The index form rather than Object.keys: `Storage` is an exotic object, and the
      // enumerable-own-properties view of it is not something to rely on.
      for (let i = 0; i < window.localStorage.length; i += 1) {
        const key = window.localStorage.key(i)
        if (key !== null) keys.push(key)
      }
    } catch (err) {
      console.warn('[workspaces] localStorage is unavailable', err)
      return data
    }
    for (const raw of keys) {
      if (!raw.startsWith(LOCAL_PREFIX)) continue
      const key = raw.slice(LOCAL_PREFIX.length)
      if (key !== INDEX_KEY && key !== LEGACY_KEY && !key.startsWith(DOC_PREFIX)) continue
      // Per entry, not around the loop: one unparseable value -- a half-written document, or
      // a key some other build of this client left in the same namespace -- must cost that
      // one workspace, not every workspace enumerated after it.
      try {
        const value = window.localStorage.getItem(raw)
        if (value !== null) data[key] = JSON.parse(value) as unknown
      } catch (err) {
        console.warn(`[workspaces] ignoring unreadable ${raw}`, err)
      }
    }
    return data
  },
  write(key, value) {
    try {
      window.localStorage.setItem(`${LOCAL_PREFIX}${key}`, JSON.stringify(value))
    } catch (err) {
      console.warn('[workspaces] localStorage write failed', err)
    }
  },
  remove(key) {
    try {
      window.localStorage.removeItem(`${LOCAL_PREFIX}${key}`)
    } catch (err) {
      console.warn('[workspaces] localStorage remove failed', err)
    }
  }
}

const preferencesBackend: Backend = {
  readAll: () => loadPreferences(),
  write: (key, value) => savePreference(key, value),
  remove: (key) => removePreference(key)
}

function newId(): string {
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function uniqueName(existing: Workspace[], base: string): string {
  const taken = new Set(existing.map((w) => w.name.toLowerCase()))
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return `${base} ${newId()}`
}

export class WorkspaceStore {
  private readonly remote: Backend | null
  private readonly workspaces: Workspace[]
  private activeId: string
  // Per workspace id, the serialized document last written -- `active` moves on every pane
  // click, and without this a click-around session would generate a PUT (or a localStorage
  // write) per click regardless of the debounce underneath.
  private readonly lastWritten = new Map<string, string>()

  constructor(remote: Backend | null, workspaces: Workspace[], activeId: string) {
    this.remote = remote
    this.workspaces = workspaces
    this.activeId = activeId
  }

  list(): readonly Workspace[] {
    return this.workspaces
  }

  get(id: string): Workspace | null {
    return this.workspaces.find((w) => w.id === id) ?? null
  }

  active(): Workspace {
    return this.get(this.activeId) ?? this.workspaces[0]
  }

  getActiveId(): string {
    return this.active().id
  }

  private writeDoc(workspace: Workspace): void {
    const serialized = JSON.stringify(workspace)
    if (this.lastWritten.get(workspace.id) === serialized) return
    this.lastWritten.set(workspace.id, serialized)
    const key = `${DOC_PREFIX}${workspace.id}`
    this.remote?.write(key, workspace)
    localBackend.write(key, workspace)
  }

  /** Writes every workspace document. Used once at boot when the set was just migrated from
   * the legacy `layout` key or defaulted into existence, so that a user who only ever looks
   * at the dashboard still finds the same named workspace on their next visit. */
  persistAll(): void {
    for (const workspace of this.workspaces) this.writeDoc(workspace)
    this.writeIndex()
  }

  private writeIndex(): void {
    const index: WorkspaceIndex = {
      version: WORKSPACES_VERSION,
      order: this.workspaces.map((w) => w.id),
      lastActive: this.activeId
    }
    this.remote?.write(INDEX_KEY, index)
    localBackend.write(INDEX_KEY, index)
  }

  /** The live wall, saved into the active workspace. Called from every ChartPro change
   * callback, so it must stay cheap when nothing actually changed. */
  saveActiveLayout(layout: PersistedLayout): void {
    const workspace = this.active()
    const serialized = JSON.stringify(layout)
    if (JSON.stringify(workspace.layout) === serialized) return
    workspace.layout = layout
    workspace.updatedAt = Date.now()
    this.writeDoc(workspace)
  }

  setIndicatorParams(params: ServerIndicatorPrefs): void {
    const workspace = this.active()
    workspace.indicatorParams = params
    workspace.updatedAt = Date.now()
    this.writeDoc(workspace)
  }

  setMtfConfig(config: MtfPanePrefs): void {
    const workspace = this.active()
    workspace.mtfConfig = config
    workspace.updatedAt = Date.now()
    this.writeDoc(workspace)
  }

  /** Per-device, never part of the shared document -- see this module's header. */
  setActive(id: string): void {
    if (!this.get(id)) return
    this.activeId = id
    try {
      window.localStorage.setItem(ACTIVE_LOCAL_KEY, id)
    } catch (err) {
      console.warn('[workspaces] could not remember the active workspace', err)
    }
    this.writeIndex()
  }

  canCreate(): boolean {
    return this.workspaces.length < MAX_WORKSPACES
  }

  /** Returns the new workspace, or null when the set is full. Does NOT switch to it -- the
   * caller decides, because switching remounts the chart. */
  create(name: string, layout: PersistedLayout = defaultLayout()): Workspace | null {
    if (!this.canCreate()) return null
    const workspace: Workspace = {
      id: newId(),
      name: uniqueName(this.workspaces, name.trim() || 'Workspace'),
      updatedAt: Date.now(),
      layout,
      indicatorParams: {},
      mtfConfig: {}
    }
    this.workspaces.push(workspace)
    this.writeDoc(workspace)
    this.writeIndex()
    return workspace
  }

  /** A copy carries the per-pane settings too -- server indicator parameters and the AREV21
   * overlay's timeframes and colours alike: both are keyed by pane index, so a duplicated
   * wall without them would come back with every server indicator reset to its default
   * period and every overlay reset to its default palette. */
  duplicate(id: string): Workspace | null {
    const source = this.get(id)
    if (!source || !this.canCreate()) return null
    const copy: Workspace = {
      id: newId(),
      name: uniqueName(this.workspaces, `${source.name} copy`),
      updatedAt: Date.now(),
      layout: structuredClone(source.layout),
      indicatorParams: structuredClone(source.indicatorParams),
      mtfConfig: structuredClone(source.mtfConfig)
    }
    this.workspaces.splice(this.workspaces.indexOf(source) + 1, 0, copy)
    this.writeDoc(copy)
    this.writeIndex()
    return copy
  }

  rename(id: string, name: string): void {
    const workspace = this.get(id)
    const trimmed = name.trim()
    if (!workspace || !trimmed || trimmed === workspace.name) return
    workspace.name = uniqueName(
      this.workspaces.filter((w) => w !== workspace),
      trimmed
    )
    workspace.updatedAt = Date.now()
    this.writeDoc(workspace)
  }

  /** Returns the id now active, which differs from the old one only when the deleted
   * workspace WAS the active one. The last workspace can never be removed: "no workspaces"
   * is not a state the chart can be mounted in. */
  remove(id: string): string {
    if (this.workspaces.length <= 1) return this.activeId
    const index = this.workspaces.findIndex((w) => w.id === id)
    if (index < 0) return this.activeId
    this.workspaces.splice(index, 1)
    this.lastWritten.delete(id)
    const key = `${DOC_PREFIX}${id}`
    this.remote?.remove(key)
    localBackend.remove(key)
    if (this.activeId === id) {
      this.activeId = this.workspaces[Math.min(index, this.workspaces.length - 1)].id
      try {
        window.localStorage.setItem(ACTIVE_LOCAL_KEY, this.activeId)
      } catch {
        // The set is still correct in the shared document; this device just re-derives
        // its choice from `lastActive` on the next boot.
      }
    }
    this.writeIndex()
    return this.activeId
  }
}

// --- loading --------------------------------------------------------------------------

function collect(data: Record<string, unknown>): Workspace[] {
  const found = new Map<string, Workspace>()
  for (const [key, value] of Object.entries(data)) {
    if (!key.startsWith(DOC_PREFIX)) continue
    const workspace = toWorkspace(value)
    if (workspace) found.set(workspace.id, workspace)
  }
  return [...found.values()]
}

function ordered(found: Workspace[], index: WorkspaceIndex | null): Workspace[] {
  if (!index) return found.sort((a, b) => b.updatedAt - a.updatedAt)
  const byId = new Map(found.map((w) => [w.id, w]))
  const inOrder = index.order.map((id) => byId.get(id)).filter((w): w is Workspace => Boolean(w))
  // Anything the index doesn't name -- written by another device between this device's read
  // of the index and its read of the documents, or orphaned by a half-applied delete -- is
  // kept rather than dropped, at the end.
  const named = new Set(inOrder.map((w) => w.id))
  return [...inOrder, ...found.filter((w) => !named.has(w.id))]
}

let loading: Promise<WorkspaceStore> | null = null

/** Memoized: the switcher, the chart bootstrap and client/indicators/prefs.ts all want the
 * same store, and none of them is guaranteed to run first. Never throws -- a failure of any
 * kind degrades to a single default workspace, the same contract loadLayout() had. */
export function loadWorkspaces(): Promise<WorkspaceStore> {
  if (!loading) loading = build()
  return loading
}

async function build(): Promise<WorkspaceStore> {
  const remote = hasFeature('preferences') ? preferencesBackend : null

  let data: Record<string, unknown> = {}
  try {
    data = remote ? await remote.readAll() : {}
  } catch (err) {
    console.warn('[workspaces] preferences load failed', err)
  }
  let index = isWorkspaceIndex(data[INDEX_KEY]) ? data[INDEX_KEY] : null
  let found = collect(data)
  // True when the set below was invented here (migrated from `layout`, or defaulted) rather
  // than read back from storage.
  let fresh = false
  // The local mirror answers two cases with one branch: prod, where there is no server
  // document at all, and a dev boot where /preferences was unreachable or has not been
  // written yet.
  if (found.length === 0) {
    const localData = await localBackend.readAll()
    found = collect(localData)
    if (!index && isWorkspaceIndex(localData[INDEX_KEY])) index = localData[INDEX_KEY]
    if (found.length === 0) {
      const legacy = data[LEGACY_KEY] ?? localData[LEGACY_KEY]
      if (isPersistedLayout(legacy)) {
        // One upgrade path, taken once: the single wall this user had before workspaces
        // existed becomes their first workspace, under the name the switcher would have
        // given it anyway. The legacy `layout` key is left where it is -- an older client
        // still reads it, and it costs a few hundred bytes.
        found = [
          {
            id: newId(),
            name: 'Default',
            updatedAt: Date.now(),
            layout: legacy,
            indicatorParams: {},
            mtfConfig: {}
          }
        ]
        fresh = true
      }
    }
  }

  const workspaces = ordered(found, index)
  if (workspaces.length === 0) {
    fresh = true
    workspaces.push({
      id: newId(),
      name: 'Default',
      updatedAt: Date.now(),
      layout: defaultLayout(),
      indicatorParams: {},
      mtfConfig: {}
    })
  }

  let activeId = ''
  try {
    activeId = window.localStorage.getItem(ACTIVE_LOCAL_KEY) ?? ''
  } catch {
    // A device that can't remember its own choice falls back to the shared `lastActive`.
  }
  if (!workspaces.some((w) => w.id === activeId)) {
    activeId = workspaces.some((w) => w.id === index?.lastActive)
      ? (index as WorkspaceIndex).lastActive
      : workspaces[0].id
  }

  const store = new WorkspaceStore(remote, workspaces, activeId)
  store.setActive(activeId)
  // Only when there was nothing to read: an existing set is already stored, and rewriting it
  // at every boot would put a PUT /preferences on the critical path of simply opening the
  // dashboard. A migrated or defaulted set has to be written, or it would be re-derived (with
  // a different id, so a second device would see a duplicate) on every visit.
  if (fresh) store.persistAll()
  return store
}
