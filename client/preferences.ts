import { apiSend, OhlcvApiError } from './config'
import { authHeaders } from './auth'

// GET/PUT /preferences — a single JSON blob per user, versioned by an integer `revision`
// (wdashboard-server's appstate.py). Starred timeframes are the first key this holds; later
// UI state (theme, indicators, last symbol) can land as additional keys with no migration.

const STARRED_TIMEFRAMES_KEY = 'starredTimeframes'

// Debounced the same way client/index.ts already debounces the levels redraw
// (LEVELS_REDRAW_DEBOUNCE_MS): starring/unstarring several timeframes in a row should be
// one PUT, not one per click.
const SAVE_DEBOUNCE_MS = 500

interface PreferencesDocument {
  data: Record<string, unknown>
  revision: number
}

function starredTimeframesFrom(data: Record<string, unknown>): string[] {
  const value = data[STARRED_TIMEFRAMES_KEY]
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : []
}

// In-memory copy of what the server last confirmed, so a save only needs to merge one key
// in rather than re-fetching first. Undefined until loadStarredTimeframes() resolves.
let known: PreferencesDocument | undefined

// Called once at boot, after login, before the chart mounts (mirrors how
// loadCapabilities() is awaited before mounting today). Never throws: a fetch failure here
// should degrade to the default starred set, not block the chart from opening.
export async function loadStarredTimeframes(): Promise<string[]> {
  try {
    const { data } = await apiSend<PreferencesDocument>('GET', '/preferences', {
      headers: authHeaders()
    })
    known = data
    return starredTimeframesFrom(data.data)
  } catch (err) {
    console.warn('[preferences] load failed, using defaults', err)
    return []
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

// Fire-and-forget from the chart's onStarredPeriodsChange callback, which has no way to
// await or surface an error itself. Retries once on a 412 (another tab, or this same
// module's own in-flight save, moved the revision) by re-fetching the current document and
// replaying the merge on top of it — last-write-wins is an acceptable resolution for one
// user's own starred set.
export function saveStarredTimeframes(starredTimeframes: string[]): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void save(starredTimeframes)
  }, SAVE_DEBOUNCE_MS)
}

async function save(starredTimeframes: string[], retried = false): Promise<void> {
  const base = known?.data ?? {}
  const nextData = { ...base, [STARRED_TIMEFRAMES_KEY]: starredTimeframes }
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
      await loadStarredTimeframes()
      await save(starredTimeframes, true)
      return
    }
    console.error('[preferences] save failed', err)
  }
}
