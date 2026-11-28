import { expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { TailCache } = await import('./data')

// A span read up to "now" ends on a bar still forming, which a closed-bars read leaves out.
// Extending the span forward must read that bar again, or it is missing for good.
test('extending a span forward reads its tail again, so a bar that was forming arrives', async () => {
  let now = 10
  const reads: Array<[number, number]> = []
  // Bars open every 1 (ms, for the test); a bar is served once it has closed (open + 1 <= now).
  const fetch = async (from: number, to: number) => {
    reads.push([from, to])
    const out: number[] = []
    for (let open = Math.ceil(from); open < to; open++) if (open + 1 <= now) out.push(open)
    return out
  }
  const cache = new TailCache<number>(fetch, (n) => n, 3)
  await cache.ensure(0, 10.5)
  // The bar opening at 10 is still forming at now = 10.
  expect(cache.slice(0, 20)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  now = 13
  await cache.ensure(0, 13)
  expect(cache.slice(0, 20)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  // The second read began three before the old end, not at it.
  expect(reads[1]).toEqual([7.5, 13])
  // Nothing new asked: nothing read.
  await cache.ensure(2, 12)
  expect(reads).toHaveLength(2)
})

/** A fetch whose reads are answered only when the test says, newest first: two reads in flight at
 * once are answered in the order that splices the older answer in last. */
function heldFetch() {
  const waiting: Array<() => void> = []
  const fetch = (from: number, to: number) =>
    new Promise<number[]>((resolve) => {
      waiting.push(() => {
        const out: number[] = []
        for (let k = Math.ceil(from); k < to; k++) out.push(k)
        resolve(out)
      })
    })
  /** Answer reads, newest first, until `done` settles. */
  const answer = async (done: Promise<unknown>) => {
    let settled = false
    void done.then(() => {
      settled = true
    })
    while (!settled) {
      waiting.pop()?.()
      await new Promise((r) => setTimeout(r, 0))
    }
  }
  return { fetch, answer }
}

const keys = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i)

// Two runs reading one series at once -- a run abandoned for a newer one, a sweep beside the Run,
// two alerts on one strategy -- each extended the span from the edges it saw when it started.
test('two reads extending the span backwards at once hold no row twice', async () => {
  const { fetch, answer } = heldFetch()
  const cache = new TailCache<number>(fetch, (n) => n, 2)
  const first = cache.ensure(10, 20)
  await answer(first)
  const both = Promise.all([cache.ensure(5, 20), cache.ensure(3, 20)])
  await answer(both)
  expect(cache.slice(0, 100)).toEqual(keys(3, 20))
})

test('a read replacing the span while another extends it leaves no hole read as held', async () => {
  const { fetch, answer } = heldFetch()
  const cache = new TailCache<number>(fetch, (n) => n, 2)
  await answer(cache.ensure(10, 20))
  // One extends the span back to 5; the other, disjoint, replaces it with [50, 60).
  await answer(Promise.all([cache.ensure(5, 20), cache.ensure(50, 60)]))
  // Whatever is held now, a read of [5, 60) must return every row of it.
  await answer(cache.ensure(5, 60))
  expect(cache.slice(0, 100)).toEqual(keys(5, 60))
})

// The data layer behind an alert on a strategy (lab/alertentries.ts) reads on as a replay's search
// walks forward, and as a live tab stays open: bounded, a series forgets what its reads walked past.
test('a bounded span forgets its oldest rows as forward reads walk on, never a row a read asked for', async () => {
  const reads: Array<[number, number]> = []
  const fetch = async (from: number, to: number) => {
    reads.push([from, to])
    return keys(Math.ceil(from), to)
  }
  const cache = new TailCache<number>(fetch, (n) => n, 0, 10)
  await cache.ensure(0, 8)
  await cache.ensure(6, 14)
  // Fourteen held, over the bound of ten: down to the newest ten.
  expect(cache.slice(0, 100)).toEqual(keys(4, 14))
  // A read longer than the bound keeps all of itself.
  await cache.ensure(12, 30)
  expect(cache.slice(0, 100)).toEqual(keys(12, 30))
  // What is held is not read again; what was dropped is, when asked for.
  await cache.ensure(12, 30)
  expect(reads).toEqual([
    [0, 8],
    [8, 14],
    [14, 30]
  ])
  await cache.ensure(8, 30)
  expect(reads[3]).toEqual([8, 12])
  expect(cache.slice(0, 100)).toEqual(keys(8, 30))
})

test('extending backwards prepends, and a disjoint range replaces the run', async () => {
  const fetch = async (from: number, to: number) => {
    const out: number[] = []
    for (let k = Math.ceil(from); k < to; k++) out.push(k)
    return out
  }
  const cache = new TailCache<number>(fetch, (n) => n, 2)
  await cache.ensure(10, 15)
  await cache.ensure(5, 15)
  expect(cache.slice(0, 100)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  await cache.ensure(50, 52)
  expect(cache.slice(0, 100)).toEqual([50, 51])
})
