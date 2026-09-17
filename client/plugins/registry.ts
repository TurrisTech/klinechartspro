import { createArevLabPlugin } from '../arevlab/plugin'
import { createBidAskPlugin } from '../bidask/plugin'
import { DEV_BOOKS } from '../books/api'
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
// read timeframes that are not the chart's; the book profiles, which are not a
// scalar-per-bar series at all; the AREV lab, which reads several registry rows into one
// pane and computes its own signal rules over them; and bid/ask, which is not an indicator
// the server computes but the quote half of the bars themselves.

export function builtinPlugins(): IndicatorPlugin[] {
  return [createRegistryPlugin(), createArevLabPlugin(), createMtfPlugin(), createMtf01Plugin(), createBooksPlugin(), createBooksPlugin(DEV_BOOKS), createBidAskPlugin()]
}
