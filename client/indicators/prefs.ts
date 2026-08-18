import { hasFeature } from '../capabilities'
import { loadPreferences, savePreference } from '../preferences'

// Per-pane parameters of the server indicators a user has on the wall, persisted through
// the same per-user preferences the layout uses (client/layout.ts holds only indicator
// NAMES per pane; klinecharts' calcParams are not part of PaneSnapshot). Keyed by pane
// position (the layout's own pane order) and template name, so a restored wall gets its
// RSI back at 9, not 14.

const KEY = 'serverIndicators'
const LOCAL_KEY = 'wd.serverIndicators'

export type ServerIndicatorPrefs = Record<string, Record<string, number[]>> // paneIndex -> name -> calcParams

let cached: ServerIndicatorPrefs | null = null

function readLocal(): ServerIndicatorPrefs {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    return raw ? (JSON.parse(raw) as ServerIndicatorPrefs) : {}
  } catch {
    return {}
  }
}

export async function loadServerIndicatorPrefs(): Promise<ServerIndicatorPrefs> {
  if (cached) return cached
  if (hasFeature('preferences')) {
    try {
      const prefs = await loadPreferences()
      const value = prefs[KEY]
      cached = value && typeof value === 'object' ? (value as ServerIndicatorPrefs) : {}
      return cached
    } catch {
      // fall through to local
    }
  }
  cached = readLocal()
  return cached
}

export function saveServerIndicatorParams(paneIndex: number, name: string, calcParams: number[]): void {
  const prefs = cached ?? readLocal()
  const pane = { ...(prefs[String(paneIndex)] ?? {}) }
  pane[name] = calcParams
  prefs[String(paneIndex)] = pane
  cached = prefs
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(prefs))
  } catch {
    // storage unavailable: preferences still carry it when enabled
  }
  if (hasFeature('preferences')) savePreference(KEY, prefs)
}

export function forgetServerIndicatorParams(paneIndex: number, name: string): void {
  const prefs = cached ?? readLocal()
  const pane = prefs[String(paneIndex)]
  if (!pane || !(name in pane)) return
  const next = { ...pane }
  delete next[name]
  prefs[String(paneIndex)] = next
  cached = prefs
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(prefs))
  } catch {
    // ignore
  }
  if (hasFeature('preferences')) savePreference(KEY, prefs)
}
