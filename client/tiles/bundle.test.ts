import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The production bundle must not ask the browser for a file the build did not emit.
//
// This exists because it happened. `new Worker(new URL('./worker.ts', import.meta.url))` is
// emitted verbatim by Bun.build from an HTML entrypoint -- it is not followed, and no worker
// chunk is produced -- so the URL resolved to /worker.ts, hit nginx's SPA fallback, and the
// browser refused index.html as a module script. Every first pan of a page load then failed
// with "history fetch failed". Nothing in the type checker, the linter or the unit tests could
// see it: the source was valid, and the dev server *did* serve the TS, so only the production
// bundle was ever wrong.
//
// Skipped unless client-dist exists, so a checkout that has not run `bun run build:client`
// still runs green rather than failing for the wrong reason.

const dist = resolve(import.meta.dir, '../../client-dist')
const built = existsSync(dist)

describe.skipIf(!built)('the production bundle', () => {
  const bundles = built
    ? readdirSync(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(resolve(dist, f), 'utf8'))
    : []

  test('emits at least one javascript bundle', () => {
    expect(bundles.length).toBeGreaterThan(0)
  })

  test('references no .ts file at runtime', () => {
    // A surviving .ts URL means the bundler left a source path in shipped code; the server has
    // no such file and answers with the SPA, which the browser then rejects by MIME type.
    const offenders = bundles.flatMap((b) => [...b.matchAll(/["'`][^"'`]*\.ts["'`]/g)].map((m) => m[0]))
    expect(offenders).toEqual([])
  })

  test('constructs no Worker whose script the build did not emit', () => {
    const workers = bundles.flatMap((b) => [...b.matchAll(/new Worker\([^)]*\)/g)].map((m) => m[0]))
    for (const w of workers) {
      const url = w.match(/["'`]([^"'`]+)["'`]/)?.[1]
      expect(url, `Worker built from a non-literal URL: ${w}`).toBeDefined()
      expect(existsSync(resolve(dist, (url ?? '').replace(/^\//, '')))).toBe(true)
    }
  })
})
