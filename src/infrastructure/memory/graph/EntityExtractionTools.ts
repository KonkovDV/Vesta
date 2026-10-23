/**
 * Entity Extraction Tools — Zod schemas and LLM tool definitions
 * for graph memory entity/relation extraction pipeline.
 *
 * Ported from: external/mem0/mem0-ts/src/oss/src/graphs/tools.ts
 *
 * Only 3 tools are used in production:
 * - EXTRACT_ENTITIES_TOOL: Extract entities + types from text
 * - RELATIONS_TOOL: Establish relationships between entities
 * - DELETE_MEMORY_TOOL_GRAPH: Delete outdated/contradictory relations
 *
 * Layer: Infrastructure/Memory/Graph
 * @module EntityExtractionTools
 */

import { z } from 'zod';

// ─── Zod Schemas ────────────────────────────────────────────

/**
 * Schema for a simple source→relationship→destination triple.
 */
export const GraphSimpleRelationshipSchema = z.object({
  source: z.string().describe('Identifier of the source node'),
  relationship: z.string().describe('Relationship between source and destination'),
  destination: z.string().describe('Identifier of the destination node'),
});

/**
 * Schema for adding a relationship (includes source/destination types).
 */
export const GraphAddRelationshipSchema = GraphSimpleRelationshipSchema.extend({
  source_type: z.string().describe('Type/category of the source node'),
  destination_type: z.string().describe('Type/category of the destination node'),
});

/**
 * Schema for extracting entities from text.
 */
export const GraphExtractEntitiesSchema = z.object({
  entities: z
    .array(
      z.object({
        entity: z.string().describe('Name or identifier of the entity'),
        entity_type: z.string().describe('Type or category of the entity'),
      }),
    )
    .describe('Array of entities with their types'),
});

/**
 * Schema for establishing relationships between entities.
 */
export const GraphRelationsSchema = z.object({
  entities: z
    .array(GraphSimpleRelationshipSchema)
    .describe('Array of relationships (source, relationship, destination)'),
});

/**
 * Schema for delete relationship arguments.
 */
export const GraphDeleteRelationshipSchema = GraphSimpleRelationshipSchema;

// ─── TypeScript interfaces ──────────────────────────────────

export type GraphSimpleRelationship = z.infer<typeof GraphSimpleRelationshipSchema>;
export type GraphAddRelationship = z.infer<typeof GraphAddRelationshipSchema>;
export type GraphExtractEntities = z.infer<typeof GraphExtractEntitiesSchema>;
export type GraphRelations = z.infer<typeof GraphRelationsSchema>;

// ─── LLM Tool Definitions (JSON Schema format for LLM APIs) ──

/**
 * Tool for extracting entities from text.
 * Used in Stage 1 of the graph add pipeline.
 */
export const EXTRACT_ENTITIES_TOOL = {
  type: 'function' as const,
  function: {
    name: 'extract_entities',
    description: 'Extract entities and their types from the text.',
    parameters: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              entity: {
                type: 'string',
                description: 'The name or identifier of the entity.',
              },
              entity_type: {
                type: 'string',
                description: 'The type or category of the entity.',
              },
            },
            required: ['entity', 'entity_type'],
            additionalProperties: false,
          },
          description: 'An array of entities with their types.',
        },
      },
      required: ['entities'],
      additionalProperties: false,
    },
  },
};

/**
 * Tool for establishing relationships between entities.
 * Used in Stage 2 of the graph add pipeline.
 */
export const RELATIONS_TOOL = {
  type: 'function' as const,
  function: {
    name: 'establish_relationships',
    description:
      'Establish relationships among the entities based on the provided text.',
    parameters: {
      type: 'object',
      properties: {
        entities: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              source: {
                type: 'string',
                description: 'The source entity of the relationship.',
              },
              relationship: {
                type: 'string',
                description:
                  'The relationship between the source and destination entities.',
              },
              destination: {
                type: 'string',
                description: 'The destination entity of the relationship.',
              },
            },
            required: ['source', 'relationship', 'destination'],
            additionalProperties: false,
          },
        },
      },
      required: ['entities'],
      additionalProperties: false,
    },
  },
};

/**
 * Tool for deleting outdated/contradictory relationships.
 * Used in Stage 4 of the graph add pipeline.
 */
export const DELETE_MEMORY_TOOL_GRAPH = {
  type: 'function' as const,
  function: {
    name: 'delete_graph_memory',
    description: 'Delete the relationship between two nodes.',
    parameters: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'The identifier of the source node in the relationship.',
        },
        relationship: {
          type: 'string',
          description:
            'The existing relationship between the source and destination nodes that needs to be deleted.',
        },
        destination: {
          type: 'string',
          description:
            'The identifier of the destination node in the relationship.',
        },
      },
      required: ['source', 'relationship', 'destination'],
      additionalProperties: false,
    },
  },
};

/**
 * Parse LLM tool call arguments and validate with Zod.
 *
 * @param toolCalls - Raw tool calls from LLM response
 * @param toolName - Expected tool name to filter
 * @param schema - Zod schema to validate against
 * @returns Parsed and validated arguments, or null on failure
 */
export function parseToolCallArgs<T>(
  toolCalls: Array<{ name: string; arguments: string }> | undefined,
  toolName: string,
  schema: z.ZodType<T>,
): T | null {
  if (!toolCalls || toolCalls.length === 0) return null;

  for (const call of toolCalls) {
    if (call.name === toolName) {
      try {
        const args = JSON.parse(call.arguments);
        const result = schema.safeParse(args);
        if (result.success) return result.data;
      } catch {
        // Continue to next tool call
      }
    }
  }

  return null;
}

/**
 * Parse all matching tool calls (for tools that may be called multiple times).
 *
 * @param toolCalls - Raw tool calls from LLM response
 * @param toolName - Expected tool name to filter
 * @param schema - Zod schema to validate each call
 * @returns Array of parsed and validated arguments
 */
export function parseAllToolCallArgs<T>(
  toolCalls: Array<{ name: string; arguments: string }> | undefined,
  toolName: string,
  schema: z.ZodType<T>,
): T[] {
  if (!toolCalls || toolCalls.length === 0) return [];

  const results: T[] = [];
  for (const call of toolCalls) {
    if (call.name === toolName) {
      try {
        const args = JSON.parse(call.arguments);
        const result = schema.safeParse(args);
        if (result.success) results.push(result.data);
      } catch {
        // Skip malformed arguments
      }
    }
  }

  return results;
}
