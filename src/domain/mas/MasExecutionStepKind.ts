/**
 * MasExecutionStepKind - Domain enum for MAS execution step kinds.
 *
 * Layer: Domain (enterprise business rules)
 */

export enum MasExecutionStepKind {
  SYSTEM = 'system',
  AGENT = 'agent',
  TOOL = 'tool',
  LLM = 'llm',
  MEMORY = 'memory',
}
