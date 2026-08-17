import { hasFeature } from '../capabilities'
import { loadPreferences, savePreference } from '../preferences'

// Per-layer settings persistence. `/preferences` (client/preferences.ts) is dev-only — it
// requires the `auth` feature, which prod does not advertise (client/capabilities.ts) — so a
// layer's config falls back to localStorage there rather than silently never persisting.

const STORAGE_PREFIX = 'wd.layer.'

function storageKey(layerId: string): string {
  return `${STORAGE_PREFIX}${layerId}`
}

function preferenceKey(layerId: string): string {
  return `layer.${layerId}`
}

// A layer always saves its complete config (the settings panel holds the full object, not a
// diff), so a merge only has to fill in keys a stored, older document is missing — but it
// has to do that at every nesting level, not just the top one, or an update that adds a
// field inside an existing nested object (e.g. a new Encoding property) would silently lose
// its default the first time a user's old saved document round-trips through it.
function mergeDefaults<T>(defaults: T, stored: unknown): T {
  if (Array.isArray(defaults) || defaults === null || typeof defaults !== 'object') {
    return stored === undefined ? defaults : (stored as T)
  }
  if (stored === null || typeof stored !== 'object' || Array.isArray(stored)) return defaults
  const result: Record<string, unknown> = { ...(defaults as Record<string, unknown>) }
  for (const [key, value] of Object.entries(defaults as Record<string, unknown>)) {
    result[key] = mergeDefaults(value, (stored as Record<string, unknown>)[key])
  }
  return result as T
}

// Never throws: a load failure of any kind degrades to `defaults`, the same contract
// client/preferences.ts already makes for starred timeframes.
export async function loadLayerConfig<T extends object>(
  layerId: string,
  defaults: T
): Promise<T> {
  if (hasFeature('preferences')) {
    try {
      const data = await loadPreferences()
      return mergeDefaults(defaults, data[preferenceKey(layerId)])
    } catch (err) {
      console.warn(`[chartlayers] preferences load failed for ${layerId}, using defaults`, err)
      return defaults
    }
  }
  try {
    const raw = window.localStorage.getItem(storageKey(layerId))
    return raw ? mergeDefaults(defaults, JSON.parse(raw)) : defaults
  } catch (err) {
    console.warn(`[chartlayers] localStorage load failed for ${layerId}, using defaults`, err)
    return defaults
  }
}

// Fire-and-forget, like preferences.ts's own saveStarredTimeframes — the settings panel's
// onChange has no way to await or surface an error.
export function saveLayerConfig<T>(layerId: string, config: T): void {
  if (hasFeature('preferences')) {
    savePreference(preferenceKey(layerId), config)
    return
  }
  try {
    window.localStorage.setItem(storageKey(layerId), JSON.stringify(config))
  } catch (err) {
    console.warn(`[chartlayers] localStorage save failed for ${layerId}`, err)
  }
}
