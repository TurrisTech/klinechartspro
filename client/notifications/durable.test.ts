import { expect, test } from 'bun:test'
import { NotificationCenter } from './center'
import { durableSink } from './durable'
import type { NotificationBackend, NotificationSpec, RemoteNotification } from './types'

// The durable sink and the centre's `bind`: a live alert raised here at once, held by the server
// once it answers, and never twice in the list whichever of the answer and the live push lands
// first. A replay's row never reaches the server.

const ALERT: NotificationSpec = {
  title: 'RSI alert',
  body: 'EURUSD',
  level: 'alert',
  source: 'alert',
  data: { alertId: 'a1', eventAt: 5 },
  key: 'alert:a1:5'
}

function backend(): NotificationBackend & { seen: string[][] } {
  const seen: string[][] = []
  return { seen, hydrate: async () => [], markSeen: (ids) => seen.push(ids), clear: () => {} }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

test('a row is in the bell at once and takes the server id when the server answers', async () => {
  const center = new NotificationCenter()
  const raised: NotificationSpec[] = []
  const sink = durableSink(center, async (spec) => {
    raised.push(spec)
    return { ...spec, remoteId: 'k123', seen: false }
  })
  const row = sink.notify(ALERT)
  expect(center.list().map((r) => r.id)).toEqual([row.id])
  expect(center.list()[0].remoteId).toBeUndefined()
  await flush()
  expect(raised).toEqual([ALERT])
  expect(center.list()).toHaveLength(1)
  expect(center.list()[0].remoteId).toBe('k123')
})

test('the live push of the same row after the answer is not a second row', async () => {
  const center = new NotificationCenter()
  const sink = durableSink(center, async (spec) => ({ ...spec, remoteId: 'k123', seen: false }))
  sink.notify(ALERT)
  await flush()
  center.accept({ ...ALERT, remoteId: 'k123', seen: false, at: Date.now() })
  expect(center.list()).toHaveLength(1)
})

test('a push that lands before the answer keeps the server row and drops the page copy', async () => {
  const center = new NotificationCenter()
  let answer: (row: RemoteNotification) => void = () => {}
  const sink = durableSink(center, () => new Promise((resolve) => (answer = resolve)))
  sink.notify(ALERT)
  center.accept({ ...ALERT, remoteId: 'k123', seen: false, at: Date.now() })
  expect(center.list()).toHaveLength(2)
  answer({ ...ALERT, remoteId: 'k123', seen: false })
  await flush()
  expect(center.list().map((r) => r.remoteId)).toEqual(['k123'])
})

test('an acknowledgement made before the answer reaches the server when it comes', async () => {
  const center = new NotificationCenter()
  const durable = backend()
  await center.attach(durable)
  let answer: (row: RemoteNotification) => void = () => {}
  const sink = durableSink(center, () => new Promise((resolve) => (answer = resolve)))
  sink.notify(ALERT)
  center.markAllSeen()
  expect(durable.seen).toEqual([])
  answer({ ...ALERT, remoteId: 'k123', seen: false })
  await flush()
  expect(durable.seen).toEqual([['k123']])
})

test('a server that cannot take the row leaves it in this tab', async () => {
  const center = new NotificationCenter()
  const warn = console.warn
  console.warn = () => {}
  try {
    const sink = durableSink(center, async () => {
      throw new Error('offline')
    })
    sink.notify(ALERT)
    await flush()
  } finally {
    console.warn = warn
  }
  expect(center.list()).toHaveLength(1)
  expect(center.list()[0].remoteId).toBeUndefined()
})

test('a replay row is never posted, whoever hands it to the sink', async () => {
  const center = new NotificationCenter()
  const raised: NotificationSpec[] = []
  const sink = durableSink(center, async (spec) => {
    raised.push(spec)
    return { ...spec, remoteId: 'x', seen: false }
  })
  sink.notify({ title: '2024 alert', source: 'replay' })
  await flush()
  expect(raised).toEqual([])
  expect(center.list()).toHaveLength(1)
})
