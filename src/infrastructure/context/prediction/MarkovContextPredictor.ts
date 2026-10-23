/**
 * MarkovContextPredictor — N-order Markov chain for query prediction
 * Layer: Infrastructure (ML model / algorithm)
 *
 * Maintains a transition matrix over query sequences and predicts
 * the most likely next queries given a sliding window of recent queries.
 *
 * The model uses variable-order matching: first tries order-N match,
 * then falls back to (N-1), ..., down to order-1 (bigram).
 *
 * Memory-bounded: sliding window limits history length, and transition
 * matrix entries are bounded by the number of unique query patterns.
 *
 * Seed Injection (Horizon 6): Accepts an optional DeterministicRng for:
 *   1. Weighted random sampling in `sampleWeighted()` (exploration-exploitation)
 *   2. Future: entropy source for Phase 7 Event Mesh routing
 * Note: `predict()` uses lexicographic `localeCompare` for tie-breaking (always
 * deterministic, cross-engine stable) — it does NOT use the RNG.
 *
 * @Horizon 2 — Predictive S-MMU (Phase 6)
 * @Horizon 6 — Seed Injection (Entropy Guard)
 * @see IPredictiveContextService — domain port
 * @see PredictiveContextPrefetcher — orchestrator
 * @see DeterministicRng — seedable PRNG (Core utility)
 */

import { DeterministicRng } from '@/core/utils/DeterministicRng';

// ─── Types ──────────────────────────────────────────────────────────

/** Transition from a state (N recent queries) to a next query with frequency count */
interface TransitionEntry {
  /** Target query */
  readonly query: string;
  /** Number of times this transition was observed */
  count: number;
}

/** Internal transition matrix: state key → list of transitions */
type TransitionMatrix = Map<string, TransitionEntry[]>;

// ─── Constants ──────────────────────────────────────────────────────

/** Default Markov order (number of previous queries to condition on) */
const DEFAULT_ORDER = 2;

/** Maximum history length before trimming (sliding window) */
const MAX_HISTORY_LENGTH = 200;

/** Trim history to this size when MAX_HISTORY_LENGTH exceeded */
const TRIM_TO_LENGTH = 100;

/** Separator for composing multi-query state keys */
const STATE_SEPARATOR = '|||';

// ─── MarkovContextPredictor ─────────────────────────────────────────

export class MarkovContextPredictor {
  private readonly transitions: TransitionMatrix = new Map();
  private readonly order: number;
  private readonly rng: DeterministicRng | undefined;
  private history: string[] = [];
  private totalRecorded = 0;

  /**
   * @param order — Markov order (number of previous queries for state).
   *   Higher order = more specific predictions but slower to learn.
   *   Default: 2 (bigram conditioning).
   * @param rng — Optional seeded PRNG for deterministic weighted sampling.
   *   Used by `sampleWeighted()` for exploration-exploitation. `predict()` always
   *   uses lexicographic tie-breaking for stable top-K sort. Without RNG,
   *   `sampleWeighted()` falls back to highest-count entry (greedy).
   */
  constructor(order: number = DEFAULT_ORDER, rng?: DeterministicRng) {
    if (order < 1) throw new Error(`Markov order must be >= 1, got ${order}`);
    this.order = order;
    this.rng = rng;
  }

  /**
   * Record a query transition, updating the transition matrix.
   *
   * For order N, records transitions from all sub-orders 1..N
   * to improve prediction coverage with sparse data.
   *
   * @param query — the query to record
   */
  record(query: string): void {
    const normalized = this.normalize(query);
    if (!normalized) return;

    // Record transitions for all sub-orders (1..order)
    for (let o = 1; o <= this.order; o++) {
      if (this.history.length >= o) {
        const stateQueries = this.history.slice(-o);
        const stateKey = stateQueries.join(STATE_SEPARATOR);
        this.addTransition(stateKey, normalized);
      }
    }

    // Update history
    this.history.push(normalized);
    this.totalRecorded++;

    // Trim if history exceeds bounds
    if (this.history.length > MAX_HISTORY_LENGTH) {
      this.history = this.history.slice(-TRIM_TO_LENGTH);
    }
  }

  /**
   * Predict top-K next queries using variable-order matching.
   *
   * Tries the highest order first (most specific), falls back to
   * lower orders if no transitions exist at the higher order.
   *
   * @param currentQuery — the current query to predict from
   * @param k — number of predictions to return (default: 3)
   * @returns Predicted query strings in descending probability order
   */
  predict(currentQuery: string, k: number = 3): string[] {
    const normalized = this.normalize(currentQuery);
    if (!normalized) return [];

    // Try from highest order down to 1
    for (let o = this.order; o >= 1; o--) {
      const stateQueries = [...this.history.slice(-(o - 1)), normalized];
      // For order 1, state is just the current query
      const stateKey = o === 1
        ? normalized
        : stateQueries.slice(-o).join(STATE_SEPARATOR);

      const entries = this.transitions.get(stateKey);
      if (entries && entries.length > 0) {
        // Stable sort: primary by count (desc), secondary by deterministic tie-breaking.
        // Without this, entries with equal counts may sort differently across:
        //   - JS engines (V8 vs SpiderMonkey vs JSC)
        //   - V8 versions (TimSort stability is implementation detail)
        //   - Concurrent/async entry insertion order
        // Seed Injection (Horizon 6): prevents flaky tests in CI/CD.
        const sorted = entries.slice().sort((a, b) => {
          const diff = b.count - a.count;
          if (diff !== 0) return diff;
          // Tie-breaking: lexicographic (always deterministic, cross-engine stable)
          return a.query.localeCompare(b.query);
        });
        return sorted
          .slice(0, k)
          .map((e) => e.query);
      }
    }

    return [];
  }

  /**
   * Get the number of unique states in the transition matrix.
   */
  get modelSize(): number {
    return this.transitions.size;
  }

  /**
   * Get total number of queries recorded.
   */
  get queriesRecorded(): number {
    return this.totalRecorded;
  }

  /**
   * Reset the model (clear all transitions and history).
   *
   * **Caution — shared DeterministicRng coupling (HDA-65-F03):**
   * This method also resets the injected DeterministicRng to its initial seed
   * via `rng.reset()`. If the same RNG instance is resolved independently
   * by other DI consumers, their state will be silently rewound.
   * Currently only MarkovContextPredictor uses the RNG, but future consumers
   * must be aware of this coupling. The AUDIT-63 `Pick<>` attenuation already
   * prevents PredictiveMemoryCache from calling `reset()`.
   */
  reset(): void {
    this.transitions.clear();
    this.history = [];
    this.totalRecorded = 0;
    this.rng?.reset();
  }

  /**
   * Whether this predictor was initialized with a deterministic seed.
   * Useful for diagnostics and logging (e.g., "Markov seed=42").
   */
  get isSeeded(): boolean {
    return this.rng !== undefined;
  }

  /**
   * Get the seed value (undefined if not seeded).
   * For logging/debugging in CI: "Markov predictor running with seed=42".
   */
  get seedValue(): number | undefined {
    return this.rng?.seed;
  }

  /**
   * Sample one entry from weighted transitions using the seeded PRNG.
   *
   * Uses cumulative distribution + uniform draw for O(n) weighted sampling.
   * Falls back to the highest-count entry if no RNG is available.
   *
   * Accepts recent queries (same format as `predict()`), not raw state keys.
   * Internally composes the state key using STATE_SEPARATOR.
   *
   * Future use: exploration-exploitation in Phase 7 Event Mesh routing.
   *
   * @param recentQueries — 1..N recent normalized queries (composing a Markov state)
   * @returns sampled query or undefined if no transitions exist
   */
  sampleWeighted(recentQueries: string | string[]): string | undefined {
    const queries = typeof recentQueries === 'string' ? [recentQueries] : recentQueries;
    const normalized = queries.map((q) => this.normalize(q)).filter(Boolean);
    if (normalized.length === 0) return undefined;

    const stateKey = normalized.join(STATE_SEPARATOR);
    const entries = this.transitions.get(stateKey);
    if (!entries || entries.length === 0) return undefined;

    // Without RNG: deterministic — return highest-count entry
    // HDA-67-F02: Use localeCompare (not <) for cross-engine stable tie-breaking,
    // consistent with predict() sort. See class-level JSDoc.
    if (!this.rng) {
      return entries.reduce((best, e) =>
        e.count > best.count ? e : (e.count === best.count ? (e.query.localeCompare(best.query) < 0 ? e : best) : best),
      ).query;
    }

    // Weighted sampling via cumulative distribution
    const totalWeight = entries.reduce((sum, e) => sum + e.count, 0);
    const threshold = this.rng.next() * totalWeight;
    let cumulative = 0;
    for (const entry of entries) {
      cumulative += entry.count;
      if (cumulative > threshold) return entry.query;
    }
    // Fallback (floating-point edge case)
    return entries[entries.length - 1].query;
  }

  // ── Private ───────────────────────────────────────────────────────

  /**
   * Add or increment a transition from stateKey → targetQuery.
   */
  private addTransition(stateKey: string, targetQuery: string): void {
    let entries = this.transitions.get(stateKey);
    if (!entries) {
      entries = [];
      this.transitions.set(stateKey, entries);
    }

    const existing = entries.find((e) => e.query === targetQuery);
    if (existing) {
      existing.count++;
    } else {
      entries.push({ query: targetQuery, count: 1 });
    }
  }

  /**
   * Normalize query to a canonical form for matching.
   * Lowercase, trim, collapse whitespace.
   */
  private normalize(query: string): string {
    return query.toLowerCase().trim().replace(/\s+/g, ' ');
  }
}
