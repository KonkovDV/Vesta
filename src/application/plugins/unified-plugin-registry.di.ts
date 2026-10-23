import type { DIContainer } from '../../core/di/public-types';
import { DI_TOKENS } from '../../core/di/DI_TOKENS';
import { PluginRegistry } from './plugin-registry';
import { PluginExecutor } from './plugin-executor';
import { UnifiedPluginRegistry } from './unified-plugin-registry';
import { PluginImplementationRegistry } from './plugin-implementation-registry';
import { ToolEventsPublisher } from './tool-events.publisher';
import { SandboxEventsPublisher } from './sandbox-events.publisher';
import { PluginAuditEventsPublisher } from './plugin-audit-events.publisher';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IPluginRegistry } from './plugin-registry';
import type { IPluginExecutor } from './plugin-executor';
import type { IUnifiedPluginRegistry } from './unified-plugin-registry';
import type { IPluginImplementationRegistry } from './plugin-implementation-registry';
import type { IPluginManifestStore } from '../../domain/plugins/manifest/plugin-manifest-store.interface';
import type { IManifestPolicyEnforcer } from '../plugins/manifest-policy.enforcer';
import { UnifiedToolRegistry } from './unified-tool-registry';
import type { IUnifiedToolRegistry } from './unified-tool-registry';
import { MCPRouterAgent } from '../mcp/mcp-router-agent';
import type { IMCPRouterAgent } from '../mcp/mcp-router-agent';
import type { IScientificSkillPlugin } from '../../domain/plugins/scientific/scientific-skill-plugin.port';
import { SCIENTIFIC_SKILL_PLUGIN_TOKEN } from '../../domain/plugins/scientific';

export const PluginRuntimeServiceTokens = {
  UNIFIED_PLUGIN_REGISTRY: 'IUnifiedPluginRegistry',
  PLUGIN_REGISTRY: 'IPluginRegistry',
  PLUGIN_EXECUTOR: 'IPluginExecutor',
  PLUGIN_IMPLEMENTATION_REGISTRY: 'IPluginImplementationRegistry',
  UNIFIED_TOOL_REGISTRY: 'IUnifiedToolRegistry',
  MCP_ROUTER_AGENT: 'IMCPRouterAgent',
} as const;

const MANIFEST_POLICY_ENFORCER_TOKEN = 'IManifestPolicyEnforcer' as const;

export function registerPluginRuntimeServices(container: DIContainer): void {
  container.register<IUnifiedToolRegistry>(
    PluginRuntimeServiceTokens.UNIFIED_TOOL_REGISTRY,
    () => new UnifiedToolRegistry(),
    {
      lifecycle: 'singleton',
      tags: ['plugins', 'tools', 'registry'],
      description: 'Unified tool registry (local plugins + MCP tools, in-memory)',
    },
  );

  container.register<IMCPRouterAgent>(
    PluginRuntimeServiceTokens.MCP_ROUTER_AGENT,
    (c) => {
      const toolRegistry = c.resolve<IUnifiedToolRegistry>(
        PluginRuntimeServiceTokens.UNIFIED_TOOL_REGISTRY,
      );
      return new MCPRouterAgent(toolRegistry);
    },
    {
      lifecycle: 'singleton',
      tags: ['plugins', 'mcp', 'router'],
      description: 'MCP Router Agent v1 (routes MCP tool calls via UnifiedToolRegistry)',
    },
  );

  container.register<IPluginRegistry>(
    PluginRuntimeServiceTokens.PLUGIN_REGISTRY,
    (c) => {
      const store = c.resolve<IPluginManifestStore>('IPluginManifestStore');
      // Enforcer пока не используем, но резолвим для будущего использования
      const enforcer = c.isRegistered(MANIFEST_POLICY_ENFORCER_TOKEN)
        ? c.resolve<IManifestPolicyEnforcer>(MANIFEST_POLICY_ENFORCER_TOKEN)
        : undefined;
      return new PluginRegistry(store, enforcer);
    },
    {
      lifecycle: 'singleton',
      tags: ['plugins', 'registry'],
      description: 'Plugin registry v1 (manifest-backed)',
    },
  );

  container.register<IPluginExecutor>(
    PluginRuntimeServiceTokens.PLUGIN_EXECUTOR,
    () => new PluginExecutor(),
    {
      lifecycle: 'singleton',
      tags: ['plugins', 'executor'],
      description: 'Plugin executor v1 (in-memory handlers map)',
    },
  );

  container.register<IPluginImplementationRegistry>(
    PluginRuntimeServiceTokens.PLUGIN_IMPLEMENTATION_REGISTRY,
    (c) => {
      const executor = c.resolve<PluginExecutor>(PluginRuntimeServiceTokens.PLUGIN_EXECUTOR);
      const logger = c.isRegistered(DI_TOKENS.ILogger)
        ? c.resolve<ILogger>(DI_TOKENS.ILogger)
        : undefined;

      return new PluginImplementationRegistry(executor, logger);
    },
    {
      lifecycle: 'singleton',
      tags: ['plugins', 'registry', 'implementation'],
      description:
        'Runtime registry for concrete plugin implementations (self-registering plugins)',
    },
  );

  container.register<IUnifiedPluginRegistry>(
    PluginRuntimeServiceTokens.UNIFIED_PLUGIN_REGISTRY,
    (c) => {
      const registry = c.resolve<IPluginRegistry>(PluginRuntimeServiceTokens.PLUGIN_REGISTRY);
      const executor = c.resolve<IPluginExecutor>(PluginRuntimeServiceTokens.PLUGIN_EXECUTOR);
      const enforcer = c.isRegistered(MANIFEST_POLICY_ENFORCER_TOKEN)
        ? c.resolve<IManifestPolicyEnforcer>(MANIFEST_POLICY_ENFORCER_TOKEN)
        : undefined;

      const eventStoreService =
        c.resolve<import('../services/EventStoreService').EventStoreService>('eventStoreService');

      const logger = c.isRegistered(DI_TOKENS.ILogger)
        ? c.resolve<ILogger>(DI_TOKENS.ILogger)
        : undefined;

      const toolEventsPublisher = new ToolEventsPublisher(
        eventStoreService,
        logger,
      );
      const sandboxEventsPublisher = new SandboxEventsPublisher(
        eventStoreService,
        logger,
      );
      const pluginAuditEventsPublisher = new PluginAuditEventsPublisher(
        eventStoreService,
        logger,
      );

      const toolRegistry = c.isRegistered(PluginRuntimeServiceTokens.UNIFIED_TOOL_REGISTRY)
        ? c.resolve<IUnifiedToolRegistry>(PluginRuntimeServiceTokens.UNIFIED_TOOL_REGISTRY)
        : undefined;

      const mcpRouterAgent = c.isRegistered(PluginRuntimeServiceTokens.MCP_ROUTER_AGENT)
        ? c.resolve<IMCPRouterAgent>(PluginRuntimeServiceTokens.MCP_ROUTER_AGENT)
        : undefined;

      // --- Scientific Skills Integration ---
      // Resolve and register the scientific skill plugin via runtime implementation registry
      // Uses Domain-layer port interface (IScientificSkillPlugin) to avoid Application → Infrastructure dependency
      if (
        c.isRegistered(SCIENTIFIC_SKILL_PLUGIN_TOKEN) &&
        c.isRegistered(PluginRuntimeServiceTokens.PLUGIN_IMPLEMENTATION_REGISTRY)
      ) {
        const scientificPlugin = c.resolve<IScientificSkillPlugin>(SCIENTIFIC_SKILL_PLUGIN_TOKEN);
        const implementationRegistry = c.resolve<IPluginImplementationRegistry>(
          PluginRuntimeServiceTokens.PLUGIN_IMPLEMENTATION_REGISTRY,
        );
        implementationRegistry.registerPlugin(scientificPlugin);
      }
      // -------------------------------------

      return new UnifiedPluginRegistry(
        registry,
        executor,
        enforcer,
        toolEventsPublisher,
        sandboxEventsPublisher,
        pluginAuditEventsPublisher,
        toolRegistry,
        mcpRouterAgent,
        logger,
      );
    },
    {
      lifecycle: 'singleton',
      tags: ['plugins', 'unified-registry'],
      description: 'Unified Plugin Registry v1 (core runtime)',
    },
  );

  // NOTE: Scientific Skills Components (PythonSkillBridge, ScientificSkillPlugin)
  // are registered in infrastructure/di/modules/scientific-skills.module.ts
  // to maintain Clean Architecture boundaries (Infrastructure → Domain, not Application → Infrastructure)
}