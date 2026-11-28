# client/dev — the dev server and live-test helpers

Runs in Bun, never in the browser bundle. Moved here from the client root on 2026-11-28.

| module | role |
|---|---|
| `serve.ts` | The dev server (`bun run dev:client`, `scripts/dev-client.sh`): serves `../index.html` with hot reload, proxies `/ohlcv` to a wdashboard-server and `/tiles` to a bucket or a local directory. |
| `devproxy.ts` | What the `/ohlcv` proxy forwards: headers, and a websocket close code the browser may see. |
| `devtiles.ts` | Where `/tiles` comes from (`TILES_UPSTREAM` or `TILES_ROOT`) and the handler that serves it. |
| `livetest.ts` | The login for the opt-in tests that call a real server (`OHLCV_API_TOKEN`). |
