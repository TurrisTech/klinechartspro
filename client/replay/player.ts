import type { AdvanceResult } from './session'

// PURE (no DOM). Autoplay: press Step again and again, one step every `delayMs`, until the
// replay stops on something worth seeing.
//
// A step is the user's own Step -- the current advance setting, walked or seeked exactly as a
// click would -- so playing changes nothing about what a step does, only who presses it. The
// play stops by itself on ANY stop that is not "reached the target": a fill pause, a firing
// price watch, a cancel, the end of the data. Each of those is the replay
// saying "look at this", and stepping on past it would hide it.
//
// Pacing is a floor, not a metronome. The next step waits for the delay AND for the wall to
// have loaded what the last step made it refetch (`settled` -- the plugin host's in-flight
// reads), so a fast pace can never queue reads faster than the server answers them: every
// step moves the read clock, and every plugin on every pane refetches its forming bar.

/** The paces offered, fastest first: the time between two steps. */
export const PLAY_DELAYS_MS = [250, 500, 1000, 2000, 5000] as const

export const DEFAULT_PLAY_DELAY_MS = 1000

export interface PlayerOptions {
  /** One step, exactly as the Step button takes it. Null when it could not start (busy). */
  step: () => Promise<AdvanceResult | null>
  /** Resolves once the wall has loaded what the last step invalidated. Bounded by the caller
   * (a timeout is fine: the wait is backpressure, not correctness). */
  settled?: () => Promise<void>
  /** Every step's result, as the Step button hands its own on: the caller opens the account
   * on a fill. Called even when the play was paused while that step was running. */
  onResult?: (result: AdvanceResult) => void
  /** `playing` or `delayMs` changed. */
  onChange?: () => void
  /** Injected so the tests run without real time. */
  sleep?: (ms: number) => Promise<void>
  delayMs?: number
}

export class ReplayPlayer {
  playing = false
  delayMs: number
  /** Bumped by every play and pause: a loop that finds it changed has been superseded. */
  private run = 0
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly options: PlayerOptions) {
    this.delayMs = options.delayMs ?? DEFAULT_PLAY_DELAY_MS
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  play(): void {
    if (this.playing) return
    this.playing = true
    const run = ++this.run
    this.options.onChange?.()
    void this.loop(run)
  }

  /** Stop after the step in progress, if any; that step is never cut short (a Stop does that). */
  pause(): void {
    if (!this.playing) return
    this.playing = false
    this.run++
    this.options.onChange?.()
  }

  toggle(): void {
    if (this.playing) this.pause()
    else this.play()
  }

  /** Takes effect from the next wait: a step already waiting keeps the pace it started with. */
  setDelay(ms: number): void {
    if (!(ms > 0) || ms === this.delayMs) return
    this.delayMs = ms
    this.options.onChange?.()
  }

  dispose(): void {
    this.playing = false
    this.run++
  }

  private async loop(run: number): Promise<void> {
    try {
      for (;;) {
        const result = await this.options.step()
        // Handed on even if paused meanwhile: a fill the user cannot see is worse than a
        // panel they did not ask for, however the step was started.
        if (result) this.options.onResult?.(result)
        if (run !== this.run) return
        if (result?.reason !== 'target') {
          this.pause()
          return
        }
        await Promise.all([this.sleep(this.delayMs), this.options.settled?.()])
        if (run !== this.run) return
      }
    } catch (err) {
      console.error('[replay] autoplay stopped', err)
      if (run === this.run) this.pause()
    }
  }
}
