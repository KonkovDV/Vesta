/**
 * Agentic Domain Errors — Unified error taxonomy for all agentic patterns.
 *
 * Layer: Domain (depends only on Core)
 *
 * Hierarchy:
 *   AgenticDomainError (base)
 *   ├── EvaluationFailedError    — ILlmJudge, IGoalEvaluator, IResponseEvaluator
 *   ├── ReasoningTimeoutError    — IStructuredReasoningProtocol (p99 < 30s SLO)
 *   ├── GuardrailBlockedError    — IInputGuardrailPipeline, IOutputGuardrailPipeline
 *   ├── ModelBudgetExceededError — IAgentBudget, ITokenomicsController
 *   ├── McpConnectionError       — IMcpToolConsumer
 *   ├── A2ATaskError             — IA2ATaskRunner, IA2AStreamTransport
 *   ├── MaxIterationsExceededError — IReflectionLoop, IIterativeRefiner
 *   ├── ChainStepFailedError     — IPromptChainExecutor
 *   ├── ClassificationError      — IPromptClassifier
 *   └── SelfCorrectionError      — ISelfCorrectionAgent
 *
 * @see PLANS/implementation-phases/00_MASTER_PLAN.md §8.5 — Error Taxonomy (CC-5)
 * @see Book: "Agentic Design Patterns" Ch.12 "Exception Handling and Recovery"
 */

import type { CorrelationId } from '../../core/types/branded';

/**
 * Base class for all agentic domain errors.
 * All subclasses carry a machine-readable `code` and optional `correlationId`.
 */
export class AgenticDomainError extends Error {
  readonly code: string;
  readonly correlationId?: CorrelationId;

  constructor(message: string, code: string, correlationId?: CorrelationId) {
    super(message);
    this.name = 'AgenticDomainError';
    this.code = code;
    this.correlationId = correlationId;
    // Restore prototype chain (TS extends Error quirk)
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** ILlmJudge / IGoalEvaluator / IResponseEvaluator — evaluation failed */
export class EvaluationFailedError extends AgenticDomainError {
  constructor(message: string, correlationId?: CorrelationId) {
    super(message, 'EVALUATION_FAILED', correlationId);
    this.name = 'EvaluationFailedError';
  }
}

/** IStructuredReasoningProtocol — reasoning exceeds SLO timeout */
export class ReasoningTimeoutError extends AgenticDomainError {
  constructor(message: string, correlationId?: CorrelationId) {
    super(message, 'REASONING_TIMEOUT', correlationId);
    this.name = 'ReasoningTimeoutError';
  }
}

/** IInputGuardrailPipeline / IOutputGuardrailPipeline — content blocked */
export class GuardrailBlockedError extends AgenticDomainError {
  readonly severity: 'low' | 'medium' | 'high' | 'critical';
  readonly scannerName: string;

  constructor(
    message: string,
    scannerName: string,
    severity: 'low' | 'medium' | 'high' | 'critical',
    correlationId?: CorrelationId,
  ) {
    super(message, 'GUARDRAIL_BLOCKED', correlationId);
    this.name = 'GuardrailBlockedError';
    this.scannerName = scannerName;
    this.severity = severity;
  }
}

/** IAgentBudget — budget exhausted (tokens, cost, time, tool calls) */
export class ModelBudgetExceededError extends AgenticDomainError {
  readonly reason: 'max_duration' | 'max_tool_calls' | 'max_tokens' | 'max_cost';

  constructor(
    message: string,
    reason: 'max_duration' | 'max_tool_calls' | 'max_tokens' | 'max_cost',
    correlationId?: CorrelationId,
  ) {
    super(message, 'MODEL_BUDGET_EXCEEDED', correlationId);
    this.name = 'ModelBudgetExceededError';
    this.reason = reason;
  }
}

/** IMcpToolConsumer — MCP connection or tool call failure */
export class McpConnectionError extends AgenticDomainError {
  readonly serverUrl: string;

  constructor(message: string, serverUrl: string, correlationId?: CorrelationId) {
    super(message, 'MCP_CONNECTION_FAILED', correlationId);
    this.name = 'McpConnectionError';
    this.serverUrl = serverUrl;
  }
}

/** IA2ATaskRunner / IA2AStreamTransport — A2A protocol failure */
export class A2ATaskError extends AgenticDomainError {
  readonly taskId: string;

  constructor(message: string, taskId: string, correlationId?: CorrelationId) {
    super(message, 'A2A_TASK_FAILED', correlationId);
    this.name = 'A2ATaskError';
    this.taskId = taskId;
  }
}

/** IReflectionLoop / IIterativeRefiner — max iterations reached without convergence */
export class MaxIterationsExceededError extends AgenticDomainError {
  readonly iterations: number;
  readonly maxIterations: number;

  constructor(
    message: string,
    iterations: number,
    maxIterations: number,
    correlationId?: CorrelationId,
  ) {
    super(message, 'MAX_ITERATIONS_EXCEEDED', correlationId);
    this.name = 'MaxIterationsExceededError';
    this.iterations = iterations;
    this.maxIterations = maxIterations;
  }
}

/** IPromptChainExecutor — chain step failed and no recovery strategy succeeded */
export class ChainStepFailedError extends AgenticDomainError {
  readonly stepName: string;
  readonly stepNumber: number;

  constructor(
    message: string,
    stepName: string,
    stepNumber: number,
    correlationId?: CorrelationId,
  ) {
    super(message, 'CHAIN_STEP_FAILED', correlationId);
    this.name = 'ChainStepFailedError';
    this.stepName = stepName;
    this.stepNumber = stepNumber;
  }
}

/** IPromptClassifier — classifier unable to determine complexity category */
export class ClassificationError extends AgenticDomainError {
  constructor(message: string, correlationId?: CorrelationId) {
    super(message, 'CLASSIFICATION_FAILED', correlationId);
    this.name = 'ClassificationError';
  }
}

/** ISelfCorrectionAgent — self-correction exhausted all attempts without passing threshold */
export class SelfCorrectionError extends AgenticDomainError {
  readonly attempts: number;
  readonly finalScore: number;

  constructor(
    message: string,
    attempts: number,
    finalScore: number,
    correlationId?: CorrelationId,
  ) {
    super(message, 'SELF_CORRECTION_FAILED', correlationId);
    this.name = 'SelfCorrectionError';
    this.attempts = attempts;
    this.finalScore = finalScore;
  }
}
