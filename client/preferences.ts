import { apiSend, OhlcvApiError } from './config'
import { authHeaders } from './auth'

// GET/PUT /preferences — a single JSON blob per user, versioned by an integer `revision`
// (wdashboard-server's appstate.py). Starred timeframes were the first key this held; per-
// layer chart settings (client/chartlayers/store.ts) are the second — both go through the
// generic loadPreferences/savePreference below, so a third key is no new code here.

const STARRED_TIMEFRAMES_KEY = 'starredTimeframes'

// Debounced so several changes in a row — starring/unstarring timeframes, dragging a
// settings-panel slider — collapse into one PUT instead of one per change.
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

// Called once at boot, after login, before the chart mounts (mirrors how
// loadCapabilities() is awaited before mounting today), and again by any caller that needs
// the current document (client/chartlayers/store.ts, on every layer mount). Never throws: a
// fetch failure here should degrade to per-key defaults, not block the chart from opening.
export async function loadPreferences(): Promise<Record<string, unknown>> {
  try {
    const { data } = await apiSend<PreferencesDocument>('GET', '/preferences', {
      headers: authHeaders()
    })
    known = data
    return data.data
  } catch (err) {
    console.warn('[preferences] load failed, using defaults', err)
    return {}
  }
}

export async function loadStarredTimeframes(): Promise<string[]> {
  return starredTimeframesFrom(await loadPreferences())
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
// Keys changed since the last successful PUT, merged into `known.data` only at flush time —
// not eagerly — so a starred-timeframe change and a settings-panel change made within the
// same debounce window land in one PUT even though they touch different keys.
let pending: Record<string, unknown> = {}

// Fire-and-forget: every caller (the chart's onStarredPeriodsChange callback, a settings
// panel's onChange) is a UI event handler with no way to await or surface an error itself.
export function savePreference(key: string, value: unknown): void {
  pending[key] = value
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const changes = pending
    pending = {}
    void flush(changes)
  }, SAVE_DEBOUNCE_MS)
}

export function saveStarredTimeframes(starredTimeframes: string[]): void {
  savePreference(STARRED_TIMEFRAMES_KEY, starredTimeframes)
}

// Retries once on a 412 (another tab, or this same module's own in-flight save, moved the
// revision) by re-fetching the current document and replaying the same changes on top of
// it — last-write-wins is an acceptable resolution for one user's own preferences.
async function flush(changes: Record<string, unknown>, retried = false): Promise<void> {
  const nextData = { ...(known?.data ?? {}), ...changes }
  const headers = { ...authHeaders() }
  if (known) headers['If-Match'] = `"${known.revision}"`

  try {
    const { data } = await apiSend<PreferencesDocument>('PUT', '/preferences', {
      body: { data: nextData },
      headers
    })
    known = data
  } catch (err) {
    if (err instanceof OhlcvApiError && err.status === 412 && !retried) {
      known = undefined
      await loadPreferences()
      await flush(changes, true)
      return
    }
    console.error('[preferences] save failed', err)
  }
}
