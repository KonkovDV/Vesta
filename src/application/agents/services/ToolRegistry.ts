
import { injectable, inject, optional } from 'inversify';
import { z } from 'zod';
import { IToolRegistry, IAgentTool } from '../../../domain/agents/tools.interface';
import { IToolExecutionPolicy } from '../../../domain/security/tool-execution-policy.interface';
import { IAgentContext } from '../../../domain/agents/agent-context.interface';
import { ILogger } from '../../../core/decorators/ILogger';
import type { IFirewallService } from '../../../domain/security/firewall.port';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import type { IMcpToolDiscoveryService } from './McpToolDiscoveryService';
import type { IAgentTool as DiscoveredAgentTool } from '../../../domain/ai/IAgentTool';
import type { ToolExecutionContext } from '../../../domain/ai/IAgentTool';

interface ToolValidationError {
  issues?: unknown;
  message?: string;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isApprovalRequiredResult(value: unknown): value is { status: 'approval_required' } {
  return isObjectRecord(value) && value.status === 'approval_required';
}

function toToolExecutionContext(context: IAgentContext): ToolExecutionContext {
  return {
    userId: context.agentId,
    conversationId: context.sessionId,
    sessionId: context.sessionId,
    agentId: context.agentId,
    workspaceRoot: context.workspaceRoot,
    config: context.config,
  };
}

function adaptDiscoveredTool(tool: DiscoveredAgentTool): IAgentTool {
  const schema =
    tool.parameters && typeof tool.parameters === 'object' && 'parse' in tool.parameters
      ? (tool.parameters as z.ZodType<unknown>)
      : z.object({}).passthrough();

  return {
    name: tool.name,
    description: tool.description,
    schema,
    matches: (name: string) => tool.name.toLowerCase() === name.toLowerCase(),
    execute: (args: unknown, context: IAgentContext) =>
      tool.execute(args, toToolExecutionContext(context)),
  };
}

@injectable()
export class ToolRegistry implements IToolRegistry {
  private readonly tools = new Map<string, IAgentTool>();

  constructor(
    @inject('ILogger') private readonly logger: ILogger,
    @inject('IToolExecutionPolicy') private readonly policy: IToolExecutionPolicy,
    @inject(DI_TOKENS.IFirewallService) @optional() private readonly firewall?: IFirewallService,
    @inject(DI_TOKENS.IMcpToolDiscoveryService) @optional() private readonly mcpDiscovery?: IMcpToolDiscoveryService,
  ) {}

  register(tool: IAgentTool): void {
    // A second tool under the same name would shadow the first one, including its
    // workspace checks. Refuse it; unregistering is an explicit, separate decision.
    if (this.tools.has(tool.name)) {
      throw new Error(`ToolRegistry: Tool '${tool.name}' is already registered`);
    }
    this.tools.set(tool.name, tool);
    (this.logger as ILogger).log(`ToolRegistry: Registered tool '${tool.name}'`);
  }

  getTool(name: string): IAgentTool | undefined {
    return this.tools.get(name);
  }

  listTools(agentId?: string): IAgentTool[] {
    return Array.from(this.tools.values());
  }

  private async resolveTool(name: string): Promise<IAgentTool> {
    const local = this.tools.get(name);
    if (local) {
      return local;
    }

    // MCP discovery fallback
    if (this.mcpDiscovery) {
      try {
        const mcpTool = await this.mcpDiscovery.findTool(name);
        // A server may answer with any name. Only an exact match for a name that
        // no local tool holds is accepted, so discovery never replaces a local tool.
        if (mcpTool && mcpTool.name === name && !this.tools.has(mcpTool.name)) {
          const adaptedTool = adaptDiscoveredTool(mcpTool);
          this.tools.set(adaptedTool.name, adaptedTool);
          this.logger.info?.(`ToolRegistry: MCP tool registered on-demand '${adaptedTool.name}'`);
          return adaptedTool;
        }
      } catch (err: unknown) {
        this.logger.warn('ToolRegistry: MCP discovery fallback failed', {
          tool: name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    throw new Error(`ToolRegistry: Tool '${name}' not found.`);
  }

  async execute(name: string, args: unknown, context: IAgentContext): Promise<unknown> {
    const tool = await this.resolveTool(name);

    try {
      // 1. Validate first. The policy must see the arguments the body will receive:
      //    a schema can strip keys, apply defaults, or coerce types.
      const parsedArgs: unknown = tool.schema && typeof tool.schema.parse === 'function'
        ? tool.schema.parse(args)
        : args;

      // 2. Firewall sanitization on a copy, still before the policy decision.
      const validatedArgs: unknown = this.firewall && isObjectRecord(parsedArgs) && !Array.isArray(parsedArgs)
        ? Object.fromEntries(Object.entries(parsedArgs).map(([key, value]) => [
          key,
          typeof value === 'string' ? this.firewall!.sanitizeString(value) : value,
        ]))
        : parsedArgs;

      if (!isObjectRecord(validatedArgs) || Array.isArray(validatedArgs)) {
        throw new Error(`Security Violation: Tool '${name}' arguments must be an object`);
      }

      // 3. Security Policy Evaluation (Execution Firewall) on the final arguments.
      const policyResult = await this.policy.evaluate({
        toolName: name,
        arguments: validatedArgs,
        agentId: context.agentId,
        sessionId: context.sessionId
      });

      if (!policyResult.allowed) {
        this.logger.warn(`ToolRegistry: Security Policy Blocked '${name}'`, { 
             reason: policyResult.reason, 
             agentId: context.agentId 
        });
        throw new Error(`Security Violation: Tool execution denied. Reason: ${policyResult.reason || 'Unknown'}`);
      }

      if (policyResult.requiresApproval === true && context.approvalGranted !== true) {
        this.logger.warn(`ToolRegistry: Approval required '${name}'`, {
          reason: policyResult.approvalReason,
          agentId: context.agentId,
        });
        throw new Error(
          `Security Violation: Tool execution requires approval. Reason: ${policyResult.approvalReason || 'Unknown'}`,
        );
      }

      // 4. Execute
      // Argument values can hold secrets or personal data; log the keys only.
      this.logger.debug(`ToolRegistry: Executing '${name}' for agent ${context.agentId}`, {
        argKeys: Object.keys(validatedArgs),
      });
      const result = await tool.execute(validatedArgs, context);

      if (isApprovalRequiredResult(result)) {
        this.logger.info?.(`ToolRegistry: Approval required '${name}'`, {
          agentId: context.agentId,
        });
      } else {
        this.logger.debug(`ToolRegistry: Execution successful '${name}'`);
      }

      return result;

    } catch (error: unknown) {
      this.logger.error(`ToolRegistry: Execution failed for '${name}'`, { error });
      // Enhance error message for the agent
      const validationError = error as ToolValidationError;
      if (validationError.issues) { // ZodError
         throw new Error(`Tool Argument Validation Failed: ${JSON.stringify(validationError.issues)}`);
      }
      throw error;
    }
  }
}
