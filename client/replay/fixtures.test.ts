import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// The vendored parity fixtures must be byte-identical to wdashboard-server's. When the
// server repo is reachable (the workspace layout, or SERVER_ROOT) the sync script's --check
// mode is run -- covering the watch fixture (client/watch/fixtures) as well as these two;
// elsewhere (a CI without the sibling repo) the check is skipped, and the fixtures' own
// provenance line is asserted instead.

const here = resolve(import.meta.dir, '../..')
const root = process.env.SERVER_ROOT ?? resolve(here, '../../wdashboard-server/main')
const source = process.env.SERVER_FIXTURES ?? resolve(root, 'tests/sim/fixtures')

describe('engine fixtures', () => {
  test('are identical to the server copy when it is reachable', () => {
    if (!existsSync(source)) {
      console.warn(`fixtures.test: ${source} not found; skipping the identity check`)
      return
    }
    const proc = Bun.spawnSync(['bash', resolve(here, 'scripts/sync-engine-fixtures.sh'), '--check'], {
      env: { ...process.env, SERVER_ROOT: root, SERVER_FIXTURES: source }
    })
    if (proc.exitCode !== 0) console.error(proc.stderr.toString())
    expect(proc.exitCode).toBe(0)
  })
  test('carry their provenance', async () => {
    for (const name of ['engine_cases.json', 'boundaries.json']) {
      const doc = (await Bun.file(resolve(import.meta.dir, 'fixtures', name)).json()) as { $comment?: string }
      expect(String(doc.$comment)).toContain('GENERATED')
    }
  })
})
