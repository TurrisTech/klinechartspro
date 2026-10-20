// HOW SURE A MEAN IS: the t-statistic of a sample's mean against zero, and a bootstrap
// confidence interval for it -- what says whether 44 trades averaging -0.23 R are a strategy or
// a coin.
//
// The bootstrap resamples with a SEEDED generator, so one sample always gives one interval: a
// re-run that changes nothing must not move the figures. The t-statistic assumes independent
// samples; entries close together overlap in what they measure (two 5m entries a bar apart see
// mostly the same 48 bars), which makes it read stronger than it is. The interval has the same
// caveat. Both are a floor on doubt, not a ceiling.
//
// PURE.

export interface MeanStats {
  n: number
  mean: number | null
  /** Sample standard deviation (n - 1). */
  sd: number | null
  /** mean / (sd / sqrt(n)); null below two samples or with no spread. */
  t: number | null
  /** The bootstrap interval of the mean at `level`; null below two samples. */
  ci: [number, number] | null
}

export const BOOTSTRAP_RESAMPLES = 2000
export const CI_LEVEL = 0.95

/** mulberry32: a small, fast, seeded generator in [0, 1). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export function meanStats(values: readonly number[], resamples = BOOTSTRAP_RESAMPLES, level = CI_LEVEL): MeanStats {
  const xs = values.filter((v) => Number.isFinite(v))
  const n = xs.length
  if (n === 0) return { n, mean: null, sd: null, t: null, ci: null }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  if (n < 2) return { n, mean, sd: null, t: null, ci: null }
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1))
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : null
  // The same seed for the same sample size: the interval is a function of the sample alone.
  const random = seeded(0x5eed ^ n)
  const means = new Float64Array(resamples)
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += xs[Math.floor(random() * n)]
    means[r] = sum / n
  }
  means.sort()
  const tail = (1 - level) / 2
  const at = (q: number): number => means[Math.min(resamples - 1, Math.max(0, Math.round(q * (resamples - 1))))]
  return { n, mean, sd, t, ci: [at(tail), at(1 - tail)] }
}
