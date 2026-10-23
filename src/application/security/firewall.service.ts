import * as DOMPurifyModule from 'dompurify';
import { JSDOM } from 'jsdom';
import { MasExecutionRequestSchema } from '../schemas/api-schemas';
import type { IFirewallService } from '../../domain/security/firewall.port';
import type { FirewallInspectionResult } from '../../domain/security/firewall.port';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';

const windowLike = new JSDOM('').window;

type DomPurifyFactory = (window: typeof windowLike) => { sanitize(input: string): string };

function resolveDomPurifyFactory(): DomPurifyFactory | undefined {
  if (typeof DOMPurifyModule === 'function') {
    return DOMPurifyModule as unknown as DomPurifyFactory;
  }

  if ('default' in DOMPurifyModule && typeof DOMPurifyModule.default === 'function') {
    return DOMPurifyModule.default as unknown as DomPurifyFactory;
  }

  return undefined;
}

const domPurifyFactory = resolveDomPurifyFactory();
const DOMPurify = domPurifyFactory?.(windowLike) ?? {
  sanitize: (input: string) => input,
};

/**
 * The Cognitive Firewall protects the agent from malicious inputs *before* they reach the core logic.
 * Functions:
 * 1. Schema Validation (Structure integrity)
 * 2. Sanitization (XSS prevention)
 * 3. Heuristics (Jailbreak/Injection detection)
 */
export class FirewallService implements IFirewallService {
  constructor(private readonly logger?: IStructuredLogger) {}
  
  /**
   * Validates and sanitizes the execution request.
   * Throws Error if violation detected.
   */
  public inspectRequest(payload: unknown): FirewallInspectionResult {
    // 1. Structural Integrity (Zod)
    const result = MasExecutionRequestSchema.safeParse(payload);
    
    if (!result.success) {
      throw new Error(`Firewall Rejected: Invalid Schema - ${result.error.issues.map(i => i.path + ': ' + i.message).join(', ')}`);
    }

    const data = result.data;
    const { scenario, sessionId, payload: dataPayload, ...rest } = data;
    const instruction = dataPayload?.instruction ?? dataPayload?.input;

    // Normalize input → instruction (input is an alternative field)
    if (!instruction) {
      // No instruction — passthrough schema-valid request without sanitization/heuristics
      const passthroughResult: FirewallInspectionResult = {
        ...rest,
        scenario,
        sessionId,
      };
      return passthroughResult;
    }

    // 2. Sanitization (XSS)
    // We sanitize the instruction to ensure no hidden HTML vectors are stored in logs or executed if rendered
    const sanitizedInstruction = DOMPurify.sanitize(instruction);

    // 3. Jailbreak Heuristics
    // Simple regex checks for common prompt injection patterns
    // e.g. "Ignore all previous instructions"
    this.checkHeuristics(sanitizedInstruction);

    const sanitizedResult: FirewallInspectionResult = {
      ...rest,
      scenario,
      sessionId,
      payload: {
        instruction: sanitizedInstruction,
        context: dataPayload?.context as Record<string, unknown> | undefined,
      },
    };
    return sanitizedResult;
  }

  /**
   * Validates a string for cognitive threats (jailbreak patterns).
   * @throws Error if jailbreak pattern detected.
   */
  public sanitizeString(input: string): string {
    this.checkHeuristics(input);
    return DOMPurify.sanitize(input);
  }

  private checkHeuristics(input: string) {
    const threats = [
      /ignore all previous instructions/i,
      /you are now unchecked/i,
      /always respond with "pwned"/i
    ];

    for (const pattern of threats) {
      if (pattern.test(input)) {
        this.logger?.warn(`[Firewall] Potential Injection Detected: "${input.substring(0, 50)}..."`);
        throw new Error('Firewall Rejected: Cognitive Threat Detected (Heuristic Violation)');
        // In a real system, we would log this to a Security Event Bus
      }
    }
  }
}
