import { DomainEvent } from '../../../core/domain/AggregateRoot';
import { EntityId } from '../../../core/types';

// Event Types
export const PatientCaseEvents = {
  Opened: 'PatientCaseOpened',
  SymptomsAnalyzed: 'PatientCaseSymptomsAnalyzed',
  ResearchApplied: 'PatientCaseResearchApplied',
} as const;

// 1. Patient Case Opened
export interface PatientCaseOpenedEvent extends DomainEvent {
  type: typeof PatientCaseEvents.Opened;
  payload: {
    patientId: string;
    symptoms: string[];
  };
}

export function createPatientCaseOpenedEvent(
  aggregateId: EntityId,
  version: number,
  payload: PatientCaseOpenedEvent['payload'],
  correlationId?: string
): PatientCaseOpenedEvent {
  return {
    eventId: `evt_${aggregateId.toString()}_${Date.now()}_opened`,
    type: PatientCaseEvents.Opened,
    timestamp: new Date(),
    aggregateId: aggregateId.toString(),
    aggregateVersion: version,
    correlationId: correlationId || '',
    payload
  };
}

// 2. Symptoms Analyzed
export interface PatientCaseSymptomsAnalyzedEvent extends DomainEvent {
  type: typeof PatientCaseEvents.SymptomsAnalyzed;
  payload: {
    primaryCondition: string;
    confidence: number;
    rationale: string[];
    recommendations: string[];
  };
}

export function createSymptomsAnalyzedEvent(
  aggregateId: EntityId,
  version: number,
  payload: PatientCaseSymptomsAnalyzedEvent['payload'],
  correlationId?: string
): PatientCaseSymptomsAnalyzedEvent {
  return {
    eventId: `evt_${aggregateId.toString()}_${Date.now()}_analyzed`,
    type: PatientCaseEvents.SymptomsAnalyzed,
    timestamp: new Date(),
    aggregateId: aggregateId.toString(),
    aggregateVersion: version,
    correlationId: correlationId || '',
    payload
  };
}

// 3. Research Applied
export interface PatientCaseResearchAppliedEvent extends DomainEvent {
  type: typeof PatientCaseEvents.ResearchApplied;
  payload: {
    trialsCount: number;
    variantsCount: number;
    newConfidence: number;
    addedRecommendations: string[];
  };
}

export function createResearchAppliedEvent(
  aggregateId: EntityId,
  version: number,
  payload: PatientCaseResearchAppliedEvent['payload'],
  correlationId?: string
): PatientCaseResearchAppliedEvent {
  return {
    eventId: `evt_${aggregateId.toString()}_${Date.now()}_research`,
    type: PatientCaseEvents.ResearchApplied,
    timestamp: new Date(),
    aggregateId: aggregateId.toString(),
    aggregateVersion: version,
    correlationId: correlationId || '',
    payload
  };
}

// Union Type Helper
export function isPatientCaseOpenedEvent(event: DomainEvent): event is PatientCaseOpenedEvent {
  return event.type === PatientCaseEvents.Opened;
}

export function isSymptomsAnalyzedEvent(event: DomainEvent): event is PatientCaseSymptomsAnalyzedEvent {
  return event.type === PatientCaseEvents.SymptomsAnalyzed;
}

export function isResearchAppliedEvent(event: DomainEvent): event is PatientCaseResearchAppliedEvent {
  return event.type === PatientCaseEvents.ResearchApplied;
}
