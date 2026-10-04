// A plugin's per-pane settings are kept by pane INDEX -- the position the wall document stores
// them under (client/layout.ts). Those positions are not fixed: panes can change places on the
// wall, and the host then hands each plugin its own settings re-keyed (PluginHost.reorderPanes),
// which is why `paneState.hydrate` REPLACES rather than merges. This is that replace, shared by
// every plugin that keeps a config and a revision per index.

/** Replace every pane's config with `next`'s, normalising each stored one. The revision of
 * every index whose config may have changed -- the ones it had before and the ones it has
 * now -- is bumped, so a binding there is rebuilt rather than drawn from the old config. */
export function replacePaneConfigs<T>(
  configs: Record<number, T>,
  revs: Record<number, number>,
  next: Record<number, unknown>,
  normalise: (stored: unknown) => T
): void {
  const touched = new Set([...Object.keys(configs), ...Object.keys(next)].map(Number))
  for (const index of Object.keys(configs)) delete configs[Number(index)]
  for (const [index, stored] of Object.entries(next)) {
    if (stored) configs[Number(index)] = normalise(stored)
  }
  for (const index of touched) revs[index] = (revs[index] ?? 0) + 1
}
