import { createArevPlugin } from '../arev/plugin'
import { createIndicatorsPlugin } from '../indicators/plugin'
import { createKrevPlugin } from '../krev/plugin'
import { createMtf01Plugin } from '../mtf01/plugin'
import { createMtfPlugin } from '../mtf/plugin'
import type { IndicatorPlugin } from './types'

// The built-in indicator plugins, in the order their picker groups appear. Adding a plugin
// is one module shaped like these plus an entry here; the host does the rest. Built per
// mount (each holds per-pane state), which is why this is a factory and not a constant.

export function builtinPlugins(): IndicatorPlugin[] {
  return [createIndicatorsPlugin(), createArevPlugin(), createKrevPlugin(), createMtfPlugin(), createMtf01Plugin()]
}
