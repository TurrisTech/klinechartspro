import { apiSend } from '../../config'
import { ownerHeaders } from '../../owner'
import type { ChannelAnswer, ChannelEntry, ChannelsApi, DiscoverAnswer } from './types'

// `/notifications/channels` over HTTP, owner-scoped like every other `/notifications` call. An
// HTTP error (a 400 for a required field missing, a 503 for a store that could not write) throws
// `OhlcvApiError` with the server's detail as its message; a vendor's refusal does not throw.

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const { data } = await apiSend<T>(method, path, { body, headers: ownerHeaders() })
  return data
}

const path = (kind: string, action = ''): string =>
  `/notifications/channels/${encodeURIComponent(kind)}${action ? `/${action}` : ''}`

export class HttpChannelsApi implements ChannelsApi {
  async list(): Promise<ChannelEntry[]> {
    return (await call<{ channels: ChannelEntry[] }>('GET', '/notifications/channels')).channels
  }

  async save(kind: string, enabled: boolean, config: Record<string, string>): Promise<ChannelEntry> {
    return (await call<{ channel: ChannelEntry }>('PUT', path(kind), { enabled, config })).channel
  }

  async remove(kind: string): Promise<ChannelEntry> {
    return (await call<{ channel: ChannelEntry }>('DELETE', path(kind))).channel
  }

  check(kind: string, config?: Record<string, string>): Promise<ChannelAnswer> {
    return call<ChannelAnswer>('POST', path(kind, 'check'), config ? { config } : {})
  }

  test(kind: string, config?: Record<string, string>): Promise<ChannelAnswer> {
    return call<ChannelAnswer>('POST', path(kind, 'test'), config ? { config } : {})
  }

  discover(kind: string, field: string, config?: Record<string, string>): Promise<DiscoverAnswer> {
    return call<DiscoverAnswer>('POST', path(kind, 'discover'), config ? { field, config } : { field })
  }
}
