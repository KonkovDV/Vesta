/**
 * TaskPrioritizerAdapter — Infrastructure Adapter
 *
 * Prioritizes tasks using keyword heuristics + ILlmJudge fallback.
 * Ch.20: "Project Management Agent" — keyword → priority scoring
 *
 * Sources (March 2026):
 * - Gulli Ch.20: keyword-based urgency/impact mapping
 * - OpenEvolve evaluator cascade: quick heuristic → expensive LLM fallback
 *
 * DI: constructor(judge: ILlmJudge, logger: IStructuredLogger) — 2 args
 */
import type { CorrelationId } from '../../core/types/branded';
import type { ILogger } from '../../core/decorators/ILogger';
import type { ILlmJudge } from '../../domain/evaluation/llm-judge.interface';
import type {
  ITaskPrioritizer,
  TaskInput,
  TaskPriority,
  PrioritizedTask,
} from '../../domain/scheduling/task-prioritizer.interface';

/** Keyword heuristic maps — Ch.20 PM Agent patterns */
const PRIORITY_KEYWORDS: Record<TaskPriority, readonly string[]> = {
  critical: ['outage', 'data loss', 'security breach', 'p0', 'incident', 'blocker', 'critical'],
  high: ['urgent', 'deadline', 'regression', 'p1', 'breaking', 'production', 'high-priority'],
  medium: ['feature', 'improvement', 'refactor', 'p2', 'enhancement', 'medium-priority'],
  low: ['nice-to-have', 'chore', 'docs', 'p3', 'minor', 'low-priority', 'cosmetic'],
};

/** Weight map — title keywords score higher than description */
const FIELD_WEIGHTS = { title: 3.0, description: 1.0, labels: 2.0 } as const;

/** Minimum heuristic score to avoid LLM fallback */
const HEURISTIC_CONFIDENCE_THRESHOLD = 30;

export class TaskPrioritizerAdapter implements ITaskPrioritizer {
  constructor(
    private readonly judge: ILlmJudge,
    private readonly logger: ILogger,
  ) {}

  async prioritize(
    tasks: readonly TaskInput[],
    correlationId: CorrelationId,
  ): Promise<readonly PrioritizedTask[]> {
    this.logger.info('TaskPrioritizerAdapter.prioritize', {
      correlationId,
      taskCount: tasks.length,
    });

    // FIX-S2-02: Promise.allSettled — one failed evaluation must not crash entire batch
    const settled = await Promise.allSettled(
      tasks.map((task) => this.prioritizeSingle(task, correlationId)),
    );

    const results: PrioritizedTask[] = [];
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        this.logger.warn('TaskPrioritizerAdapter.prioritize.taskFailed', {
          correlationId,
          taskTitle: tasks[i].title,
          error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
        // Assign lowest priority to failed tasks instead of crashing batch
        results.push({
          task: tasks[i],
          priority: 'low',
          score: 0,
          reasoning: `Prioritization failed: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
          matchedKeywords: [],
        });
      }
    }

    return [...results].sort((a, b) => b.score - a.score);
  }

  async prioritizeSingle(
    task: TaskInput,
    correlationId: CorrelationId,
  ): Promise<PrioritizedTask> {
    const { score, priority, matchedKeywords } = this.scoreByKeywords(task);

    // If heuristic is confident enough, skip LLM
    if (score >= HEURISTIC_CONFIDENCE_THRESHOLD) {
      return {
        task,
        priority,
        score,
        reasoning: `Keyword heuristic: matched [${matchedKeywords.join(', ')}]`,
        matchedKeywords,
      };
    }

    // LLM fallback for ambiguous tasks
    return this.scoreLlmFallback(task, score, matchedKeywords, correlationId);
  }

  /** Keyword heuristic scoring — fast, no LLM call */
  private scoreByKeywords(task: TaskInput): {
    score: number;
    priority: TaskPriority;
    matchedKeywords: string[];
  } {
    const text = {
      title: task.title.toLowerCase(),
      description: task.description.toLowerCase(),
      labels: (task.labels ?? []).map((l) => l.toLowerCase()).join(' '),
    };

    let bestScore = 0;
    let bestPriority: TaskPriority = 'low';
    const matchedKeywords: string[] = [];

    const priorityScores: Record<TaskPriority, number> = {
      critical: 100,
      high: 75,
      medium: 50,
      low: 25,
    };

    for (const [priority, keywords] of Object.entries(PRIORITY_KEYWORDS) as [TaskPriority, readonly string[]][]) {
      for (const keyword of keywords) {
        let fieldScore = 0;
        if (text.title.includes(keyword)) fieldScore += FIELD_WEIGHTS.title;
        if (text.description.includes(keyword)) fieldScore += FIELD_WEIGHTS.description;
        if (text.labels.includes(keyword)) fieldScore += FIELD_WEIGHTS.labels;

        if (fieldScore > 0) {
          matchedKeywords.push(keyword);
          // Normalize by max single-field weight so a title match alone gives full score
          // (Ch.20: heuristic should be generous, LLM is the expensive fallback)
          const candidateScore = priorityScores[priority] * Math.min(1, fieldScore / FIELD_WEIGHTS.title);
          if (candidateScore > bestScore) {
            bestScore = candidateScore;
            bestPriority = priority;
          }
        }
      }
    }

    return { score: Math.round(bestScore), priority: bestPriority, matchedKeywords };
  }

  /** LLM fallback — uses ILlmJudge to assess priority when heuristics fail */
  private async scoreLlmFallback(
    task: TaskInput,
    heuristicScore: number,
    heuristicKeywords: string[],
    correlationId: CorrelationId,
  ): Promise<PrioritizedTask> {
    try {
      const rubric = {
        criteria: [
          { name: 'urgency', description: 'Time sensitivity and business impact', scale: { min: 0, max: 10 }, weight: 1.5 },
          { name: 'impact', description: 'Scope of affected users or systems', scale: { min: 0, max: 10 }, weight: 1.0 },
          { name: 'complexity', description: 'Estimated effort and risk', scale: { min: 0, max: 10 }, weight: 0.5 },
        ],
        outputFormat: 'json' as const,
        passThreshold: 7.0,
      };

      const content = `Task: ${task.title}\nDescription: ${task.description}\nLabels: ${(task.labels ?? []).join(', ')}`;
      const result = await this.judge.judge(content, rubric, correlationId);

      const score = Math.round((result.overallScore / 10) * 100);
      const priority = this.scoreToPriority(score);

      return {
        task,
        priority,
        score,
        reasoning: `LLM evaluation: ${result.rationale}`,
        matchedKeywords: heuristicKeywords,
      };
    } catch (error) {
      // Fail-safe: return heuristic result if LLM unavailable
      this.logger.warn('TaskPrioritizerAdapter.scoreLlmFallback failed, using heuristic', {
        correlationId,
        error: (error as Error).message,
      });
      const priority = this.scoreToPriority(heuristicScore);
      return {
        task,
        priority,
        score: heuristicScore,
        reasoning: 'Heuristic only (LLM unavailable)',
        matchedKeywords: heuristicKeywords,
      };
    }
  }

  private scoreToPriority(score: number): TaskPriority {
    if (score >= 80) return 'critical';
    if (score >= 60) return 'high';
    if (score >= 40) return 'medium';
    return 'low';
  }
}
