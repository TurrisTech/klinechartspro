import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { cut, RAISE_BODY_LIMIT, RAISE_TITLE_LIMIT, raiseNotification } = await import('./notifications')

// `raiseNotification`: what reaches POST /notifications. A long alert name is cut to the server's
// limit rather than refused by it -- refused, the firing would never reach a phone.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test('cut keeps short text and ends a long one with an ellipsis at the limit', () => {
  expect(cut('short', 10)).toBe('short')
  expect(cut('x'.repeat(12), 10)).toBe(`${'x'.repeat(9)}…`)
})

test('a raise posts the spec, cut to the limits, with its key', async () => {
  let sent: { url: string; method: string; body: Record<string, unknown> } | null = null
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent = { url: String(url), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body)) }
    return new Response(
      JSON.stringify({
        notification: { id: 'k1', at: 5, title: 't', level: 'alert', body: 'b', source: 'alert', data: {}, seen: false },
        created: true,
        unseen: 1,
        serverTime: 6
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  }) as typeof fetch
  const remote = await raiseNotification({
    title: 'T'.repeat(300),
    body: 'B'.repeat(3000),
    level: 'alert',
    source: 'alert',
    data: { alertId: 'a1', eventAt: 5 },
    key: 'alert:a1:5'
  })
  expect(remote).toEqual({ remoteId: 'k1', at: 5, title: 't', body: 'b', level: 'alert', source: 'alert', data: {}, seen: false })
  const request = sent as unknown as { url: string; method: string; body: Record<string, unknown> }
  expect(request.method).toBe('POST')
  expect(request.url).toEndWith('/notifications')
  expect((request.body.title as string).length).toBe(RAISE_TITLE_LIMIT)
  expect((request.body.body as string).length).toBe(RAISE_BODY_LIMIT)
  expect(request.body.key).toBe('alert:a1:5')
  expect(request.body.data).toEqual({ alertId: 'a1', eventAt: 5 })
})
