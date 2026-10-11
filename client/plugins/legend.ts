import type { SourceStore } from './types'

// What a plugin indicator's legend says while its data is not in hand. Eight plugins used to
// spell this out for themselves, in slightly different ways -- most never said a server was
// still computing a series, which only the registry's legend did.

/** `name · error`, `· loading`, `· computing 40%` (a server still building the series) or
 * `· queued` -- the worst of `stores`, in that order -- or null once every store is ready,
 * when the plugin says what it draws. A store not there yet is loading. */
export function phaseLabel(name: string, stores: ReadonlyArray<SourceStore | undefined>): string | null {
  if (stores.some((store) => store?.phase === 'error')) return `${name} · error`
  if (stores.some((store) => !store || store.phase === 'idle' || store.phase === 'loading')) return `${name} · loading`
  const building = stores.find((store) => store?.phase === 'replaying')
  if (building) return `${name} · computing${building.progress != null ? ` ${Math.round(building.progress * 100)}%` : '…'}`
  if (stores.some((store) => store?.phase === 'queued')) return `${name} · queued`
  return null
}
