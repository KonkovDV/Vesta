import type { IEventStore } from '../../../domain/events/event-store.interface';
import { ISessionMemoryManager } from '../../../domain/memory/ISessionMemoryManager';
import type { IUnifiedPluginRegistry } from '../../plugins/unified-plugin-registry';
import type { IRequestContext } from '../../context/request-context';
import type {
  CorrelationId,
  SessionId,
  TenantId,
  UserId,
} from '../../../domain/memory/session-types';
import { DomainError, InfrastructureError } from '../../../domain/errors/DomainError';
import { EntityId } from '../../../core/types';
import { PatientCase } from '../../../domain/healthcare/aggregates/PatientCase';

// Keep interface for backward compatibility
interface DiagnosisResult {
  primaryDiagnosis: string;
  confidence: number;
  recommendations: string[];
  clinicalTrials?: unknown[];
  geneticVariants?: unknown[];
}

export class DiagnosisSupportUseCase {
  constructor(
    private readonly eventStore: IEventStore,
    private readonly sessionManager: ISessionMemoryManager,
    private readonly pluginRegistry: IUnifiedPluginRegistry,
  ) {}

  async analyzePatient(
    patientId: string,
    symptoms: string[],
    context: IRequestContext
  ): Promise<DiagnosisResult> {
    const correlationId = String(context.getCorrelationId());
    const tenantId = (context.getTenantId() ?? 'default') as unknown as TenantId;
    const sessionId = `patient_${patientId}`;

    try {
      // 1. Create Aggregate (Draft/Open State)
      // In a real scenario we might load an existing one, but the previous logic implies a fresh analysis per request.
      const patientCase = PatientCase.create(
        EntityId.fromString(patientId),
        symptoms
      );

      // 2. Fetch Context (History)
      // We don't inject this INTO the aggregate, but we could use it for future decision making.
      // For now, adhering to the original logic which just fetched it (and logged it essentially).
      const history = await this.sessionManager.get_context_window({
        tenant_id: tenantId,
        session_id: sessionId,
        max_messages: 100,
        correlation_id: correlationId,
      });

      // 3. Domain Analysis (Pure Logic)
      patientCase.analyze();

      // 4. External Enrichment (Plugins)
      const [trialsResult, variantsResult] = await Promise.all([
        this.pluginRegistry.call<
          { skill: string; script: string; args: string[] },
          unknown[]
        >(
          'scientific-skills@1.0.0',
          {
            skill: 'clinicaltrials-database',
            script: 'search_trials.py',
            args: ['--condition', symptoms[0] || 'general', '--limit', '5'],
          },
          context,
        ),
        this.pluginRegistry.call<
          { skill: string; script: string; args: string[] },
          unknown[]
        >(
          'scientific-skills@1.0.0',
          {
            skill: 'clinvar-database',
            script: 'search_variants.py',
            args: ['--gene', 'BRCA1', '--limit', '5'],
          },
          context,
        ),
      ]);

      const trials =
        trialsResult.success && Array.isArray(trialsResult.data)
          ? trialsResult.data
          : [];
          
      const variants =
        variantsResult.success && Array.isArray(variantsResult.data)
          ? variantsResult.data
          : [];

      // 5. Enrich Aggregate
      patientCase.enrich(trials.length, variants.length);

      // 6. Persistence (Save Events)
      // We explicitly cast to any to bypass potential type mismatch if IEventStore isn't perfectly aligned 
      // with the base Event class, though it should be.
      await this.eventStore.saveEvents(patientCase.getEvents());

      // 7. Session Update (Side Effect)
      // Adapter: Map Domain State to DTO using public getter
      const diagnosisVO = patientCase.getDiagnosis();

      const result: DiagnosisResult = {
        primaryDiagnosis: diagnosisVO?.primaryCondition ?? 'Unknown',
        confidence: diagnosisVO?.confidence ?? 0,
        recommendations: [...(diagnosisVO?.recommendations ?? [])],
        clinicalTrials: trials,
        geneticVariants: variants,
      };

      await this.sessionManager.add_message({
        tenant_id: tenantId,
        session_id: sessionId,
        user_id: 'system',
        role: 'assistant',
        content: JSON.stringify(result),
        correlation_id: correlationId,
      });

      return result;

    } catch (error: unknown) {
      if (error instanceof DomainError) {
        throw error;
      }

      throw new InfrastructureError('Diagnosis analysis failed', {
        correlationId,
        metadata: {
          patientId,
          symptoms,
        },
        cause: error instanceof Error ? error : undefined,
      });
    }
  }
}
