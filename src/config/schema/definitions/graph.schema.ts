/**
 * Graph Store Schema — Configuration for Neo4j/Memgraph integration.
 * 
 * Layer: Config
 */

import { z } from 'zod';

/**
 * Supported graph database providers.
 */
export const GraphProviderEnum = z.enum(['neo4j', 'memgraph', 'none']);
export type GraphProvider = z.infer<typeof GraphProviderEnum>;

/**
 * Neo4j connection configuration.
 */
export const Neo4jConfigSchema = z.object({
  url: z.string().url().describe('Neo4j Bolt URL, e.g. bolt://localhost:7687'),
  username: z.string().default('neo4j'),
  password: z.string(),
  database: z.string().default('neo4j'),
});

/**
 * Memgraph connection configuration.
 */
export const MemgraphConfigSchema = z.object({
  url: z.string().url().describe('Memgraph Bolt URL'),
  username: z.string().optional(),
  password: z.string().optional(),
});

/**
 * Graph store configuration schema.
 */
export const GraphStoreSchema = z.object({
  /**
   * Whether graph memory is enabled.
   */
  enabled: z.boolean().default(false),
  
  /**
   * Graph database provider.
   */
  provider: GraphProviderEnum.default('none'),
  
  /**
   * Neo4j-specific configuration.
   */
  neo4j: Neo4jConfigSchema.optional(),
  
  /**
   * Memgraph-specific configuration.
   */
  memgraph: MemgraphConfigSchema.optional(),
  
  /**
   * Maximum depth for graph traversal queries.
   */
  maxTraversalDepth: z.number().int().min(1).max(5).default(2),
  
  /**
   * Minimum relationship weight to keep (for pruning).
   */
  minRelationWeight: z.number().min(0).max(1).default(0.05),
});

export type GraphStoreConfig = z.infer<typeof GraphStoreSchema>;
