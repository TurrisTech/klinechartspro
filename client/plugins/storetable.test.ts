import { describe, expect, test } from 'bun:test'
import { peekStore, WindowStore } from './store'
import { type StoreReader, StoreTable } from './storetable'

// Which bindings read which store: a store lives while some filed, unreleased binding reads it.

interface Reader extends StoreReader {
  name: string
  disposed: boolean
}

function reader(name: string, keys: string[]): Reader {
  return { name, disposed: false, sources: keys.map((key) => ({ key })) }
}

let n = 0
/** A key no other test has used: the page's store registry is shared by every test file. */
function freshKey(): string {
  n++
  return `storetable-test|${n}`
}

describe('StoreTable', () => {
  test('the first reader of a key makes its store; later ones are handed the same one', () => {
    const table = new StoreTable<Reader>()
    const key = freshKey()
    const made: string[] = []
    const first = table.open(key, (k) => {
      made.push(k)
      return new WindowStore(k)
    })
    const second = table.open(key, (): typeof first => {
      throw new Error('not asked again')
    })
    expect(second).toBe(first)
    expect(made).toEqual([key])
    expect(peekStore(key)).toBe(first)
  })

  test('a store shared by two readers outlives the first and is dropped with the last', () => {
    const table = new StoreTable<Reader>()
    const key = freshKey()
    const store = table.open(key, (k) => new WindowStore(k))
    const a = reader('a', [key])
    const b = reader('b', [key])
    table.file(a)
    table.file(b)
    expect(table.readersOf(key).map((r) => r.name)).toEqual(['a', 'b'])
    a.disposed = true
    expect(table.release(key, a)).toBe(false)
    expect(peekStore(key)).toBe(store)
    expect(table.readersOf(key).map((r) => r.name)).toEqual(['b'])
    b.disposed = true
    expect(table.release(key, b)).toBe(true)
    expect(peekStore(key)).toBeUndefined()
    expect(table.readersOf(key)).toEqual([])
  })

  test('a rebind filed before the binding it replaces is released keeps the store', () => {
    const table = new StoreTable<Reader>()
    const key = freshKey()
    const store = table.open(key, (k) => new WindowStore(k))
    const old = reader('old', [key])
    table.file(old)
    const next = reader('next', [key])
    table.file(next)
    old.disposed = true
    expect(table.release(key, old)).toBe(false)
    expect(peekStore(key)).toBe(store)
  })

  test('a released reader still listed under a key holds nothing there', () => {
    const table = new StoreTable<Reader>()
    const key = freshKey()
    table.open(key, (k) => new WindowStore(k))
    const stuck = reader('stuck', [key])
    const other = reader('other', [key])
    table.file(stuck)
    table.file(other)
    // Released, but its release never reached this key (a disposer threw before it).
    stuck.disposed = true
    expect(table.readersOf(key).map((r) => r.name)).toEqual(['other'])
    other.disposed = true
    expect(table.release(key, other)).toBe(true)
    expect(peekStore(key)).toBeUndefined()
  })

  test('only the keys a reader reads are its: another key is untouched by its release', () => {
    const table = new StoreTable<Reader>()
    const mine = freshKey()
    const theirs = freshKey()
    table.open(mine, (k) => new WindowStore(k))
    const kept = table.open(theirs, (k) => new WindowStore(k))
    const a = reader('a', [mine])
    const b = reader('b', [theirs])
    table.file(a)
    table.file(b)
    a.disposed = true
    expect(table.release(mine, a)).toBe(true)
    expect(peekStore(theirs)).toBe(kept)
    expect(table.readersOf(theirs).map((r) => r.name)).toEqual(['b'])
  })
})
