/**
 * ISkillEvaluationRunner — Domain port for evaluation-driven skill development.
 *
 * AS-002 Evaluation-Driven Skill Development: structured pipeline for measuring
 * skill effectiveness through baseline comparison, cross-model testing, and
 * iterative refinement tracking based on real-world usage observations.
 *
 * SOTA 2026 Basis: Anthropic's "Build evals before writing docs" methodology.
 * The Claude A/B meta-development loop uses one Claude instance to author skills
 * and another to test them, creating a measurable improvement cycle. Skills are
 * tested across multiple models (Haiku/Sonnet/Opus) since different models
 * require different guidance specificity.
 *
 * Sub-capabilities:
 *   1. Structured Evaluation — run skill against expected behavior assertions
 *   2. Baseline Measurement — evaluate without skill for comparison
 *   3. Comparison Analysis — score delta, behavior delta, token delta
 *   4. Usage Observation Tracking — capture edge cases and unexpected paths
 *   5. Improvement Suggestions — derive actionable refinements from observations
 *
 * Distinct from CC-002 (IMultiModelConsensus): CC-002 evaluates LLM output
 * quality via Bayesian consensus across judges, while AS-002 evaluates
 * the SKILL ARTIFACT itself through structured behavior expectations
 * and iterative refinement workflow.
 *
 * @layer Domain (Agents)
 * @pattern AS-002 Skill Evaluation (FITNESS-K: 73)
 * @enriched-by SkillNet SECMC 5D evaluation (arXiv:2603.04448, Donor #28 ENRICH T2)
 * @enriched-by agency-agents success metrics + mandatory process patterns (Donor #30 ENRICH AA-E03)
 * @see src/domain/evaluation/IMultiModelConsensus.ts — Bayesian output consensus (CC-002)
 * @see src/domain/ai/ILlmQualityMonitor.ts — model quality variance (CC-010)
 * @see src/domain/agents/ISkillDiscoveryService.ts — skill loading (CC-011)
 */

// ─── Evaluation Request ──────────────────────────────────────────────────────

/**
 * Structured evaluation request for testing a skill's behavior.
 * Modeled on Anthropic's evaluation schema: {skills, query, files, expected_behavior}.
 */
export interface SkillEvalRequest {
  /** Unique evaluation run identifier. */
  readonly evalId: string;
  /** Skill IDs to evaluate (can test multiple skills composed together). */
  readonly skillIds: readonly string[];
  /** User query/prompt to execute with the skill(s). */
  readonly query: string;
  /** Optional file paths to include as context. */
  readonly files?: readonly string[];
  /** Expected behavioral outcomes to assert against. */
  readonly expectedBehavior: readonly string[];
  /** Target model ID to test with (e.g., 'haiku', 'sonnet', 'opus'). */
  readonly modelId?: string;
}

// ─── Behavior Match ──────────────────────────────────────────────────────────

/**
 * Result of matching a single expected behavior assertion.
 */
export interface BehaviorMatchResult {
  /** The expected behavior string being tested. */
  readonly expected: string;
  /** Whether the behavior was observed in the output. */
  readonly matched: boolean;
  /** Confidence in the match assessment (0.0–1.0). */
  readonly confidence: number;
  /** Supporting evidence from the skill's output. */
  readonly evidence?: string;
}

// ─── Evaluation Result ───────────────────────────────────────────────────────

/**
 * Result of a single evaluation run.
 */
export interface SkillEvalResult {
  /** Evaluation run identifier. */
  readonly evalId: string;
  /** Skill IDs evaluated. */
  readonly skillIds: readonly string[];
  /** Model ID used for evaluation. */
  readonly modelId: string;
  /** Per-behavior match results. */
  readonly behaviorMatches: readonly BehaviorMatchResult[];
  /** Aggregate score (0–100) based on match rate and confidence. */
  readonly overallScore: number;
  /** Execution duration in milliseconds. */
  readonly durationMs: number;
  /** Total tokens consumed during evaluation. */
  readonly tokensConsumed: number;
  /** ISO timestamp when evaluation completed. */
  readonly completedAt: string;
}

// ─── Comparison ──────────────────────────────────────────────────────────────

/**
 * Comparison between a skill evaluation and its baseline (without skill).
 */
export interface SkillEvalComparison {
  /** Skill evaluation ID. */
  readonly evalId: string;
  /** Baseline evaluation ID. */
  readonly baselineId: string;
  /** Score difference (positive = improvement). */
  readonly scoreDelta: number;
  /** Net behaviors gained vs lost. */
  readonly behaviorDelta: number;
  /** Token usage difference (negative = more efficient). */
  readonly tokenDelta: number;
  /** Overall verdict based on deltas. */
  readonly verdict: 'improved' | 'regressed' | 'neutral';
}

// ─── Usage Observations ──────────────────────────────────────────────────────

/**
 * Categories of real-world usage observations for iterative refinement.
 */
export type ObservationType =
  | 'unexpected_path'     // Skill followed unexpected approach
  | 'missed_connection'   // Skill missed important context/reference
  | 'overreliance'        // Skill over-relies on specific instruction
  | 'ignored_content'     // Skill ignored relevant instruction section
  | 'success';            // Skill performed as expected

/**
 * A single observation from real-world skill usage.
 * Observations accumulate to inform improvement suggestions.
 */
export interface SkillUsageObservation {
  /** Observation identifier. */
  readonly observationId: string;
  /** Skill that was observed. */
  readonly skillId: string;
  /** Type of observation. */
  readonly observationType: ObservationType;
  /** Description of what was observed. */
  readonly description: string;
  /** ISO timestamp of the observation. */
  readonly observedAt: string;
}

// ─── Improvement Suggestions ─────────────────────────────────────────────────

/**
 * Area of the skill that could be improved.
 */
export type ImprovementArea =
  | 'description'    // Skill description for discovery
  | 'instructions'   // SKILL.md body content
  | 'structure'      // File/directory organization
  | 'code'           // Bundled scripts/code
  | 'references';    // Reference file content

/**
 * Actionable improvement suggestion derived from usage observations.
 */
export interface SkillImprovementSuggestion {
  /** Skill to improve. */
  readonly skillId: string;
  /** Area of the skill to modify. */
  readonly area: ImprovementArea;
  /** Actionable suggestion text. */
  readonly suggestion: string;
  /** Observation IDs that support this suggestion. */
  readonly basedOn: readonly string[];
  /** Priority based on observation frequency and severity. */
  readonly priority: 'high' | 'medium' | 'low';
}

// ─── SECMC 5D Quality Assessment (SkillNet arXiv:2603.04448 §3.4) ────────────

/**
 * Five quality dimensions from SkillNet's SECMC evaluation framework.
 *
 * - Safety: absence of harmful, insecure, or policy-violating content
 * - Executability: skill can be invoked and produces correct output
 * - Completeness: skill covers the full scope of its stated purpose
 * - Maintainability: skill is well-structured, documented, and modifiable
 * - Cost-awareness: token usage and latency are acceptable with cost-efficiency
 *
 * @enriched-by Donor #28 ENRICH T2 (SkillNet SECMC dimensions)
 */
export type SkillQualityDimension =
  | 'safety'
  | 'executability'
  | 'completeness'
  | 'maintainability'
  | 'cost_awareness';

/**
 * Three-level grading per dimension (SkillNet validated against human annotators,
 * MAE < 0.03, QWK ≈ 1.0).
 */
export type SkillQualityGrade = 'good' | 'average' | 'poor';

/** Assessment result for a single quality dimension. */
export interface SkillDimensionAssessment {
  readonly dimension: SkillQualityDimension;
  readonly grade: SkillQualityGrade;
  /** Numerical score 0.0–1.0 within the dimension. */
  readonly score: number;
  /** Brief evidence or rationale for the grade. */
  readonly rationale?: string;
}

/** Aggregate quality assessment across all SECMC dimensions. */
export interface SkillQualityAssessment {
  readonly skillId: string;
  readonly dimensions: readonly SkillDimensionAssessment[];
  /** Weighted overall score 0.0–1.0. */
  readonly overallQualityScore: number;
  /** ISO timestamp of assessment. */
  readonly assessedAt: string;
}

// ─── Agent Success Metrics (agency-agents common template pattern) ────────────

/**
 * Structured success metric extracted from agent personality templates.
 * Most agents define 3-7 measurable outcomes in their "Success Metrics" section.
 *
 * @enriched-by Donor #30 ENRICH AA-E03 (agency-agents success metrics pattern)
 */
export interface AgentSuccessMetric {
  /** Metric name (e.g. "Code Review Turnaround Time"). */
  readonly name: string;
  /** What constitutes success for this metric. */
  readonly target: string;
  /** Measurement method or tool. */
  readonly measurementMethod?: string;
  /** Priority relative to other metrics. */
  readonly priority: 'critical' | 'high' | 'medium' | 'low';
}

/**
 * A mandatory process that an agent requires before producing output.
 * Extracted from testing/QA agents that enforce strict gate processes.
 *
 * @enriched-by Donor #30 ENRICH AA-E03 (agency-agents mandatory process pattern)
 */
export interface AgentMandatoryProcess {
  /** Process name (e.g. "Evidence Collection", "Reality Check"). */
  readonly name: string;
  /** Steps required in this process. */
  readonly steps: readonly string[];
  /** Whether this process must pass before proceeding. */
  readonly blocking: boolean;
}

// ─── Interface ───────────────────────────────────────────────────────────────

/**
 * ISkillEvaluationRunner — evaluation-driven skill development pipeline.
 *
 * Workflow:
 * 1. runBaseline() to measure behavior without the skill
 * 2. runEvaluation() to measure behavior with the skill
 * 3. compare() to produce score/behavior/token deltas
 * 4. recordObservation() to capture real-world usage edge cases
 * 5. getImprovementSuggestions() to derive refinements from observations
 * 6. Iterate: modify skill → re-evaluate → compare to previous run
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface ISkillEvaluationRunner {
  /**
   * Run evaluation suite against a skill with structured behavior assertions.
   *
   * @param request - Evaluation request with skills, query, and expected behaviors
   * @returns Evaluation result with per-behavior match scores
   */
  runEvaluation(request: SkillEvalRequest): Promise<SkillEvalResult>;

  /**
   * Run baseline measurement (without skill) for comparison.
   * Uses the same query and expected behaviors but without skill assistance.
   *
   * @param request - Evaluation request (skillIds are recorded but not applied)
   * @returns Baseline result for comparison
   */
  runBaseline(request: SkillEvalRequest): Promise<SkillEvalResult>;

  /**
   * Compare skill evaluation result against baseline.
   * Produces score delta, behavior delta, and token delta.
   *
   * @param evalId - Skill evaluation ID
   * @param baselineId - Baseline evaluation ID
   * @returns Comparison with verdict (improved/regressed/neutral)
   */
  compare(evalId: string, baselineId: string): SkillEvalComparison;

  /**
   * Record an observation from real-world skill usage.
   * Observations accumulate and inform improvement suggestions.
   *
   * @param observation - Usage observation to record
   */
  recordObservation(observation: SkillUsageObservation): void;

  /**
   * Get improvement suggestions based on accumulated observations.
   * Suggestions are prioritized by observation frequency and impact.
   *
   * @param skillId - Skill to get suggestions for
   * @returns Prioritized list of improvement suggestions
   */
  getImprovementSuggestions(skillId: string): SkillImprovementSuggestion[];

  /**
   * Assess skill quality across SECMC 5D dimensions.
   *
   * @enriched-by Donor #28 ENRICH T2 (SkillNet SECMC evaluation, arXiv:2603.04448 §3.4)
   * @param skillId - Skill to assess
   * @param dimensions - Optional subset of dimensions to evaluate (default: all 5)
   * @returns Quality assessment with per-dimension grades and overall score
   */
  assessQuality(
    skillId: string,
    dimensions?: readonly SkillQualityDimension[],
  ): Promise<SkillQualityAssessment>;
}
