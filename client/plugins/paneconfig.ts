import { permuteByIndex } from '../../src/state/paneOrder'
import type { SettingsField } from '../chartlayers/settings'

// Settings a plugin keeps PER WALL PANE -- which timeframes an MTF overlay draws, the AREV lab's
// rules, a layer's line styles -- and everything that follows from having them: the legend
// gear's panel, the indicator manager's inline fields, a rebind when one changes, the wall
// document, and panes changing places. The host owns all of it (host.ts). A plugin only
// declares what its settings ARE (`PaneConfig`) and reads the pane's config off its
// `BindContext`.
//
// Until 2026-10-11 each of the five plugins with settings carried its own copy of this: a
// config and a revision per pane index, a panel opener, the manager's read/write, paneState
// hydrate/snapshot, a signature folding in the revision, and a dispose that closed the panel --
// six optional members of `IndicatorPlugin`, plus a field of its own in `client/layout.ts` and a
// line in `client/index.ts` per plugin.

/** Where a pane's entry in the wall document keeps a config: a field of its own (`'mtf'`), or
 * one key inside a field several configs share (`['ly', 'levels']`). Saved workspaces are
 * written under these, so they are a compatibility surface: never rename one. */
export type PaneDocPath = string | readonly [string, string]

/** What one kind of per-pane settings is. Methods rather than function properties, so a
 * `PaneConfig<MtfConfig>` is a `PaneConfig` wherever the host keeps them together. */
export interface PaneConfig<T extends object = object> {
  /** The templates these settings belong to. Several templates may share one config (the
   * divergence's sub-pane and price-pane halves are one setting). */
  readonly templates: readonly string[]
  readonly doc: PaneDocPath
  /** The settings panel's title; the pane's ticker and timeframe are appended. */
  readonly title: string
  /** What the gear's panel and the indicator manager draw. */
  readonly fields: SettingsField[]
  readonly defaults: T
  /** An edited config made drawable: every lever legal, before any binding sees it -- the
   * panel's number inputs commit every keystroke. */
  normalise(config: T): T
  /** The wall document's form: only what differs from the defaults, `undefined` when nothing
   * does (the pane then stores nothing at all). */
  toStored(config: T): unknown
  /** The document's form read back, every value validated; `undefined` when nothing usable is
   * there, which reads as "never configured". */
  fromStored(stored: unknown): T | undefined
  /** What a pane never configured draws with. Omitted: the defaults. */
  fallback?(): T
}

/** A typed `PaneConfig`, widened to the host's view of it. */
export function paneConfig<T extends object>(spec: PaneConfig<T>): PaneConfig {
  return spec as unknown as PaneConfig
}

/** One pane's plugin settings as the wall document stores them: `{ mtf: …, ly: { levels: … } }`. */
export type PaneDoc = Record<string, unknown>

function docGet(doc: PaneDoc | undefined, path: PaneDocPath): unknown {
  if (!doc) return undefined
  if (typeof path === 'string') return doc[path]
  const field = doc[path[0]]
  return field && typeof field === 'object' && !Array.isArray(field) ? (field as Record<string, unknown>)[path[1]] : undefined
}

function docSet(doc: PaneDoc, path: PaneDocPath, value: unknown): void {
  if (typeof path === 'string') {
    doc[path] = value
    return
  }
  doc[path[0]] ??= {}
  ;(doc[path[0]] as Record<string, unknown>)[path[1]] = value
}

function pathId(path: PaneDocPath): string {
  return typeof path === 'string' ? path : `${path[0]}.${path[1]}`
}

/** Every pane's settings for every config the wall's plugins declare, by pane INDEX -- the
 * position the wall document stores them under. Those positions are not fixed: panes change
 * places (`reorder`), which is why `hydrate` REPLACES rather than merges. */
export class PaneConfigStore {
  private readonly configs = new Map<PaneConfig, Record<number, object>>()
  private readonly revs = new Map<PaneConfig, Record<number, number>>()
  /** Stored values under a path this store knows of but no live config owns -- a plugin whose
   * feature this server does not advertise, or whose registration failed -- carried verbatim
   * so the next save does not drop a pane's settings because one server could not draw them. */
  private carried: Record<number, Record<string, { path: PaneDocPath; value: unknown }>> = {}

  /** `owned`: the configs of the plugins that registered. `known`: every document path any
   * plugin of this build declares, registered or not. */
  constructor(
    private readonly owned: readonly PaneConfig[],
    private readonly known: readonly PaneDocPath[] = owned.map((c) => c.doc)
  ) {
    for (const config of owned) {
      this.configs.set(config, {})
      this.revs.set(config, {})
    }
  }

  /** The pane's config: its own, else what an unconfigured pane draws with. */
  read<T extends object>(config: PaneConfig<T>, paneIndex: number): T {
    const own = this.configs.get(config as PaneConfig)?.[paneIndex] as T | undefined
    return own ?? config.fallback?.() ?? config.defaults
  }

  /** Bumped whenever the pane's config may have changed; part of every binding's signature. */
  rev(config: PaneConfig, paneIndex: number): number {
    return this.revs.get(config)?.[paneIndex] ?? 0
  }

  write(config: PaneConfig, paneIndex: number, next: object): void {
    const configs = this.configs.get(config)
    const revs = this.revs.get(config)
    if (!configs || !revs) return
    configs[paneIndex] = config.normalise(next)
    revs[paneIndex] = (revs[paneIndex] ?? 0) + 1
  }

  /** REPLACES every pane's settings with the document's (an index absent there has none
   * afterwards). Every index whose config may have changed is bumped, so a binding there is
   * rebuilt rather than drawn from the old one. */
  hydrate(docs: Readonly<Record<number, PaneDoc | undefined>>): void {
    for (const config of this.owned) {
      const configs = this.configs.get(config) as Record<number, object>
      const revs = this.revs.get(config) as Record<number, number>
      const touched = new Set([...Object.keys(configs), ...Object.keys(docs)].map(Number))
      for (const index of Object.keys(configs)) delete configs[Number(index)]
      for (const [index, doc] of Object.entries(docs)) {
        const decoded = config.fromStored(docGet(doc, config.doc))
        if (decoded) configs[Number(index)] = config.normalise(decoded)
      }
      for (const index of touched) revs[index] = (revs[index] ?? 0) + 1
    }
    const ownedPaths = new Set(this.owned.map((c) => pathId(c.doc)))
    const carried: typeof this.carried = {}
    for (const [index, doc] of Object.entries(docs)) {
      for (const path of this.known) {
        if (ownedPaths.has(pathId(path))) continue
        const value = docGet(doc, path)
        if (value === undefined) continue
        carried[Number(index)] ??= {}
        carried[Number(index)][pathId(path)] = { path, value }
      }
    }
    this.carried = carried
  }

  /** Every pane's settings as the document stores them; a pane with nothing stored is absent. */
  snapshot(): Record<number, PaneDoc> {
    const out: Record<number, PaneDoc> = {}
    const into = (index: number): PaneDoc => {
      out[index] ??= {}
      return out[index]
    }
    for (const config of this.owned) {
      for (const [index, value] of Object.entries(this.configs.get(config) ?? {})) {
        const stored = config.toStored(value)
        if (stored !== undefined) docSet(into(Number(index)), config.doc, stored)
      }
    }
    for (const [index, entries] of Object.entries(this.carried)) {
      for (const { path, value } of Object.values(entries)) docSet(into(Number(index)), path, value)
    }
    return out
  }

  /** Panes changed places (`order[newIndex] = oldIndex`): each pane's settings move with it. */
  reorder(order: readonly number[]): void {
    this.hydrate(permuteByIndex(this.snapshot(), order))
  }
}
