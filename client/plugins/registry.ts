import { createBooksPlugin } from '../books/plugin'
import { createMtf01Plugin } from '../mtf01/plugin'
import { createMtfPlugin } from '../mtf/plugin'
import { createRegistryPlugin } from '../tsregistry/plugin'
import type { IndicatorPlugin } from './types'

// The built-in indicator plugins, in the order their picker groups appear. Built per mount
// (each holds per-pane state), which is why this is a factory and not a constant.
//
// There used to be one plugin per family here -- indicators, arev, krev -- each with its own
// templates. All three are now rows in the server's timeseries indicator registry and are
// mounted by the single `registry` plugin, which reads `GET /indicators/registry` and builds
// a template per row: adding an indicator is a row, not a module. What is left beside it is
// what the registry deliberately does not cover: the multi-timeframe overlays, whose sources
// read timeframes that are not the chart's, and the book profiles, which are not a
// scalar-per-bar series at all.

export function builtinPlugins(): IndicatorPlugin[] {
  return [createRegistryPlugin(), createMtfPlugin(), createMtf01Plugin(), createBooksPlugin()]
}
