/**
 * ToolPolicyResolverImpl
 * Layer: Infrastructure (Security)
 *
 * Implements the domain IToolPolicyResolver port by delegating to the
 * existing pure-function helpers in tool-policy.ts.
 */
import type {
  IToolPolicyResolver,
  ToolProfilePolicy,
  ToolPolicyPipelineStep,
  ToolPolicyPipelineParams,
} from '../../domain/security/tool-policy-resolver.port';
import {
  normalizeToolName,
  expandToolGroups,
  resolveToolProfilePolicy,
  buildDefaultToolPolicyPipelineSteps,
  applyToolPolicyPipeline,
} from './tool-policy';

export class ToolPolicyResolverImpl implements IToolPolicyResolver {
  normalizeToolName(name: string): string {
    return normalizeToolName(name);
  }

  expandToolGroups(list?: string[]): string[] {
    return expandToolGroups(list);
  }

  resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
    return resolveToolProfilePolicy(profile);
  }

  buildDefaultPipelineSteps(params: ToolPolicyPipelineParams): readonly ToolPolicyPipelineStep[] {
    return buildDefaultToolPolicyPipelineSteps(params);
  }

  applyPipeline<T extends { name: string }>(params: {
    tools: T[];
    toolMeta: (tool: T) => { pluginId: string } | undefined;
    warn: (message: string) => void;
    steps: readonly ToolPolicyPipelineStep[];
  }): T[] {
    return applyToolPolicyPipeline(params);
  }
}
