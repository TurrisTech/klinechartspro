import { afterAll, expect, test } from 'bun:test'

// What this file is here for: /preferences is guarded by an optimistic `revision`, and this
// module used to send the same If-Match from two overlapping flushes of the SAME TAB. The
// 500ms debounce reads like protection and is not — it spaces flushes, it does not stop one
// starting while another is still in the air, and panning fires a layout save per data load.
// The result was a PUT 412ing against its own tab, retried exactly once, and DROPPING the
// save outright if that retry also lost (which it does when several tabs are open, and this
// user runs a dozen). Both properties are asserted below against a fake server that models
// appstate.py's revision rules exactly.
//
// `window`/`localStorage` do not exist under bun, and config.ts reads window at MODULE LOAD
// (DATASOURCE_BASE_URL), so both are installed before the dynamic import rather than at the
// top of the file — a static import would be hoisted above them and crash on load.

const pristineFetch = globalThis.fetch
const hadWindow = 'window' in globalThis
const hadLocalStorage = 'localStorage' in globalThis
;(globalThis as Record<string, unknown>).window = {
  location: { href: 'http://localhost/', origin: 'http://localhost' }
}
;(globalThis as Record<string, unknown>).localStorage = {
  getItem: () => 'test-token',
  setItem: () => {},
  removeItem: () => {}
}

// A fake /preferences with appstate.py's semantics: absent If-Match is an unconditional
// upsert, "0" creates or updates a row still at 0, anything else must match exactly.
const server = {
  data: {} as Record<string, unknown>,
  revision: 7,
  putLatencyMs: 0,
  inFlight: 0,
  maxInFlight: 0,
  puts: 0,
  conflicts: 0,
  /** How many of the next GETs answer 503, and likewise PUTs. */
  getFailures: 0,
  putFailures: 0,
  /** Every PUT's If-Match, null where it carried none. */
  ifMatches: [] as (string | null)[],
  /** Runs before each PUT is applied — lets a test move the revision under the client. */
  beforePut: null as null | (() => void)
}

function resetServer(overrides: Partial<typeof server> = {}): void {
  Object.assign(server, {
    putLatencyMs: 0,
    inFlight: 0,
    maxInFlight: 0,
    puts: 0,
    conflicts: 0,
    getFailures: 0,
    putFailures: 0,
    ifMatches: [],
    beforePut: null,
    ...overrides
  })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const method = init?.method ?? 'GET'
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })

  if (method === 'GET') {
    if (server.getFailures > 0) {
      server.getFailures -= 1
      return json(503, { code: 'unavailable', detail: 'appstate database unreachable' })
    }
    return json(200, { data: server.data, revision: server.revision })
  }

  server.puts += 1
  server.inFlight += 1
  server.maxInFlight = Math.max(server.maxInFlight, server.inFlight)
  try {
    if (server.putLatencyMs > 0) await sleep(server.putLatencyMs)
    server.beforePut?.()
    const ifMatch = new Headers(init?.headers).get('If-Match')
    server.ifMatches.push(ifMatch)
    if (server.putFailures > 0) {
      server.putFailures -= 1
      return json(503, { code: 'unavailable', detail: 'appstate database unreachable' })
    }
    const body = JSON.parse(String(init?.body)) as { data: Record<string, unknown> }
    if (ifMatch !== null) {
      const expected = Number(ifMatch.replace(/"/g, ''))
      if (expected !== server.revision) {
        server.conflicts += 1
        return json(412, {
          code: 'conflict',
          detail: `If-Match revision ${expected} does not match current revision ${server.revision}`
        })
      }
    }
    server.data = body.data
    server.revision += 1
    return json(200, { data: server.data, revision: server.revision })
  } finally {
    server.inFlight -= 1
  }
}) as typeof fetch

afterAll(() => {
  // Put every global back. bun loads all test files into ONE process, so anything left here
  // leaks into every file evaluated after this one — `window` in particular would silently
  // switch other modules onto their browser path. client/tiles/isolation.test.ts guards the
  // fetch half of this; the other two are on us.
  globalThis.fetch = pristineFetch
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window
  if (!hadLocalStorage) delete (globalThis as Record<string, unknown>).localStorage
})

const { loadPreferences, savePreference, settled } = await import('./preferences')

// The debounce is a module constant; a test that wants a flush to have started must outwait it.
const DEBOUNCE_MS = 500

test('a save made while a write is in flight joins it instead of racing it', async () => {
  resetServer({ putLatencyMs: 400 })
  server.data = {}
  await loadPreferences()

  savePreference('first', 1)
  await sleep(DEBOUNCE_MS + 50) // the first PUT is now in the air, and slow

  savePreference('second', 2)
  await sleep(DEBOUNCE_MS + 50) // this debounce fires DURING that PUT
  await settled()

  // The property that matters: never two PUTs at once, so a tab cannot 412 against itself.
  expect(server.maxInFlight).toBe(1)
  expect(server.conflicts).toBe(0)
  // ...and neither change was lost to the other.
  expect(server.data).toEqual({ first: 1, second: 2 })
})

test('a conflict from another writer is re-read and replayed, not dropped', async () => {
  resetServer()
  server.data = { fromAnotherTab: 'keep me' }
  await loadPreferences()

  // Exactly one interloper: the first PUT of this flush finds the revision already moved.
  let moved = false
  server.beforePut = () => {
    if (moved) return
    moved = true
    server.revision += 1
  }

  savePreference('mine', 'landed')
  await sleep(DEBOUNCE_MS + 50)
  await settled()

  expect(server.conflicts).toBe(1)
  expect(server.puts).toBe(2) // the losing attempt, then the replay
  // The replay went on top of the winner's document rather than clobbering it.
  expect(server.data).toEqual({ fromAnotherTab: 'keep me', mine: 'landed' })
})

test('a conflict that never clears gives up after a bounded number of attempts', async () => {
  resetServer()
  server.data = {}
  await loadPreferences()
  server.beforePut = () => {
    server.revision += 1 // moves every single time: this flush can never win
  }

  const errors: unknown[] = []
  const realError = console.error
  console.error = (...args: unknown[]) => errors.push(args[0])
  try {
    savePreference('doomed', true)
    await sleep(DEBOUNCE_MS + 50)
    await settled()
  } finally {
    console.error = realError
  }

  // Bounded, and it stops — the point is that it neither spins forever nor quits after one.
  expect(server.puts).toBe(4)
  expect(server.conflicts).toBe(4)
  expect(errors).toHaveLength(1)
})

// The tests below each start from a page that has read nothing, so each gets its own copy of the
// module (bun keys a module by its specifier, query included). `config` is still shared.
let copies = 0
async function freshPreferences(): Promise<typeof import('./preferences')> {
  copies += 1
  return (await import(`./preferences?copy=${copies}`)) as typeof import('./preferences')
}

// A failed read or write is logged with console.warn; these tests make them on purpose.
async function quietly(run: () => Promise<void>): Promise<void> {
  const realWarn = console.warn
  console.warn = () => {}
  try {
    await run()
  } finally {
    console.warn = realWarn
  }
}

// The PUT replaces the whole stored document. One sent without having read it carries only the
// keys it changed, and the server's unconditional upsert stores just those: every workspace, alert
// and strategy is gone. A boot whose GET failed used to send exactly that on its first save.
test('a save after a failed read waits for the document instead of replacing it', async () => {
  await quietly(async () => {
    resetServer({ getFailures: 3 })
    server.data = { workspaces: 'theirs', alerts: 'theirs' }
    server.revision = 20
    const prefs = await freshPreferences()

    expect(await prefs.loadPreferences()).toEqual({}) // GET 1 fails
    expect(prefs.preferencesLoaded()).toBe(false)

    prefs.savePreference('starredTimeframes', ['1h'])
    await sleep(DEBOUNCE_MS + 50) // GET 2 fails: nothing is written, a retry is scheduled
    expect(server.puts).toBe(0)

    prefs.savePreference('starredTimeframes', ['1h', '4h'])
    await sleep(DEBOUNCE_MS + 50) // GET 3 fails too
    expect(server.puts).toBe(0)

    await prefs.settled() // the retry's GET 4 succeeds
    expect(server.ifMatches).toEqual(['"20"'])
    expect(server.data).toEqual({ workspaces: 'theirs', alerts: 'theirs', starredTimeframes: ['1h', '4h'] })
    expect(prefs.preferencesLoaded()).toBe(true)
  })
})

test('a conflict whose re-read fails waits too, and never writes unconditionally', async () => {
  await quietly(async () => {
    resetServer()
    server.data = { workspaces: 'theirs' }
    server.revision = 30
    const prefs = await freshPreferences()
    await prefs.loadPreferences()

    // Another tab writes first, and the GET that would adopt its document fails.
    let moved = false
    server.beforePut = () => {
      if (moved) return
      moved = true
      server.revision += 1
      server.data = { workspaces: 'theirs', fromAnotherTab: 'keep me' }
      server.getFailures = 1
    }

    prefs.savePreference('mine', 'landed')
    await sleep(DEBOUNCE_MS + 50)
    await prefs.settled()

    expect(server.ifMatches).not.toContain(null)
    expect(server.data).toEqual({ workspaces: 'theirs', fromAnotherTab: 'keep me', mine: 'landed' })
  })
})

test('a server error on the write keeps the change and tries it again', async () => {
  await quietly(async () => {
    resetServer({ putFailures: 1 })
    server.data = { workspaces: 'theirs' }
    server.revision = 40
    const prefs = await freshPreferences()
    await prefs.loadPreferences()

    prefs.savePreference('mine', 'landed')
    await sleep(DEBOUNCE_MS + 50)
    await prefs.settled()

    expect(server.puts).toBe(2)
    expect(server.data).toEqual({ workspaces: 'theirs', mine: 'landed' })
  })
})
