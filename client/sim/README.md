# client/sim — the fill engine

The browser's port of `wdashboard_server/sim/engine.py`, for bar replay and the Strategy Lab's
simulated trades. Moved out of `client/replay/` on 2026-11-28.

| module | role |
|---|---|
| `engine.ts` | PURE. The port of `engine.py`: same types (the wire's `SimOrder`/`SimTrade`), same events, same ids (`o1`, `t2`, …), no I/O. Parity asserted by running `fixtures/engine_cases.json` — the *same file* the Python suite runs. |
| `bidask.ts` | `toBidAsk`: a bar as the engine folds it -- its bid and ask, or its mid on both sides where the store has no quotes. One conversion for the replay's walk and the Lab. |
| `fixtures.test.ts` | The vendored parity fixtures (this folder's `engine_cases.json`, `../time/fixtures/boundaries.json`) are byte-identical to the server's (`scripts/sync-engine-fixtures.sh --check`). |
