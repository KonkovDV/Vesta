/**
 * Deferred Tool Registry Adapter — Infrastructure implementation of IDeferredToolRegistry.
 *
 * Manages lightweight tool manifests and resolves them on-demand to full
 * IAgentTool instances. Achieves ~85% token savings by keeping only
 * manifests in context until a tool is actually needed.
 *
 * @layer Infrastructure (Tools)
 * @pattern CC-007 Deferred Tool Loading (FITNESS-K: 72.5)
 * @see src/domain/agents/IDeferredToolRegistry.ts — domain port
 */

import type { IAgentContext } from '../../domain/agents/agent-context.interface';
import type { IAgentTool } from '../../domain/agents/tools.interface';
import type {
  IDeferredToolRegistry,
  DeferredToolManifest,
  ToolResolutionResult,
} from '../../domain/agents/IDeferredToolRegistry';
import type { IToolExecutionPolicy, ToolExecutionRequest } from '../../domain/security/tool-execution-policy.interface';

// ── Minimal Logger ────────────────────────────────────────────────

interface DeferredToolLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ── Tool Resolver Callback ────────────────────────────────────────

/**
 * Factory to resolve a manifest into a full tool. Injected at setup time so
 * the adapter itself stays infrastructure-agnostic about *how* tools load.
 */
export type ToolResolverFn = (manifest: DeferredToolManifest) => Promise<IAgentTool>;

// ── Adapter ───────────────────────────────────────────────────────

export class DeferredToolRegistryAdapter implements IDeferredToolRegistry {
  /** Manifests indexed by tool ID. */
  private readonly manifests = new Map<string, DeferredToolManifest>();

  /** Fully resolved tools indexed by tool ID. */
  private readonly resolvedTools = new Map<string, IAgentTool>();

  /** Eagerly registered (non-deferred) tools. */
  private readonly eagerTools = new Map<string, IAgentTool>();

  constructor(
    private readonly resolver?: ToolResolverFn,
    private readonly logger?: DeferredToolLogger,
    private readonly toolPolicy?: IToolExecutionPolicy,
  ) {}

  // ── IToolRegistry base methods ──────────────────────────────────

  register(tool: IAgentTool): void {
    this.eagerTools.set(tool.name, tool);
  }

  getTool(name: string): IAgentTool | undefined {
    return this.resolvedTools.get(name) ?? this.eagerTools.get(name);
  }

  listTools(_agentId?: string): IAgentTool[] {
    const merged = new Map<string, IAgentTool>(this.eagerTools);
    for (const [id, tool] of this.resolvedTools) {
      merged.set(id, tool);
    }
    return Array.from(merged.values());
  }

  async execute(name: string, args: unknown, context: IAgentContext): Promise<unknown> {
    // Enforce IToolExecutionPolicy before execution (S02-F3)
    if (this.toolPolicy) {
      const request: ToolExecutionRequest = {
        toolName: name,
        arguments: (args && typeof args === 'object' ? args : {}) as Record<string, unknown>,
        agentId: context.agentId,
        sessionId: context.sessionId,
      };
      const policyResult = await this.toolPolicy.evaluate(request);
      if (!policyResult.allowed) {
        this.logger?.warn('DeferredToolRegistry.execute.denied', {
          toolName: name,
          reason: policyResult.reason,
          violationCode: policyResult.violationCode,
        });
        throw new Error(`Tool '${name}' denied by policy: ${policyResult.reason ?? 'access denied'}`);
      }
    }

    let tool = this.getTool(name);

    // Auto-resolve if the tool is deferred and not yet loaded
    if (!tool && this.manifests.has(name)) {
      const result = await this.resolve(name);
      tool = result.tool ?? undefined;
    }

    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }

    return tool.execute(args, context);
  }

  // ── IDeferredToolRegistry extensions ────────────────────────────

  search(pattern: string): DeferredToolManifest[] {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, 'i');
    } catch {
      this.logger?.warn('Invalid search pattern, falling back to literal match', { pattern });
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    }

    const results: DeferredToolManifest[] = [];
    for (const manifest of this.manifests.values()) {
      if (
        regex.test(manifest.name) ||
        regex.test(manifest.description) ||
        manifest.tags.some(tag => regex.test(tag))
      ) {
        results.push(manifest);
      }
    }
    return results;
  }

  isDeferred(toolId: string): boolean {
    return this.manifests.has(toolId) && !this.resolvedTools.has(toolId);
  }

  async resolve(toolId: string): Promise<ToolResolutionResult> {
    // Already resolved — return from cache
    const cached = this.resolvedTools.get(toolId);
    if (cached) {
      return { tool: cached, resolutionMs: 0, fromCache: true };
    }

    const manifest = this.manifests.get(toolId);
    if (!manifest) {
      return { tool: null, resolutionMs: 0, fromCache: false, error: `No manifest for: ${toolId}` };
    }

    if (!this.resolver) {
      return { tool: null, resolutionMs: 0, fromCache: false, error: 'No resolver configured' };
    }

    const startMs = Date.now();
    try {
      const tool = await this.resolver(manifest);
      this.resolvedTools.set(toolId, tool);

      this.logger?.info('Deferred tool resolved', {
        toolId,
        resolutionMs: Date.now() - startMs,
      });

      return {
        tool,
        resolutionMs: Date.now() - startMs,
        fromCache: false,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger?.error('Deferred tool resolution failed', { toolId, error: errorMsg });
      return {
        tool: null,
        resolutionMs: Date.now() - startMs,
        fromCache: false,
        error: errorMsg,
      };
    }
  }

  registerManifest(manifest: DeferredToolManifest): void {
    this.manifests.set(manifest.id, manifest);
    this.logger?.info('Deferred tool manifest registered', {
      toolId: manifest.id,
      name: manifest.name,
      tags: [...manifest.tags],
    });
  }

  listManifests(): DeferredToolManifest[] {
    return Array.from(this.manifests.values());
  }
}
