import { expect, test } from 'bun:test'
import { relativeTime } from './bell'
import { MAX_NOTIFICATIONS, NotificationCenter } from './center'
import type { NotificationBackend, RemoteNotification } from './types'

// The centre's model. No DOM anywhere here: `bell.ts` is the only part that needs one, and
// bun has no document -- which is exactly why the list, the seen-count and the backend seam
// live in their own file.

const NOW = 1_700_000_000_000

function remote(id: string, at: number, over: Partial<RemoteNotification> = {}): RemoteNotification {
  return { remoteId: id, at, title: id, seen: false, ...over }
}

/** Records what the durable half is told, and hands back whatever it was seeded with. */
function fakeBackend(rows: RemoteNotification[] = []): NotificationBackend & {
  seen: string[][]
  cleared: string[][]
} {
  const seen: string[][] = []
  const cleared: string[][] = []
  return {
    seen,
    cleared,
    hydrate: async () => rows,
    markSeen: (ids) => seen.push(ids),
    clear: (ids) => cleared.push(ids)
  }
}

test('a notification arrives unseen and is counted', () => {
  const center = new NotificationCenter()
  center.notify({ title: 'EURUSD reached 1.16500', source: 'watch', level: 'alert' })
  expect(center.unseen()).toBe(1)
  expect(center.list()[0].title).toBe('EURUSD reached 1.16500')
  expect(center.list()[0].level).toBe('alert')
})

test('marking seen is what stops the blink, and clearing is separate', () => {
  const center = new NotificationCenter()
  center.notify({ title: 'one' })
  center.notify({ title: 'two' })
  center.markAllSeen()
  expect(center.unseen()).toBe(0)
  // Seen, but still listed -- "I know" and "I'm done with these" are different acts.
  expect(center.list()).toHaveLength(2)
  center.clear()
  expect(center.list()).toHaveLength(0)
})

test('the list is newest first, however the rows arrived', async () => {
  const center = new NotificationCenter()
  // A live push, then a hydrate carrying older rows: position is decided by `at`, not by
  // arrival, or a catch-up read would bury the alert that just fired.
  center.accept(remote('live', NOW))
  await center.attach(fakeBackend([remote('b', NOW - 1_000), remote('a', NOW - 2_000)]))
  expect(center.list().map((row) => row.remoteId)).toEqual(['live', 'b', 'a'])
})

test('a server row is adopted once, however many times it arrives', async () => {
  const center = new NotificationCenter()
  const backend = fakeBackend([remote('x', NOW)])
  await center.attach(backend)
  // The push that raced the hydrate, and a re-hydrate after a reconnect.
  center.accept(remote('x', NOW))
  await center.attach(backend)
  expect(center.list()).toHaveLength(1)
})

test('acknowledging and clearing reach the durable half', async () => {
  const center = new NotificationCenter()
  const backend = fakeBackend([remote('r1', NOW), remote('r2', NOW - 1)])
  await center.attach(backend)
  center.notify({ title: 'local only' })

  center.markAllSeen()
  // Only the server's rows are sent, and each id exactly once.
  expect(backend.seen).toEqual([['r1', 'r2']])

  center.remove(center.list().find((row) => row.remoteId === 'r1')?.id ?? '')
  expect(backend.cleared).toEqual([['r1']])
  center.clear()
  expect(backend.cleared[1]).toEqual(['r2'])
})

test('a detached backend stops hearing about changes', async () => {
  const center = new NotificationCenter()
  const backend = fakeBackend([remote('r1', NOW)])
  await center.attach(backend)
  center.detach(backend)
  center.markAllSeen()
  expect(backend.seen).toEqual([])
})

test('a backend that cannot be read leaves the centre usable', async () => {
  const center = new NotificationCenter()
  await center.attach({
    hydrate: async () => {
      throw new Error('offline')
    },
    markSeen: () => {},
    clear: () => {}
  })
  center.notify({ title: 'still works' })
  expect(center.list()).toHaveLength(1)
})

test('clear takes one producer at a time', () => {
  const center = new NotificationCenter()
  center.notify({ title: 'a watch fired', source: 'watch' })
  center.notify({ title: 'a replay note', source: 'replay' })
  center.clear('watch')
  expect(center.list().map((row) => row.source)).toEqual(['replay'])
})

test('subscribers hear the current list immediately, then every change', () => {
  const center = new NotificationCenter()
  center.notify({ title: 'before' })
  const seen: number[] = []
  const stop = center.subscribe((list) => seen.push(list.length))
  center.notify({ title: 'after' })
  center.remove(center.list()[0].id)
  stop()
  center.notify({ title: 'ignored' })
  expect(seen).toEqual([1, 2, 1])
})

test('the list is capped, dropping the oldest', () => {
  const center = new NotificationCenter()
  for (let i = 0; i < MAX_NOTIFICATIONS + 5; i += 1) center.notify({ title: `n${i}`, at: NOW + i })
  const list = center.list()
  expect(list).toHaveLength(MAX_NOTIFICATIONS)
  expect(list[0].title).toBe(`n${MAX_NOTIFICATIONS + 4}`)
  expect(list.at(-1)?.title).toBe('n5')
})

test('relative time is coarse and never negative', () => {
  expect(relativeTime(NOW, NOW)).toBe('just now')
  expect(relativeTime(NOW - 30_000, NOW)).toBe('just now')
  expect(relativeTime(NOW - 6 * 60_000, NOW)).toBe('6m ago')
  expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
  expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago')
  // A clock that stepped backwards must not print "-1m ago".
  expect(relativeTime(NOW + 5_000, NOW)).toBe('just now')
})
