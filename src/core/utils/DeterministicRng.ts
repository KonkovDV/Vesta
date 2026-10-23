/**
 * DeterministicRng — Seedable pseudorandom number generator
 * Layer: Core (utility, zero external dependencies)
 *
 * Provides deterministic, reproducible random sequences from a numeric seed.
 * Uses the Mulberry32 algorithm (Tommy Ettinger, ~2017) — a 32-bit PRNG
 * with excellent statistical properties, period 2^32, and extremely fast
 * single-multiplication core. Passes TestU01 SmallCrush.
 *
 * Primary use case: Seed Injection for weighted sampling in Markov
 * exploration (`sampleWeighted()`). Note: `predict()` uses lexicographic
 * `localeCompare` for tie-breaking and does NOT consume the RNG.
 * In CI/CD, seeded randomness prevents flaky tests caused by non-deterministic
 * weighted sampling in probabilistic algorithms.
 *
 * Usage:
 *   const rng = new DeterministicRng(42);      // reproducible sequence
 *   rng.next();        // → 0.0..1.0  (always same for seed 42)
 *   rng.nextInt(0, 9); // → 0..9      (uniform integer)
 *   rng.shuffle(arr);  // → in-place Fisher-Yates (deterministic)
 *
 *   const rng2 = DeterministicRng.fromSeedOrRandom();  // random if no seed
 *   const rng3 = DeterministicRng.fromSeedOrRandom(42); // deterministic
 *
 * @Horizon 6 — Seed Injection (Entropy Guard)
 * @see MarkovContextPredictor — primary consumer
 * @see PredictiveContextPrefetcher — orchestrator
 */

// ─── DeterministicRng ───────────────────────────────────────────────

export class DeterministicRng {
  /** Internal Mulberry32 state (mutable 32-bit integer) */
  private state: number;

  /** Original seed for reset/clone */
  private readonly initialSeed: number;

  /**
   * Create a PRNG with a specific numeric seed.
   *
   * @param seed — integer seed. Same seed always produces the same sequence.
   *   Non-integer values are truncated via `| 0`. Zero is a valid seed.
   */
  constructor(seed: number) {
    // Guard: Infinity/NaN coerce to 0 via bitwise OR — warn-worthy but valid
    this.initialSeed = seed | 0;
    this.state = this.initialSeed;
  }

  /**
   * Generate next float in [0, 1) — deterministic for a given seed.
   *
   * Mulberry32 core: single 32-bit multiply + shift cascade.
   * Each call advances internal state by one step.
   */
  next(): number {
    // Mulberry32 algorithm
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Generate a deterministic integer in [min, max] (inclusive).
   *
   * @param min — lower bound (integer)
   * @param max — upper bound (integer)
   * @returns uniform random integer in [min, max]
   * @throws if min > max
   */
  nextInt(min: number, max: number): number {
    if (min > max) throw new Error(`DeterministicRng.nextInt: min (${min}) > max (${max})`);
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /**
   * Fisher-Yates shuffle — in-place, deterministic.
   *
   * @param array — array to shuffle in-place
   * @returns the same array (mutated), for chaining
   */
  shuffle<T>(array: T[]): T[] {
    for (let i = array.length - 1; i > 0; i--) {
      const j = this.nextInt(0, i);
      const tmp = array[i];
      array[i] = array[j];
      array[j] = tmp;
    }
    return array;
  }

  /**
   * Reset the PRNG to its initial seed — replays the same sequence.
   */
  reset(): void {
    this.state = this.initialSeed;
  }

  /**
   * Clone this PRNG with the same initial seed (starts from beginning).
   */
  clone(): DeterministicRng {
    return new DeterministicRng(this.initialSeed);
  }

  /**
   * Get the original seed (useful for logging/debugging).
   */
  get seed(): number {
    return this.initialSeed;
  }

  // ── Static Factories ────────────────────────────────────────────

  /**
   * Create a PRNG from an optional seed.
   * - If seed is provided: deterministic sequence (for CI/tests).
   * - If seed is undefined: uses `Date.now() ^ random` for entropy (production).
   *
   * Usage from DI bootstrap (seed loaded via IConfigLoader):
   *   const rng = DeterministicRng.fromSeedOrRandom(config.markovSeed);
   *
   * @param seed — numeric seed, string-parseable seed, or undefined
   */
  static fromSeedOrRandom(seed?: number | string | null | undefined): DeterministicRng {
    if (seed !== undefined && seed !== null && seed !== '') {
      const parsed = typeof seed === 'string' ? parseInt(seed, 10) : seed;
      if (Number.isFinite(parsed)) {
        return new DeterministicRng(parsed);
      }
    }
    // Non-deterministic fallback: time-based + entropy
    return new DeterministicRng((Date.now() ^ (Math.random() * 0x7fffffff)) | 0);
  }
}
