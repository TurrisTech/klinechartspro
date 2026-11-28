import { dropStore, storeFor } from './store'
import type { SourceStore } from './types'

// Which bindings read which store, for the host (host.ts). Sources on any pane whose `key` is the
// same share one store, held in the page's registry (store.ts), where a template's `peekStore`
// finds it: the first binding to ask for a key makes it, every later one is handed that one, and
// it is dropped when the last binding on the wall that reads it is released.
//
// A binding counts as a reader from when the host FILES it on its pane until it is released --
// not from when it is made. The host makes a rebind's new binding and files it before it
// releases the old one, so a store both read (a rebind that keeps a source) survives the
// hand-over; a store dropped while the new binding still held it would be unreachable by key,
// and the pane would stay blank however much the orphan was filled.

/** What the table needs of a binding. */
export interface StoreReader {
  /** Set when the binding is released. A released reader holds no store, even one it is still
   * listed under. */
  readonly disposed: boolean
  readonly sources: readonly { readonly key: string }[]
}

export class StoreTable<R extends StoreReader> {
  private readonly readers = new Map<string, Set<R>>()

  /** The store under `key`: the one the page holds, else the one `create` makes. `create` runs
   * only for an absent key, so the first binding to read a key decides its class -- which is why
   * two sources sharing a key must name the same factory (README "Two bindings on one key"). */
  open<S extends SourceStore>(key: string, create: (key: string) => S): S {
    return storeFor(key, create)
  }

  /** `reader` reads the stores of its sources from now on. */
  file(reader: R): void {
    for (const { key } of reader.sources) {
      let held = this.readers.get(key)
      if (!held) {
        held = new Set()
        this.readers.set(key, held)
      }
      held.add(reader)
    }
  }

  /** `reader` reads the store under `key` no more. When no other reader does, the store is
   * dropped from the page, and this answers true. */
  release(key: string, reader: R): boolean {
    const held = this.readers.get(key)
    held?.delete(reader)
    if (held) for (const other of held) if (!other.disposed) return false
    this.readers.delete(key)
    dropStore(key)
    return true
  }

  /** Every live binding reading the store under `key`, in the order they were filed -- what a
   * fetch into that store changed, whichever binding asked for it. */
  readersOf(key: string): R[] {
    return [...(this.readers.get(key) ?? [])].filter((reader) => !reader.disposed)
  }
}
