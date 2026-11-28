import { afterAll, beforeEach, describe, expect, test } from 'bun:test'

// What a server answer decodes to (config.ts `decodeBody`, behind apiGet and apiSend), and what
// the chart does at boot when /capabilities is not a capabilities document. A 200 whose body
// is not JSON -- a proxy's HTML page, a cut-off body -- used to come back as `null` typed as the
// caller's T, and `capabilities()` then threw on its first `.features`, which stopped the page
// booting rather than falling back to the defaults the loader promises.
//
// config.ts reads `window` at module load, so the globals go in before the dynamic imports;
// every global is put back afterwards, because bun runs every test file in one process.

const pristine = {
  fetch: globalThis.fetch,
  hadWindow: 'window' in globalThis,
  window: (globalThis as Record<string, unknown>).window,
  hadLocalStorage: 'localStorage' in globalThis,
  localStorage: (globalThis as Record<string, unknown>).localStorage
}
if (!pristine.hadWindow) {
  ;(globalThis as Record<string, unknown>).window = { location: { href: 'http://localhost/', origin: 'http://localhost' } }
}
;(globalThis as Record<string, unknown>).localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }

/** The next answer, by path suffix: a status, a body as sent, and its content type. */
let answers: Record<string, { status: number; body: string; type: string }> = {}
const HTML = '<!doctype html><title>Gateway</title>'
const json = (status: number, value: unknown) => ({ status, body: JSON.stringify(value), type: 'application/json' })
const page = (status: number) => ({ status, body: HTML, type: 'text/html' })

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const path = new URL(input instanceof Request ? input.url : String(input)).pathname
  const match = Object.keys(answers).find((suffix) => path.endsWith(suffix))
  const answer = match ? answers[match] : json(404, { code: 'not_found', detail: path })
  // A 204 may not carry a body at all.
  return new Response(answer.status === 204 ? null : answer.body, { status: answer.status, headers: { 'Content-Type': answer.type } })
}) as typeof fetch

const config = await import('./config')
let copies = 0
/** A fresh capabilities module: its loader memoises the first answer for the page's life. */
async function freshCapabilities(): Promise<typeof import('./capabilities')> {
  copies += 1
  return (await import(`./capabilities?copy=${copies}`)) as typeof import('./capabilities')
}

afterAll(() => {
  globalThis.fetch = pristine.fetch
  if (pristine.hadWindow) (globalThis as Record<string, unknown>).window = pristine.window
  else delete (globalThis as Record<string, unknown>).window
  if (pristine.hadLocalStorage) (globalThis as Record<string, unknown>).localStorage = pristine.localStorage
  else delete (globalThis as Record<string, unknown>).localStorage
})

beforeEach(() => {
  answers = {}
})

async function rejection(promise: Promise<unknown>): Promise<InstanceType<typeof config.OhlcvApiError>> {
  try {
    await promise
  } catch (err) {
    if (err instanceof config.OhlcvApiError) return err
    throw err
  }
  throw new Error('expected a rejection')
}

describe('a server answer', () => {
  test('JSON is the data, on a read and on a write', async () => {
    answers['/instrument'] = json(200, { symbol: 'EURUSD' })
    answers['/preferences'] = json(200, { data: {}, revision: 1 })
    expect(await config.apiGet<unknown>('/instrument')).toEqual({ symbol: 'EURUSD' })
    expect((await config.apiSend('PUT', '/preferences', { body: { data: {} } })).data).toEqual({ data: {}, revision: 1 })
  })

  test('a success that is not JSON is an error, never null handed on as the data', async () => {
    answers['/instrument'] = page(200)
    answers['/preferences'] = page(200)
    const read = await rejection(config.apiGet('/instrument'))
    expect([read.status, read.code]).toEqual([200, 'not_json'])
    expect(read.message).toBe('200 from /instrument is not JSON')
    const write = await rejection(config.apiSend('PUT', '/preferences', { body: { data: {} } }))
    expect([write.status, write.code]).toEqual([200, 'not_json'])
  })

  test('an empty body is null, as it always was: a 204, and a 200 with nothing in it', async () => {
    answers['/auth/logout'] = { status: 204, body: '', type: 'text/plain' }
    answers['/instrument'] = { status: 200, body: '', type: 'application/json' }
    expect((await config.apiSend('POST', '/auth/logout')).data).toBeNull()
    expect(await config.apiGet<unknown>('/instrument')).toBeNull()
  })

  test("an error status carries the server's own envelope, or names the status when it sent a page", async () => {
    answers['/instrument'] = json(404, { code: 'not_found', detail: 'no such instrument', field: 'symbol' })
    const own = await rejection(config.apiGet('/instrument'))
    expect([own.status, own.code, own.message, own.field]).toEqual([404, 'not_found', 'no such instrument', 'symbol'])

    answers['/instrument'] = page(502)
    const proxied = await rejection(config.apiGet('/instrument'))
    expect([proxied.status, proxied.code, proxied.message]).toEqual([502, 'internal', '502 from /instrument'])
  })
})

describe('booting on /capabilities', () => {
  const quietly = async <T>(run: () => Promise<T>): Promise<T> => {
    const warn = console.warn
    console.warn = () => {}
    try {
      return await run()
    } finally {
      console.warn = warn
    }
  }

  test("the server's document is what the chart reads", async () => {
    const caps = await freshCapabilities()
    answers['/capabilities'] = json(200, { ...caps.capabilities(), features: ['levels'] })
    await caps.loadCapabilities()
    expect(caps.hasFeature('levels' as never)).toBe(true)
  })

  for (const [name, answer] of [
    ['an HTML page with a 200', page(200)],
    ['an empty 200', { status: 200, body: '', type: 'application/json' }],
    ['a 200 that is not a document', json(200, ['not', 'a', 'document'])],
    ['a server error', json(503, { code: 'unavailable', detail: 'starting' })]
  ] as const) {
    test(`${name} boots on the conservative defaults`, async () => {
      const caps = await freshCapabilities()
      const defaults = caps.capabilities()
      answers['/capabilities'] = answer
      expect(await quietly(() => caps.loadCapabilities())).toBe(defaults)
      // What the boot reads next, none of which may throw.
      expect(caps.capabilities()).toBe(defaults)
      expect(caps.hasFeature('levels' as never)).toBe(false)
      expect(caps.levelsCoverageFor('oanda', 'EURUSD')).toBeUndefined()
    })
  }
})
