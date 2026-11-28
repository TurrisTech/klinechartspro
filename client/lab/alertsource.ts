import type { StrategySource } from '../alerts/strategies'
import { StrategyEntryEngine } from './alertentries'
import { savedStrategies, savedStrategyName, sharedStrategyStore } from './store'

/** The Strategy Lab's saved strategies, as the alerts read them (alerts/strategies.ts). */
export const labStrategies: StrategySource = {
  load: () => sharedStrategyStore().then(() => undefined),
  list: savedStrategies,
  name: savedStrategyName,
  reader: (now) => new StrategyEntryEngine(undefined, undefined, now)
}
