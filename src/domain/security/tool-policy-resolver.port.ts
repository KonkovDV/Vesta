/**
 * Tool Policy Resolver Port
 * Layer: Domain (Security)
 *
 * Defines the contract for resolving tool policy rules: name normalisation,
 * tool-group expansion, and profile-to-policy mapping.
 *
 * The implementation lives in Infrastructure (tool-policy.ts) so that the
 * Application layer (ToolPolicyService) never imports infrastructure directly.
 */

/** Canonical tool-profile identifiers. */
export type ToolProfileId = 'minimal' | 'coding' | 'messaging' | 'full';

/** Allow / Deny list pair returned by profile resolution. */
export interface ToolProfilePolicy {
  allow?: string[];
  deny?: string[];
}

/**
 * A single step in the 7-step tool policy pipeline.
 * Each step applies one layer of allow/deny policy in priority order.
 *
 * @donor external/openclaw/src/agents/tool-policy-pipeline.ts
 */
export interface ToolPolicyPipelineStep {
  /** Allow/deny rule set for this step (undefined = skip) */
  policy: ToolProfilePolicy | undefined;
  /** Human-readable label for diagnostics */
  label: string;
  /** Whether to strip plugin-only allowlists (default: false) */
  stripPluginOnlyAllowlist?: boolean;
}

/**
 * Parameters for building the default 7-step pipeline.
 * Maps to 7 layers: profile → providerProfile → global → globalProvider → agent → agentProvider → group.
 */
export interface ToolPolicyPipelineParams {
  profilePolicy?: ToolProfilePolicy;
  profile?: string;
  providerProfilePolicy?: ToolProfilePolicy;
  providerProfile?: string;
  globalPolicy?: ToolProfilePolicy;
  globalProviderPolicy?: ToolProfilePolicy;
  agentPolicy?: ToolProfilePolicy;
  agentProviderPolicy?: ToolProfilePolicy;
  groupPolicy?: ToolProfilePolicy;
  agentId?: string;
}

/**
 * Port contract implemented by infrastructure to provide tool-policy helpers.
 */
export interface IToolPolicyResolver {
  /** Canonical lowercase tool name with alias resolution. */
  normalizeToolName(name: string): string;

  /** Expand `group:*` entries into individual tool names. */
  expandToolGroups(list?: string[]): string[];

  /** Resolve a profile identifier to its Allow/Deny policy (or undefined). */
  resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined;

  /**
   * Build the default 7-step pipeline steps from parameters.
   * @donor external/openclaw/src/agents/tool-policy-pipeline.ts
   */
  buildDefaultPipelineSteps(params: ToolPolicyPipelineParams): readonly ToolPolicyPipelineStep[];

  /**
   * Apply the multi-step tool policy pipeline to a list of tools.
   * Each step filters tools by its allow/deny policy in priority order.
   * @donor external/openclaw/src/agents/tool-policy-pipeline.ts
   */
  applyPipeline<T extends { name: string }>(params: {
    tools: T[];
    toolMeta: (tool: T) => { pluginId: string } | undefined;
    warn: (message: string) => void;
    steps: readonly ToolPolicyPipelineStep[];
  }): T[];
}
