import { apiSend } from '../config'
import { ownerHeaders } from '../owner'
import type { Watch, WatchDraft, WatchSource } from './types'

// The `/watch` wire (wdashboard-server `wdashboard_server/watch/routes.py`). Every mutating
// call answers with the whole watch, so the client replaces its copy rather than
// reconciling a delta -- the same contract `/sim` uses.
//
// There is no client-side evaluation behind any of this. A watch is created here and
// evaluated in the server, which is what lets it fire with this tab closed.

async function call<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const { data } = await apiSend<T>(method, path, { body, headers: ownerHeaders() })
  return data
}

export interface SourceCatalogue {
  sources: WatchSource[]
  /** The operators the server's condition language accepts. Published so this client never
   * carries a second copy of the list. */
  ops: string[]
  maxWatches: number
}

export const watchApi = {
  sources: () => call<SourceCatalogue>('GET', '/watch/sources'),
  list: () => call<{ watches: Watch[] }>('GET', '/watch').then((r) => r.watches),
  create: (draft: WatchDraft) =>
    call<{ watch: Watch }>('POST', '/watch', draft).then((r) => r.watch),
  update: (id: string, patch: Partial<WatchDraft>) =>
    call<{ watch: Watch }>('PATCH', `/watch/${id}`, patch).then((r) => r.watch),
  arm: (id: string) => call<{ watch: Watch }>('POST', `/watch/${id}/arm`).then((r) => r.watch),
  remove: (id: string) => call<{ deleted: string }>('DELETE', `/watch/${id}`)
}
