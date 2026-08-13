// Production bundle for the wdashboard client (client/), emitted to client-dist/.
//
// Separate from scripts/build.ts, which builds the redistributable library: this one is an
// application build — the library is inlined rather than left external, and the HTML entry
// point is processed so asset URLs are rewritten to the hashed filenames.
//
// `bun build` on its own cannot do this: bunfig.toml registers bun-plugin-svelte only under
// [serve.static], which the dev server reads and the bundler does not, so a plain
// `bun build client/index.html` copies ChartPro.svelte through as an unprocessed asset.
import { rm } from 'node:fs/promises'

import { SveltePlugin } from 'bun-plugin-svelte'

const rootDirectory = new URL('../', import.meta.url).pathname
const outputDirectory = `${rootDirectory}client-dist`

// The path the app is served under, baked into the emitted asset URLs. Root by default,
// matching the dev/prod route where the client sits at "/" alongside the server's /ohlcv on
// the same host; override for a sub-path deployment (e.g. BASE_PATH=/klinechartpro/).
const basePath = process.env.BASE_PATH ?? '/'

await rm(outputDirectory, { recursive: true, force: true })

const result = await Bun.build({
  entrypoints: [`${rootDirectory}client/index.html`],
  outdir: outputDirectory,
  target: 'browser',
  format: 'esm',
  minify: true,
  sourcemap: 'linked',
  publicPath: basePath.endsWith('/') ? basePath : `${basePath}/`,
  naming: { chunk: '[name]-[hash].[ext]', asset: '[name]-[hash].[ext]' },
  plugins: [SveltePlugin({ development: false })]
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error('client build failed')
}

for (const output of result.outputs) {
  console.log(`  ${output.path.replace(rootDirectory, '')}  ${(output.size / 1024).toFixed(1)} KB`)
}
console.log(`Built client bundle into client-dist/ (base path ${basePath})`)
