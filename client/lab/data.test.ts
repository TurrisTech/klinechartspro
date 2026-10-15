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
