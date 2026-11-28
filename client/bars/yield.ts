/** Hand the event loop back for one turn, so a click, a paint or a due timer can run.
 *
 * NOT `setTimeout(0)`: a hidden tab clamps chained timers to about a second each (measured in
 * this project's Chrome: ten chained zero-delay timers took 3.1 s, while ten MessageChannel
 * turns took 2 ms), so a walk left running behind another tab would yield once a second and
 * crawl. `scheduler.yield()` is built for exactly this and lets input through; a MessageChannel
 * turn is the fallback where it does not exist -- neither is throttled in a hidden tab. */
export function nextTask(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler
  if (typeof scheduler?.yield === 'function') return scheduler.yield()
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => {
      channel.port1.close()
      resolve()
    }
    channel.port2.postMessage(null)
  })
}
