// bun-plugin-svelte with Svelte's `preserveWhitespace` forced off.
//
// bun-plugin-svelte derives the Svelte compiler option from the bundler's minify flag —
// `preserveWhitespace: !minify.whitespace` (bun-plugin-svelte/src/options.ts) — and Bun's dev
// server hands plugins a stub bundler config rather than the real one (FIXME in
// bun-plugin-svelte/src/index.ts). So `minify` is unset there, `preserveWhitespace` is always
// true, and bits-ui's Popover then renders nothing: state flips to open, but the `{#if}` gating
// the content never re-renders. That kills the timeframe dropdown and the drawing-toolbar menus.
//
// Only used by the dev server, via bunfig.toml. Production builds construct SveltePlugin
// directly with `minify: true` (scripts/build.ts, scripts/build-client.ts), so they already get
// preserveWhitespace: false and are unaffected.
//
// Remove once bun-plugin-svelte stops coupling the two, or exposes preserveWhitespace directly
// — `compilerOptions` only forwards customElement/runes/modernAst/namespace today.
import type { BunPlugin } from 'bun'
import { SveltePlugin } from 'bun-plugin-svelte'

const inner = SveltePlugin()

const plugin: BunPlugin = {
  name: 'bun-plugin-svelte-preserve-whitespace-off',
  setup(builder) {
    // `PluginBuilder.config` is declared as an always-present, complete `BuildConfig`, which
    // is exactly what the dev server does not hand us — hence the `??=`. Replacing the field
    // rather than intersecting with it is what makes both lines typecheck: intersected, the
    // declared `BuildConfig` survives and `{}` is missing `entrypoints`.
    const target = builder as Omit<typeof builder, 'config'> & { config?: { minify?: unknown } }
    target.config ??= {}
    target.config.minify = { whitespace: true }
    return inner.setup(builder)
  }
}

export default plugin
