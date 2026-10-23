import { AggregateRoot, DomainEvent } from '../../../core/domain/AggregateRoot';
import { EntityId } from '../../../core/types';
import { DomainInvariantViolationError } from '../../errors/DomainError';
import { Symptom } from '../value-objects/Symptom';
import { Diagnosis } from '../value-objects/Diagnosis';
import {
  createPatientCaseOpenedEvent,
  createSymptomsAnalyzedEvent,
  createResearchAppliedEvent,
  isPatientCaseOpenedEvent,
  isSymptomsAnalyzedEvent,
  isResearchAppliedEvent,
  type PatientCaseOpenedEvent,
  type PatientCaseSymptomsAnalyzedEvent,
  type PatientCaseResearchAppliedEvent,
} from '../events';

export type PatientCaseStatus = 'Open' | 'Analyzed' | 'Enriched' | 'Closed';

export interface PatientCaseProps {
  patientId: EntityId;
  symptoms: Symptom[];
  diagnosis: Diagnosis | null;
  status: PatientCaseStatus;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

interface DiagnosisSnapshot {
  primaryCondition: string;
  confidence: number;
  rationale: string[];
  recommendations: string[];
}

function isDiagnosisSnapshot(value: unknown): value is DiagnosisSnapshot {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const snapshot = value as Record<string, unknown>;
  return (
    typeof snapshot.primaryCondition === 'string' &&
    typeof snapshot.confidence === 'number' &&
    Array.isArray(snapshot.rationale) &&
    snapshot.rationale.every((item) => typeof item === 'string') &&
    Array.isArray(snapshot.recommendations) &&
    snapshot.recommendations.every((item) => typeof item === 'string')
  );
}

export class PatientCase extends AggregateRoot<PatientCaseProps> {
  private constructor(id: EntityId, props: PatientCaseProps, version: number) {
    super(id, props, version);
  }

  // =========================================================================================
  // Factory Methods
  // =========================================================================================

  static create(patientId: EntityId, rawSymptoms: string[]): PatientCase {
    const id = EntityId.random();
    const now = new Date();
    
    // Validate empty symptoms at the gate
    if (rawSymptoms.length === 0) {
      throw new DomainInvariantViolationError(
        'PATIENT_CASE_NO_SYMPTOMS',
        'Cannot create patient case without symptoms',
        {}
      );
    }

    const symptoms = rawSymptoms.map(Symptom.fromString);

    const initialProps: PatientCaseProps = {
      patientId,
      symptoms,
      diagnosis: null,
      status: 'Open',
      metadata: {},
      createdAt: now,
      updatedAt: now,
    };

    const patientCase = new PatientCase(id, initialProps, 1);

    const event = createPatientCaseOpenedEvent(
      id,
      1,
      {
        patientId: patientId.toString(),
        symptoms: rawSymptoms,
      }
    );

    patientCase.addEvent(event);
    patientCase.applyEvent(event);

    return patientCase;
  }

  static restoreFromHistory(id: EntityId, events: DomainEvent[]): PatientCase {
    if (events.length === 0) {
      throw new DomainInvariantViolationError(
        'PATIENT_CASE_EMPTY_HISTORY',
        'Cannot restore PatientCase from empty history',
        { metadata: { aggregateId: id.toString() } }
      );
    }

    // Placeholders - will be overwritten by applyEvent logic
    const placeholderProps: PatientCaseProps = {
      patientId: EntityId.fromString('00000000-0000-0000-0000-000000000000'), // Temporary
      symptoms: [],
      diagnosis: null,
      status: 'Open',
      metadata: {},
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };

    const firstEvent = events[0];
    const patientCase = new PatientCase(id, placeholderProps, firstEvent.aggregateVersion);

    for (const event of events) {
      patientCase.applyEvent(event);
    }

    patientCase.clearEvents();
    return patientCase;
  }

  static restoreFromSnapshot(snapshot: Record<string, unknown>): PatientCase {
    const id = EntityId.fromString(String(snapshot.id));
    const version = Number(snapshot.version) || 1;
    const diagnosisSnapshot = isDiagnosisSnapshot(snapshot.diagnosis) ? snapshot.diagnosis : null;
    
    // Safe hydration logic could be more robust here, but assuming valid snapshot for now
    const props: PatientCaseProps = {
      patientId: EntityId.fromString(String(snapshot.patientId)),
      symptoms: (snapshot.symptoms as string[]).map(Symptom.fromString),
      diagnosis: diagnosisSnapshot 
        ? Diagnosis.create(
            diagnosisSnapshot.primaryCondition,
            diagnosisSnapshot.confidence,
            diagnosisSnapshot.rationale,
            diagnosisSnapshot.recommendations
          )
        : null,
      status: snapshot.status as PatientCaseStatus,
      metadata: (snapshot.metadata as Record<string, unknown>) || {},
      createdAt: new Date(String(snapshot.createdAt)),
      updatedAt: new Date(String(snapshot.updatedAt)),
    };

    return new PatientCase(id, props, version);
  }

  // =========================================================================================
  // Domain Behavior
  // =========================================================================================

  analyze(): void {
    if (this.props.status === 'Closed') {
      throw new DomainInvariantViolationError(
        'PATIENT_CASE_CLOSED',
        'Cannot analyze closed case',
        { metadata: { id: this.id.toString() } }
      );
    }

    // Pure Domain Logic (Regex Matching)
    // In a real system, this might be a Domain Service, but for now it fits here as "Self Analysis"
    // or we could inject a DiagnosticsEngine. To keep it simple per requirements:
    
    const { diagnosisResult } = this.calculateDiagnosis();

    const event = createSymptomsAnalyzedEvent(
      this.id,
      this.version,
      {
        primaryCondition: diagnosisResult.primaryCondition,
        confidence: diagnosisResult.confidence,
        rationale: diagnosisResult.rationale,
        recommendations: diagnosisResult.recommendations,
      }
    );

    this.addEvent(event);
    this.applyEvent(event);
  }

  enrich(trialsCount: number, variantsCount: number): void {
     if (this.props.status !== 'Analyzed' && this.props.status !== 'Enriched') {
      // Can't enrich before analysis
       throw new DomainInvariantViolationError(
        'PATIENT_CASE_NOT_ANALYZED',
        'Must analyze symptoms before enriching with external research',
        { metadata: { status: this.props.status } }
      );
    }

    // Domain Logic: Adjust confidence based on findings
    let newConfidence = this.props.diagnosis?.confidence || 0;
    const addedRecs: string[] = [];

    if (trialsCount > 0) {
      newConfidence = Math.min(newConfidence + 0.1, 1.0);
      addedRecs.push(`Found ${trialsCount} relevant clinical trials`);
    }
    
    if (variantsCount > 0) {
       newConfidence = Math.min(newConfidence + 0.15, 1.0);
       addedRecs.push(`Found ${variantsCount} genetic variants`);
    }

    const event = createResearchAppliedEvent(
      this.id,
      this.version,
      {
        trialsCount,
        variantsCount,
        newConfidence,
        addedRecommendations: addedRecs
      }
    );

    this.addEvent(event);
    this.applyEvent(event);
  }

  private calculateDiagnosis(): { diagnosisResult: { primaryCondition: string, confidence: number, rationale: string[], recommendations: string[] } } {
    const symptomValues = this.props.symptoms.map(s => s.value);
    
    // Logic extracted from old UseCase
    if (symptomValues.some(s => /chest|angina|tachy|palpitation/.test(s))) {
      return {
        diagnosisResult: {
           primaryCondition: 'Possible cardiac-related condition',
           confidence: 0.55,
           rationale: ['Detected cardiac keywords'],
           recommendations: ['ECG', 'Troponin test', 'Cardiology consultation']
        }
      };
    }

    if (symptomValues.some(s => /headache|migraine|seizure|dizziness|vertigo/.test(s))) {
       return {
        diagnosisResult: {
           primaryCondition: 'Possible neurological-related condition',
           confidence: 0.5,
           rationale: ['Detected neurological keywords'],
           recommendations: ['Neurological examination', 'Consider MRI/CT if indicated']
        }
      };
    }

    return {
        diagnosisResult: {
           primaryCondition: 'Non-specific symptoms',
           confidence: 0.35,
           rationale: ['No specific keywords matched'],
           recommendations: ['Collect more history', 'Basic bloodwork', 'Follow-up']
        }
      };
  }

  // =========================================================================================
  // State Mutation (Visitor Pattern)
  // =========================================================================================

  protected when(event: DomainEvent): void {
    if (isPatientCaseOpenedEvent(event)) {
      this.whenOpened(event);
    } else if (isSymptomsAnalyzedEvent(event)) {
      this.whenAnalyzed(event);
    } else if (isResearchAppliedEvent(event)) {
      this.whenEnriched(event);
    }
  }

  private whenOpened(event: PatientCaseOpenedEvent): void {
    this.setProps({
      ...this.props,
      patientId: EntityId.fromString(event.payload.patientId),
      symptoms: event.payload.symptoms.map(Symptom.fromString),
      createdAt: event.timestamp || new Date(),
      updatedAt: event.timestamp || new Date(),
    });
  }

  private whenAnalyzed(event: PatientCaseSymptomsAnalyzedEvent): void {
    const d = event.payload;
    const diagnosis = Diagnosis.create(d.primaryCondition, d.confidence, d.rationale, d.recommendations);
    
    this.setProps({
      ...this.props,
      diagnosis,
      status: 'Analyzed',
      updatedAt: event.timestamp || new Date(),
    });
  }

  private whenEnriched(event: PatientCaseResearchAppliedEvent): void {
    const d = event.payload;
     if (!this.props.diagnosis) return; // Should not happen due to invariant check in methods

    const currentRecs = [...this.props.diagnosis.recommendations];
    const newRecs = [...currentRecs, ...d.addedRecommendations];
    
    const newDiagnosis = Diagnosis.create(
      this.props.diagnosis.primaryCondition,
      d.newConfidence,
      [...this.props.diagnosis.rationale], // Rationale stays same
      newRecs
    );

    this.setProps({
      ...this.props,
      diagnosis: newDiagnosis,
      status: 'Enriched',
      updatedAt: event.timestamp || new Date(),
    });
  }

  // =========================================================================================
  // Getters (Read-only access to preserve immutability)
  // =========================================================================================

  getDiagnosis(): Readonly<{
    primaryCondition: string;
    confidence: number;
    rationale: readonly string[];
    recommendations: readonly string[];
  }> | null {
    const diagnosis = this.props.diagnosis;
    if (!diagnosis) return null;
    return Object.freeze({
      primaryCondition: diagnosis.primaryCondition,
      confidence: diagnosis.confidence,
      rationale: diagnosis.rationale,
      recommendations: diagnosis.recommendations,
    });
  }

  // =========================================================================================
  // Serialization
  // =========================================================================================

  serialize(): Record<string, unknown> {
    return {
      id: this.id.toString(),
      version: this.version,
      patientId: this.props.patientId.toString(),
      symptoms: this.props.symptoms.map(s => s.value),
      diagnosis: this.props.diagnosis ? {
        primaryCondition: this.props.diagnosis.primaryCondition,
        confidence: this.props.diagnosis.confidence,
        rationale: this.props.diagnosis.rationale,
        recommendations: this.props.diagnosis.recommendations,
      } : null,
      status: this.props.status,
      metadata: this.props.metadata,
      createdAt: this.props.createdAt.toISOString(),
      updatedAt: this.props.updatedAt.toISOString(),
    };
  }
}
