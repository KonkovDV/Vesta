import type { IPromptInjectionScanner } from '../../../domain/security/prompt-injection-scanner.port';

export function flagInjection(
  scanner: IPromptInjectionScanner | undefined,
  text: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  if (!scanner) {
    return payload;
  }
  const scan = scanner.detectSuspiciousPatterns(text);
  if (!scan.hasSuspiciousContent) {
    return payload;
  }
  return {
    ...payload,
    injection: {
      flagged: true,
      matchCount: scan.matchCount,
      tier: scan.tier,
    },
  };
}
