import { expect, test } from 'bun:test'

// Bun loads every test file into one process, so a file that assigns `globalThis.fetch` at
// module load leaks that stub into every file evaluated after it. `client/levels/` sorts before
// `client/tiles/`, and when its stub had no `afterAll` the tile parity tests captured it as
// their "real" fetch and sent 13 dev-server requests into the levels fixture — failing only in
// the full suite, only after a merge changed the ordering, and never when run alone.
//
// This file sorts after `levels/` and before the rest of `tiles/`, so it is evaluated exactly
// where the leak would land. It is cheap and it is the only thing standing between a future
// module-load stub and another afternoon of that.
//
// The check is "is it still the engine's own function", not identity against a captured value:
// there is nothing this file can capture that is guaranteed to run before the leaking one. A
// native binding stringifies to `[native code]`; any replacement is a closure defined in a test,
// which stringifies to its own source.
//
// If this fails: some earlier test file replaced the global and did not put it back. Capture the
// original in that file *before* stubbing and restore that exact value in an `afterAll` — not
// `Bun.fetch`, which is a different function object, and not whatever was installed on entry,
// which just passes the leak along.

test('no earlier test file has left globalThis.fetch replaced', () => {
  expect(globalThis.fetch.toString()).toContain('native code')
})
