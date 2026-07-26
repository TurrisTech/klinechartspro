import { mkdir, rm } from 'node:fs/promises'

import { SveltePlugin } from 'bun-plugin-svelte'

const rootDirectory = new URL('../', import.meta.url).pathname
const outputDirectory = new URL('../dist/', import.meta.url).pathname

interface BundleFiles {
  css: Bun.BuildArtifact
  javascript: Bun.BuildArtifact
  sourceMap: Bun.BuildArtifact
}

async function bundle(format: 'cjs' | 'esm'): Promise<BundleFiles> {
  const result = await Bun.build({
    entrypoints: [`${rootDirectory}src/index.ts`],
    target: 'browser',
    format,
    external: ['klinecharts'],
    sourcemap: 'external',
    plugins: [SveltePlugin({ development: false })]
  })

  const javascript = result.outputs.find((output) => output.kind === 'entry-point')
  const css = result.outputs.find((output) => output.type.startsWith('text/css'))
  const sourceMap = result.outputs.find((output) => output.kind === 'sourcemap')

  if (!javascript || !css || !sourceMap) {
    throw new Error(`Bun ${format.toUpperCase()} build did not emit JavaScript, CSS and a sourcemap`)
  }

  return { css, javascript, sourceMap }
}

async function writeJavaScript(
  outputName: string,
  javascript: Bun.BuildArtifact,
  sourceMap: Bun.BuildArtifact
): Promise<void> {
  const mapName = `${outputName}.map`
  const code = `${await javascript.text()}\n//# sourceMappingURL=${mapName}\n`
  const map = JSON.parse(await sourceMap.text()) as Record<string, unknown>
  map.file = outputName

  await Promise.all([
    Bun.write(`${outputDirectory}${outputName}`, code),
    Bun.write(`${outputDirectory}${mapName}`, JSON.stringify(map))
  ])
}

await rm(outputDirectory, { recursive: true, force: true })
await mkdir(outputDirectory, { recursive: true })

const esm = await bundle('esm')
const commonjs = await bundle('cjs')

await Promise.all([
  writeJavaScript('klinecharts-pro.js', esm.javascript, esm.sourceMap),
  writeJavaScript('klinecharts-pro.cjs', commonjs.javascript, commonjs.sourceMap),
  Bun.write(`${outputDirectory}klinecharts-pro.css`, esm.css)
])

console.log('Built ESM, CommonJS and CSS bundles with Bun')
