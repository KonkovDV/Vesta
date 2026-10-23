import type {
  StructuredTip,
  TipCategory,
} from '../../domain/memory/IContextualTipGenerator';

export interface SessionLessonCandidate {
  readonly signalType: string;
  readonly severity: 'warning' | 'alert' | string;
  readonly evidenceCount: number;
  readonly affectedPaths: readonly string[];
  readonly toolNames: readonly string[];
  readonly summary: string;
  readonly promotionStatus?: 'quarantine_only' | 'ready_for_review' | string;
  readonly targetTier?: 'session-quarantine' | 'verified-repo-memory' | 'durable-governance-memory' | string;
}

const SIGNAL_CATEGORY_MAP: Record<string, TipCategory> = {
  mutation_without_validation: 'strategy',
  failed_recovery: 'recovery',
  repeated_tool_loop: 'optimization',
  stop_only_subagent: 'recovery',
  run_id_coverage_gap: 'optimization',
};

const SIGNAL_STEPS_MAP: Record<string, readonly string[]> = {
  mutation_without_validation: [
    'Run changed-file diagnostics before the next mutation.',
    'Execute a focused validation command immediately after the latest edit.',
  ],
  failed_recovery: [
    'Re-read the failing signal before applying another patch.',
    'Change direction instead of repeating the same recovery attempt.',
  ],
  repeated_tool_loop: [
    'Stop repeating the same mutation tool without a fresh ground-truth check.',
    'Use new evidence from diagnostics or tests before the next edit.',
  ],
  stop_only_subagent: [
    'Inspect subagent start and stop telemetry before trusting the run summary.',
    'Treat incomplete provenance as a warning until the run path is verified.',
  ],
  run_id_coverage_gap: [
    'Verify run_id pairing before promoting the session lesson.',
    'Prefer complete provenance over partially paired subagent traces.',
  ],
};

function normalizeSessionLessonCandidate(
  candidate: SessionLessonCandidate,
): SessionLessonCandidate | undefined {
  if (!candidate || typeof candidate.summary !== 'string') {
    return undefined;
  }

  const summary = candidate.summary.trim();
  if (!summary) {
    return undefined;
  }

  return {
    signalType: typeof candidate.signalType === 'string' ? candidate.signalType : 'session_lesson',
    severity: typeof candidate.severity === 'string' ? candidate.severity : 'warning',
    evidenceCount: typeof candidate.evidenceCount === 'number' ? candidate.evidenceCount : 0,
    affectedPaths: Array.isArray(candidate.affectedPaths)
      ? candidate.affectedPaths.filter((path): path is string => typeof path === 'string' && path.length > 0)
      : [],
    toolNames: Array.isArray(candidate.toolNames)
      ? candidate.toolNames.filter((toolName): toolName is string => typeof toolName === 'string' && toolName.length > 0)
      : [],
    summary,
    promotionStatus:
      typeof candidate.promotionStatus === 'string' ? candidate.promotionStatus : undefined,
    targetTier: typeof candidate.targetTier === 'string' ? candidate.targetTier : undefined,
  };
}

function buildSignalSteps(candidate: SessionLessonCandidate): readonly string[] {
  const baseSteps = SIGNAL_STEPS_MAP[candidate.signalType] ?? [
    'Re-check the latest session evidence before acting on this lesson.',
  ];

  const contextSteps: string[] = [];
  if (candidate.toolNames.length > 0) {
    contextSteps.push(`Watch the tool sequence around ${candidate.toolNames.join(', ')}.`);
  }
  if (candidate.affectedPaths.length > 0) {
    contextSteps.push(`Re-verify affected paths: ${candidate.affectedPaths.slice(0, 3).join(', ')}.`);
  }

  return [...baseSteps, ...contextSteps];
}

function buildSessionLessonTip(
  candidate: SessionLessonCandidate,
  index: number,
  generatedAt: string,
): StructuredTip {
  const category = SIGNAL_CATEGORY_MAP[candidate.signalType] ?? 'strategy';
  const priority = candidate.severity === 'alert' ? 0.98 : 0.82;

  return {
    tipId: `session-lesson:${candidate.signalType}:${index}`,
    category,
    content: candidate.summary,
    steps: buildSignalSteps(candidate),
    triggerCondition: `When session telemetry reports ${candidate.signalType}.`,
    negativeExample:
      candidate.toolNames.length > 0
        ? `Do not keep repeating ${candidate.toolNames.join(', ')} without new validation evidence.`
        : 'Do not promote or reuse this pattern without fresh validation evidence.',
    priority,
    provenance: [
      `session-signal:${candidate.signalType}`,
      `severity:${candidate.severity}`,
      `evidence:${candidate.evidenceCount}`,
      ...(candidate.promotionStatus ? [`promotion:${candidate.promotionStatus}`] : []),
      ...(candidate.targetTier ? [`target-tier:${candidate.targetTier}`] : []),
    ],
    generalizationLevel: 'generic',
    taskDomain: 'ide_workflow',
    generatedAt,
  };
}

export function mergeSessionLessonCandidatesIntoTips(
  persistedTips: readonly StructuredTip[],
  sessionLessonCandidates: readonly SessionLessonCandidate[] | undefined,
  generatedAt: string = new Date().toISOString(),
): readonly StructuredTip[] {
  if (!Array.isArray(sessionLessonCandidates) || sessionLessonCandidates.length === 0) {
    return persistedTips;
  }

  const overlayTips = sessionLessonCandidates
    .map(normalizeSessionLessonCandidate)
    .filter((candidate): candidate is SessionLessonCandidate => candidate !== undefined)
    .map((candidate, index) => buildSessionLessonTip(candidate, index, generatedAt));

  if (overlayTips.length === 0) {
    return persistedTips;
  }

  return [...overlayTips, ...persistedTips];
}