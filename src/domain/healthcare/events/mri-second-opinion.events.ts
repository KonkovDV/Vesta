import { DomainEvent } from '../../../core/domain/AggregateRoot';
import { EntityId } from '../../../core/types';
import type {
  MriCaseFinalizedPayload,
  MriHumanReviewCompletedPayload,
  MriInferenceCompletedPayload,
  MriSafetyFlagRaisedPayload,
  MriStudySubmittedPayload,
} from '../../../core/events/mri-second-opinion.schemas';

/**
 * Domain events for the MRI Second Opinion CDS workflow.
 *
 * Event lifecycle: Submitted → InferenceCompleted → HumanReviewCompleted → Finalized
 * Safety flags can be raised at any point before finalization.
 *
 * Naming follows the existing PatientCase convention:
 * <AggregateName><PastTenseVerb>
 *
 * @see src/core/events/mri-second-opinion.schemas.ts — Zod validation
 */

// ── Event Types ────────────────────────────────────────────────────

export const MriSecondOpinionEvents = {
  StudySubmitted: 'MriSecondOpinionStudySubmitted',
  InferenceCompleted: 'MriSecondOpinionInferenceCompleted',
  HumanReviewCompleted: 'MriSecondOpinionHumanReviewCompleted',
  CaseFinalized: 'MriSecondOpinionCaseFinalized',
  SafetyFlagRaised: 'MriSecondOpinionSafetyFlagRaised',
} as const;

// ── Event Interfaces ───────────────────────────────────────────────

export interface MriStudySubmittedEvent extends DomainEvent {
  type: typeof MriSecondOpinionEvents.StudySubmitted;
  payload: MriStudySubmittedPayload;
}

export interface MriInferenceCompletedEvent extends DomainEvent {
  type: typeof MriSecondOpinionEvents.InferenceCompleted;
  payload: MriInferenceCompletedPayload;
}

export interface MriHumanReviewCompletedEvent extends DomainEvent {
  type: typeof MriSecondOpinionEvents.HumanReviewCompleted;
  payload: MriHumanReviewCompletedPayload;
}

export interface MriCaseFinalizedEvent extends DomainEvent {
  type: typeof MriSecondOpinionEvents.CaseFinalized;
  payload: MriCaseFinalizedPayload;
}

export interface MriSafetyFlagRaisedEvent extends DomainEvent {
  type: typeof MriSecondOpinionEvents.SafetyFlagRaised;
  payload: MriSafetyFlagRaisedPayload;
}

// ── Factory Functions ──────────────────────────────────────────────

export function createMriStudySubmittedEvent(
  aggregateId: EntityId,
  version: number,
  payload: MriStudySubmittedEvent['payload'],
  correlationId?: string,
): MriStudySubmittedEvent {
  return {
    eventId: `evt_${aggregateId.toString()}_${Date.now()}_study_submitted`,
    type: MriSecondOpinionEvents.StudySubmitted,
    timestamp: new Date(),
    aggregateId: aggregateId.toString(),
    aggregateVersion: version,
    correlationId: correlationId ?? '',
    payload,
  };
}

export function createMriInferenceCompletedEvent(
  aggregateId: EntityId,
  version: number,
  payload: MriInferenceCompletedEvent['payload'],
  correlationId?: string,
): MriInferenceCompletedEvent {
  return {
    eventId: `evt_${aggregateId.toString()}_${Date.now()}_inference_completed`,
    type: MriSecondOpinionEvents.InferenceCompleted,
    timestamp: new Date(),
    aggregateId: aggregateId.toString(),
    aggregateVersion: version,
    correlationId: correlationId ?? '',
    payload,
  };
}

export function createMriHumanReviewCompletedEvent(
  aggregateId: EntityId,
  version: number,
  payload: MriHumanReviewCompletedEvent['payload'],
  correlationId?: string,
): MriHumanReviewCompletedEvent {
  return {
    eventId: `evt_${aggregateId.toString()}_${Date.now()}_human_review_completed`,
    type: MriSecondOpinionEvents.HumanReviewCompleted,
    timestamp: new Date(),
    aggregateId: aggregateId.toString(),
    aggregateVersion: version,
    correlationId: correlationId ?? '',
    payload,
  };
}

export function createMriCaseFinalizedEvent(
  aggregateId: EntityId,
  version: number,
  payload: MriCaseFinalizedEvent['payload'],
  correlationId?: string,
): MriCaseFinalizedEvent {
  return {
    eventId: `evt_${aggregateId.toString()}_${Date.now()}_case_finalized`,
    type: MriSecondOpinionEvents.CaseFinalized,
    timestamp: new Date(),
    aggregateId: aggregateId.toString(),
    aggregateVersion: version,
    correlationId: correlationId ?? '',
    payload,
  };
}

export function createMriSafetyFlagRaisedEvent(
  aggregateId: EntityId,
  version: number,
  payload: MriSafetyFlagRaisedEvent['payload'],
  correlationId?: string,
): MriSafetyFlagRaisedEvent {
  return {
    eventId: `evt_${aggregateId.toString()}_${Date.now()}_safety_flag_raised`,
    type: MriSecondOpinionEvents.SafetyFlagRaised,
    timestamp: new Date(),
    aggregateId: aggregateId.toString(),
    aggregateVersion: version,
    correlationId: correlationId ?? '',
    payload,
  };
}

// ── Type Guards ────────────────────────────────────────────────────

export function isMriStudySubmittedEvent(event: DomainEvent): event is MriStudySubmittedEvent {
  return event.type === MriSecondOpinionEvents.StudySubmitted;
}

export function isMriInferenceCompletedEvent(event: DomainEvent): event is MriInferenceCompletedEvent {
  return event.type === MriSecondOpinionEvents.InferenceCompleted;
}

export function isMriHumanReviewCompletedEvent(event: DomainEvent): event is MriHumanReviewCompletedEvent {
  return event.type === MriSecondOpinionEvents.HumanReviewCompleted;
}

export function isMriCaseFinalizedEvent(event: DomainEvent): event is MriCaseFinalizedEvent {
  return event.type === MriSecondOpinionEvents.CaseFinalized;
}

export function isMriSafetyFlagRaisedEvent(event: DomainEvent): event is MriSafetyFlagRaisedEvent {
  return event.type === MriSecondOpinionEvents.SafetyFlagRaised;
}
