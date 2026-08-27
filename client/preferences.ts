import { apiSend, OhlcvApiError } from './config'
import { authHeaders } from './auth'

// GET/PUT /preferences — a single JSON blob per user, versioned by an integer `revision`
// (wdashboard-server's appstate.py). Starred timeframes were the first key this held; per-
// layer chart settings (client/chartlayers/store.ts) and the user's saved workspaces
// (client/workspaces/store.ts — one key per workspace, plus an index) are the others — all go
// through the generic loadPreferences/savePreference/removePreference below, so a further key
// is no new code here.

const STARRED_TIMEFRAMES_KEY = 'starredTimeframes'

// Debounced so several changes in a row — starring/unstarring timeframes, dragging a
// settings-panel slider, a layout change — collapse into one PUT instead of one per change.
const SAVE_DEBOUNCE_MS = 500

interface PreferencesDocument {
  data: Record<string, unknown>
  revision: number
}

function starredTimeframesFrom(data: Record<string, unknown>): string[] {
  const value = data[STARRED_TIMEFRAMES_KEY]
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : []
}

// In-memory copy of what the server last confirmed, so a save only needs to merge pending
// keys in rather than re-fetching first. Undefined until loadPreferences() resolves.
let known: PreferencesDocument | undefined
// In-flight GET, so N callers during boot (starred timeframes, the wall layout, every chart
// layer's own config) share one request instead of each firing their own.
let inflight: Promise<Record<string, unknown>> | null = null

// Called once at boot, after login, before the chart mounts (mirrors how
// loadCapabilities() is awaited before mounting today), and again by any later caller that
// needs the current document (client/chartlayers/store.ts on every layer mount,
// client/layout.ts on boot). Never throws: a fetch failure here should degrade to per-key
// defaults, not block the chart from opening.
export async function loadPreferences(): Promise<Record<string, unknown>> {
  if (known) return known.data
  if (!inflight) {
    inflight = (async () => {
      try {
        known = await read()
        return known?.data ?? {}
      } finally {
        inflight = null
      }
    })()
  }
  return inflight
}

// One unconditional GET. Separate from loadPreferences() because a conflict resolution must
// never be served the memoized document (that is the revision it just lost to) nor a GET that
// was already in flight before the conflict happened — both would replay the same stale
// If-Match and burn an attempt. Undefined on failure, which flush() reads as "write
// unconditionally", the same last-write-wins fallback a first-ever save takes.
async function read(): Promise<PreferencesDocument | undefined> {
  try {
    const { data } = await apiSend<PreferencesDocument>('GET', '/preferences', {
      headers: authHeaders()
    })
    return data
  } catch (err) {
    console.warn('[preferences] load failed, using defaults', err)
    return undefined
  }
}

export async function loadStarredTimeframes(): Promise<string[]> {
  return starredTimeframesFrom(await loadPreferences())
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
// Keys changed since the last successful PUT, merged into `known.data` only at flush time —
// not eagerly — so a starred-timeframe change and a settings-panel or layout change made
// within the same debounce window land in one PUT even though they touch different keys.
let pending: Record<string, unknown> = {}
// The write loop, while one is running. This module is SINGLE-FLIGHT: at most one PUT is ever
// in the air for this tab. Without it the debounce alone is no protection — it only spaces
// flushes 500ms apart, and a flush that takes longer than that (or two flushes started by
// different callers) both read the same `known.revision` and send the same If-Match, so one
// of them is guaranteed to 412 against its own tab. That was the common case: panning fires
// a layout save per data load, and those overlap. Changes made while a write is in flight are
// picked up by the same loop rather than starting a second one.
let writing: Promise<void> | null = null

// How many times one flush will re-read and replay after a 412 before giving up. A conflict
// that survives this many rounds is not contention, it is something structural. More than one
// is needed because the user has several tabs open and every one of them writes: two tabs
// retrying at once means one loses again, and the single retry this used to have gave up
// there and dropped the save with nothing but a console line.
const MAX_WRITE_ATTEMPTS = 4

// Fire-and-forget: every caller (the chart's onStarredPeriodsChange callback, a settings
// panel's onChange, the wall's onPaneLayoutChange) is a UI event handler with no way to
// await or surface an error itself.
export function savePreference(key: string, value: unknown): void {
  pending[key] = value
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void drain()
  }, SAVE_DEBOUNCE_MS)
}

// Deleting a key is a `savePreference(key, undefined)`: `flush` spreads pending changes over
// the known document, and JSON.stringify drops an undefined value, so the PUT body — which
// REPLACES the stored document rather than merging into it (appstate.py) — simply no longer
// carries it. Named, rather than left to each caller to know that, because it is the one
// place the delete semantics of a replace-the-whole-document PUT are non-obvious.
export function removePreference(key: string): void {
  savePreference(key, undefined)
}

export function saveStarredTimeframes(starredTimeframes: string[]): void {
  savePreference(STARRED_TIMEFRAMES_KEY, starredTimeframes)
}

// Writes accumulated changes until there are none left, one PUT at a time. Re-checking
// `pending` after each write is what makes a save made DURING a write safe: it joins the
// running loop instead of racing it, and the debounce timer that scheduled it becomes a no-op.
function drain(): Promise<void> {
  if (writing) return writing
  writing = (async () => {
    try {
      while (Object.keys(pending).length > 0) {
        const changes = pending
        pending = {}
        await flush(changes)
      }
    } finally {
      writing = null
    }
  })()
  return writing
}

/** Exposed for tests: resolves once no write is in flight and nothing is pending. */
export function settled(): Promise<void> {
  return writing ?? Promise.resolve()
}

// Resolves a 412 by re-reading the current document and replaying the same changes on top of
// it — last-write-wins is an acceptable resolution for one user's own preferences, and
// replaying only the KEYS this flush carries is what lets two devices editing different
// workspaces merge instead of clobbering each other (see workspaces/store.ts).
async function flush(changes: Record<string, unknown>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    const headers = { ...authHeaders() }
    // No If-Match at all is the deliberate first-ever-write path: the server treats an absent
    // If-Match as an unconditional upsert. Quoting a revision we never read would be a lie.
    if (known) headers['If-Match'] = `"${known.revision}"`

    try {
      const { data } = await apiSend<PreferencesDocument>('PUT', '/preferences', {
        body: { data: { ...(known?.data ?? {}), ...changes } },
        headers
      })
      known = data
      return
    } catch (err) {
      const conflict = err instanceof OhlcvApiError && err.status === 412
      if (!conflict || attempt >= MAX_WRITE_ATTEMPTS) {
        console.error('[preferences] save failed', err)
        return
      }
      // Adopt whatever the winning writer stored, then replay `changes` on top of it.
      known = await read()
    }
  }
}
