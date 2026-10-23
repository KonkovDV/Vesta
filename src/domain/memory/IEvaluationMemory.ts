/**
 * IEvaluationMemory — Domain port for the durable evaluation memory plane.
 *
 * Governs benchmark runs, judge outputs, verdicts, and plane-level scorecards
 * separately from profile, semantic, and archival memory. Infrastructure
 * adapters may persist this plane into PostgreSQL or another durable substrate,
 * but the artifact model and inspection surface remain explicit.
 *
 * @layer Domain (Memory)
 * @since v2.9.0 — M4-W1 evaluation plane contract extraction
 */

export type EvaluationMemoryPlane =
  | 'working'
  | 'summary'
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'profile'
  | 'archival'
  | 'graph'
  | 'reflective'
  | 'governance'
  | 'evaluation';

export type EvaluationMemoryVerdict = 'pass' | 'fail' | 'inconclusive';

export interface EvaluationJudgeRecord {
  readonly judgeId: string;
  readonly modelId: string;
  readonly vote: 'approve' | 'reject' | 'abstain';
  readonly confidence: number;
  readonly rationale: string;
  readonly historicalAccuracy?: number;
}

export interface EvaluationAggregateResult {
  readonly decision: string;
  readonly consensusProbability?: number;
  readonly quorumMet?: boolean;
  readonly dissentingCount?: number;
}

export interface EvaluationMemoryRunRecord {
  readonly runId: string;
  readonly plane: EvaluationMemoryPlane;
  readonly benchmarkId: string;
  readonly benchmarkVersion: string;
  readonly summary: string;
  readonly verdict: EvaluationMemoryVerdict;
  readonly timestamp: string;
  readonly score?: number;
  readonly maxScore?: number;
  readonly model?: string;
  readonly config?: Record<string, unknown>;
  readonly judges?: ReadonlyArray<EvaluationJudgeRecord>;
  readonly aggregate?: EvaluationAggregateResult;
  readonly metadata?: Record<string, unknown>;
}

export interface RecordEvaluationRunInput {
  readonly run: EvaluationMemoryRunRecord;
  readonly tenantId?: string;
  readonly userId?: string;
  readonly correlationId?: string;
}

export interface EvaluationMemoryWriteResult {
  readonly stored: boolean;
  readonly storedRunId: string;
}

export interface EvaluationMemoryListInput {
  readonly tenantId?: string;
  readonly userId?: string;
  readonly plane?: EvaluationMemoryPlane;
  readonly benchmarkId?: string;
  readonly verdict?: EvaluationMemoryVerdict;
  readonly limit?: number;
}

export interface EvaluationPlaneScorecardInput {
  readonly tenantId?: string;
  readonly userId?: string;
  readonly planes?: ReadonlyArray<EvaluationMemoryPlane>;
}

export interface EvaluationPlaneScorecard {
  readonly plane: EvaluationMemoryPlane;
  readonly totalRuns: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly inconclusiveCount: number;
  readonly latestRunAt?: string;
  readonly averageScore?: number;
}

export interface IEvaluationMemory {
  recordRun(input: RecordEvaluationRunInput): Promise<EvaluationMemoryWriteResult>;

  listRuns(input: EvaluationMemoryListInput): Promise<ReadonlyArray<EvaluationMemoryRunRecord>>;

  getPlaneScorecard(
    input: EvaluationPlaneScorecardInput,
  ): Promise<ReadonlyArray<EvaluationPlaneScorecard>>;
}