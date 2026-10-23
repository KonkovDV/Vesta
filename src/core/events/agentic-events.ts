/**
 * Agentic Design Patterns — Domain Event Zod Schemas
 *
 * Layer: Core (Event Schemas — no external dependencies except Zod)
 *
 * Source: "Agentic Design Patterns" (Gulli, Springer 2026), 48 patterns + 12 gap analysis
 * Contains Zod schemas for all domain events emitted by agentic services.
 * All events are persisted via IEventStore.saveEvents() (Outbox-first pattern).
 *
 * Categories:
 *   - Evaluation (ILlmJudge)
 *   - Reflection (IReflectionLoop)
 *   - Classification (IPromptClassifier)
 *   - Reasoning (IStructuredReasoningProtocol)
 *   - Self-Correction (ISelfCorrectionAgent)
 *   - Guardrails (IInputGuardrailPipeline, IOutputGuardrailPipeline)
 *   - Goal Evaluation (IGoalEvaluator, IResponseEvaluator)
 *   - Refinement (IIterativeRefiner)
 *   - Evolution (IEvolutionEngine, IFitnessEvaluator)
 *   - Chain (IPromptChainExecutor)
 *   - Research (IDeepResearchService, ICitationExtractor)
 *   - Inter-Agent (IA2ATaskRunner, IMcpToolConsumer, IAgentDialogueLoop)
 *   - Review (IReviewerPanel, IResearchLabOrchestrator)
 *   - Recovery (IRecoveryStrategy)
 *   - Feedback (IUserFeedbackCollector)
 *   - Budget (IAgentBudget)
 *   - Checkpoint (ICheckpointableFlow)
 *
 * @see PLANS/implementation-phases/PHASE_0_PREPARATION.md §1.5
 */

import { z } from 'zod';

// ═══════════════════════════════════════════════════════════════════════════════
// Evaluation Events (Wave A — ILlmJudge)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticJudgeCompletedSchema = z.object({
  criteriaCount: z.number().int().positive(),
  overallScore: z.number().min(0).max(10),
  recommendedAction: z.enum(['approve', 'revise', 'reject']),
  confidence: z.number().min(0).max(1),
  durationMs: z.number().int().nonnegative(),
  tokensUsed: z.number().int().nonnegative(),
});

export const AgenticJudgeFailedSchema = z.object({
  error: z.string(),
  durationMs: z.number().int().nonnegative(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Reflection Events (Wave A — IReflectionLoop)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticReflectionIterationSchema = z.object({
  iterationNumber: z.number().int().positive(),
  action: z.enum(['continue', 'stop']),
  sentinelMatched: z.boolean(),
  contentLength: z.number().int().nonnegative(),
});

export const AgenticReflectionCompletedSchema = z.object({
  totalIterations: z.number().int().positive(),
  stoppedBy: z.enum(['sentinel', 'max_iterations', 'approved']),
  finalContentLength: z.number().int().nonnegative(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Classification Events (Wave A — IPromptClassifier)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticClassificationCompletedSchema = z.object({
  complexity: z.enum(['simple', 'reasoning', 'creative', 'research']),
  confidence: z.number().min(0).max(1),
  suggestedModel: z.string().nullable().optional(),
  requiresTools: z.boolean(),
  usedLlm: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Reasoning Events (Wave B — IStructuredReasoningProtocol)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticReasoningPhaseSchema = z.object({
  phase: z.enum(['decompose', 'plan', 'execute', 'verify', 'synthesize']),
  phaseNumber: z.number().int().min(1).max(5),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Self-Correction Events (Wave B — ISelfCorrectionAgent)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticSelfCorrectionAttemptSchema = z.object({
  attemptNumber: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
  score: z.number().min(0).max(10),
  accepted: z.boolean(),
});

export const AgenticSelfCorrectionCompletedSchema = z.object({
  totalAttempts: z.number().int().positive(),
  finalScore: z.number().min(0).max(10),
  accepted: z.boolean(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Guardrail Events (Wave C — IInputGuardrailPipeline, IOutputGuardrailPipeline)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticGuardrailTriggeredSchema = z.object({
  pipeline: z.enum(['input', 'output']),
  scannerName: z.string(),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  blocked: z.boolean(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Goal Evaluation Events (Wave C — IGoalEvaluator, IResponseEvaluator)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticGoalEvaluatorCompletedSchema = z.object({
  goalMet: z.boolean(),
  overallScore: z.number().min(0).max(10),
  criteriaCount: z.number().int().positive(),
});

export const AgenticResponseEvaluatorCompletedSchema = z.object({
  accuracy: z.number().min(0).max(10),
  helpfulness: z.number().min(0).max(10),
  recommendation: z.enum(['accept', 'improve', 'reject']),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Refinement Events (Wave C — IIterativeRefiner)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticRefinerIterationSchema = z.object({
  iterationNumber: z.number().int().positive(),
  score: z.number().min(0).max(10),
  improvement: z.number(),
});

export const AgenticRefinerCompletedSchema = z.object({
  totalIterations: z.number().int().positive(),
  initialScore: z.number().min(0).max(10),
  finalScore: z.number().min(0).max(10),
  converged: z.boolean(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Evolution Events (Wave D — IEvolutionEngine, IFitnessEvaluator)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticEvolutionGenerationSchema = z.object({
  generation: z.number().int().nonnegative(),
  populationSize: z.number().int().positive(),
  bestFitness: z.number().min(0).max(1),
});

export const AgenticFitnessEvaluatedSchema = z.object({
  candidateId: z.string(),
  fitness: z.number().min(0).max(1),
  generation: z.number().int().nonnegative(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Chain Events (Wave E — IPromptChainExecutor)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticChainStepCompletedSchema = z.object({
  stepName: z.string(),
  stepNumber: z.number().int().positive(),
  totalSteps: z.number().int().positive(),
  skipped: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Research Events (Wave E — IDeepResearchService, ICitationExtractor)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticResearchCompletedSchema = z.object({
  totalSources: z.number().int().nonnegative(),
  totalCitations: z.number().int().nonnegative(),
  totalSearches: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Inter-Agent Events (Wave F — IA2ATaskRunner, IMcpToolConsumer, IAgentDialogueLoop)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticA2ATaskSentSchema = z.object({
  targetAgentUrl: z.string().url(),
  taskId: z.string(),
  method: z.enum(['sendTask', 'sendTaskSubscribe']),
});

export const AgenticA2ATaskCompletedSchema = z.object({
  taskId: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']),
  durationMs: z.number().int().nonnegative(),
});

export const AgenticMcpToolCalledSchema = z.object({
  serverUrl: z.string(),
  toolName: z.string(),
  transport: z.enum(['stdio', 'sse', 'streamable-http']),
  durationMs: z.number().int().nonnegative(),
  success: z.boolean(),
});

export const AgenticDialogueTurnSchema = z.object({
  turnNumber: z.number().int().positive(),
  agentId: z.string(),
  totalParticipants: z.number().int().positive(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Review Events (Wave G — IReviewerPanel, IResearchLabOrchestrator)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticReviewCompletedSchema = z.object({
  reviewerCount: z.number().int().positive(),
  averageScore: z.number().min(0).max(10),
  consensus: z.enum(['accept', 'revise', 'reject']),
});

export const AgenticLabPhaseCompletedSchema = z.object({
  phaseName: z.string(),
  agentRole: z.string(),
  durationMs: z.number().int().nonnegative(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Recovery Events (Wave H — IRecoveryStrategy, CC-11)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticRecoveryTriggeredSchema = z.object({
  flow: z.string(),
  step: z.string(),
  action: z.enum(['retry-different-model', 'skip-step', 'fallback-simpler', 'escalate-to-human']),
  attemptNumber: z.number().int().positive(),
  originalError: z.string(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Feedback Events (Wave H — IUserFeedbackCollector, CC-12)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticFeedbackCollectedSchema = z.object({
  responseId: z.string(),
  rating: z.number().int().min(1).max(5).optional(),
  thumbs: z.enum(['up', 'down']).optional(),
  hasCorrection: z.boolean(),
  implicit: z.enum(['regenerated', 'copied', 'follow_up']).optional(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Budget Events (Wave H — IAgentBudget, CC-13)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticBudgetExhaustedSchema = z.object({
  reason: z.enum(['max_duration', 'max_tool_calls', 'max_tokens', 'max_cost']),
  scopeId: z.string().optional(),
  flow: z.string(),
});

export const AgenticBudgetWarningSchema = z.object({
  thresholdPercent: z.number().int().min(50).max(100),
  scopeId: z.string().optional(),
  flow: z.string(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Checkpoint Events (Wave H — ICheckpointableFlow, CC-11)
// ═══════════════════════════════════════════════════════════════════════════════

export const AgenticCheckpointSavedSchema = z.object({
  flowId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  flow: z.string(),
});

export const AgenticCheckpointResumedSchema = z.object({
  flowId: z.string(),
  fromStepIndex: z.number().int().nonnegative(),
  flow: z.string(),
});

// ═══════════════════════════════════════════════════════════════════════════════
// Aggregated Event Map (for typed EventStore integration)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Master map: event type → Zod schema.
 * Used by EventStore for payload validation (Outbox-first pattern).
 */
export const AgenticEventSchemas = {
  // Evaluation (Wave A)
  'agentic.judge.completed': AgenticJudgeCompletedSchema,
  'agentic.judge.failed': AgenticJudgeFailedSchema,

  // Reflection (Wave A)
  'agentic.reflection.iteration': AgenticReflectionIterationSchema,
  'agentic.reflection.completed': AgenticReflectionCompletedSchema,

  // Classification (Wave A)
  'agentic.classification.completed': AgenticClassificationCompletedSchema,

  // Reasoning (Wave B)
  'agentic.reasoning.phase': AgenticReasoningPhaseSchema,

  // Self-Correction (Wave B)
  'agentic.selfcorrection.attempt': AgenticSelfCorrectionAttemptSchema,
  'agentic.selfcorrection.completed': AgenticSelfCorrectionCompletedSchema,

  // Guardrails (Wave C)
  'agentic.guardrail.triggered': AgenticGuardrailTriggeredSchema,

  // Goal Evaluation (Wave C)
  'agentic.goalevaluator.completed': AgenticGoalEvaluatorCompletedSchema,
  'agentic.responseevaluator.completed': AgenticResponseEvaluatorCompletedSchema,

  // Refinement (Wave C)
  'agentic.refiner.iteration': AgenticRefinerIterationSchema,
  'agentic.refiner.completed': AgenticRefinerCompletedSchema,

  // Evolution (Wave D)
  'agentic.evolution.generation': AgenticEvolutionGenerationSchema,
  'agentic.fitness.evaluated': AgenticFitnessEvaluatedSchema,

  // Chain (Wave E)
  'agentic.chain.step.completed': AgenticChainStepCompletedSchema,

  // Research (Wave E)
  'agentic.research.completed': AgenticResearchCompletedSchema,

  // Inter-Agent (Wave F)
  'agentic.a2a.task.sent': AgenticA2ATaskSentSchema,
  'agentic.a2a.task.completed': AgenticA2ATaskCompletedSchema,
  'agentic.mcp.tool.called': AgenticMcpToolCalledSchema,
  'agentic.dialogue.turn': AgenticDialogueTurnSchema,

  // Review (Wave G)
  'agentic.review.completed': AgenticReviewCompletedSchema,
  'agentic.lab.phase.completed': AgenticLabPhaseCompletedSchema,

  // Recovery (Wave H)
  'agentic.recovery.triggered': AgenticRecoveryTriggeredSchema,

  // Feedback (Wave H)
  'agentic.feedback.collected': AgenticFeedbackCollectedSchema,

  // Budget (Wave H)
  'agentic.budget.exhausted': AgenticBudgetExhaustedSchema,
  'agentic.budget.warning': AgenticBudgetWarningSchema,

  // Checkpoint (Wave H)
  'agentic.checkpoint.saved': AgenticCheckpointSavedSchema,
  'agentic.checkpoint.resumed': AgenticCheckpointResumedSchema,
} as const;

/** Type: all agentic event names */
export type AgenticEventType = keyof typeof AgenticEventSchemas;

/** Type: inferred payload for a given agentic event */
export type AgenticEventPayload<T extends AgenticEventType> =
  z.infer<typeof AgenticEventSchemas[T]>;
