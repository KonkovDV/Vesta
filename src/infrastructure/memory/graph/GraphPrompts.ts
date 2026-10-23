/**
 * Graph Memory Prompts — prompt templates for the graph memory pipeline.
 *
 * Ported from: external/mem0/mem0-ts/src/oss/src/graphs/utils.ts
 *
 * Three prompts used in the graph add pipeline:
 * 1. Entity extraction system prompt (Stage 1)
 * 2. Relation extraction prompt (Stage 2)
 * 3. Delete relations prompt (Stage 4)
 *
 * Improvements over donor:
 * - Configurable USER_ID injection (no hardcoded placeholder)
 * - Fixed CUSTOM_PROMPT handling (no dangling text when empty)
 * - Explicit JSON format instruction in relation extraction
 *
 * Layer: Infrastructure/Memory/Graph
 * @module GraphPrompts
 */

// ─── Entity Extraction System Prompt (Stage 1) ─────────────

/**
 * Generate entity extraction system prompt with self-reference resolution.
 *
 * @param userId - User identifier for resolving "I", "me", "my" references
 * @returns System prompt for entity extraction LLM call
 */
export function getEntityExtractionPrompt(userId: string): string {
  return `You are a smart assistant who understands entities and their types in a given text. If user message contains self reference such as 'I', 'me', 'my' etc. then use ${userId} as the source entity. Extract all the entities from the text. ***DO NOT*** answer the question itself if the given text is a question.`;
}

// ─── Relation Extraction Prompt (Stage 2) ───────────────────

/**
 * Base prompt template for extracting relationships between entities.
 * Contains numbered principles for structured knowledge graph construction.
 */
export const EXTRACT_RELATIONS_PROMPT = `You are an advanced algorithm designed to extract structured information from text to construct knowledge graphs. Your goal is to capture comprehensive and accurate information. Follow these key principles:

1. Extract only explicitly stated information from the text.
2. Establish relationships among the entities provided.
3. Use "USER_ID" as the source entity for any self-references (e.g., "I," "me," "my," etc.) in user messages.

Relationships:
    - Use consistent, general, and timeless relationship types.
    - Example: Prefer "professor" over "became_professor."
    - Relationships should only be established among the entities explicitly mentioned in the user message.

Entity Consistency:
    - Ensure that relationships are coherent and logically align with the context of the message.
    - Maintain consistent naming for entities across the extracted data.

Strive to construct a coherent and easily understandable knowledge graph by establishing all the relationships among the entities and adherence to the user's context.

Adhere strictly to these guidelines to ensure high-quality knowledge graph extraction.`;

/**
 * Generate relation extraction messages for LLM call.
 *
 * @param data - Text to extract relations from
 * @param userId - User identifier for self-reference resolution
 * @param entityNames - List of entity names extracted in Stage 1
 * @param customPrompt - Optional additional instructions (injected as rule 4)
 * @returns [systemMessage, userMessage] tuple
 */
export function getRelationExtractionMessages(
  data: string,
  userId: string,
  entityNames: string[],
  customPrompt?: string,
): [string, string] {
  let systemContent = EXTRACT_RELATIONS_PROMPT.replace(/USER_ID/g, () => userId);

  if (customPrompt) {
    systemContent = systemContent.replace(
      'Relationships:',
      `4. ${customPrompt}\n\nRelationships:`,
    );
  }

  systemContent += '\nPlease provide your response in JSON format.';

  const userContent = `List of entities: ${entityNames.join(', ')}. \n\nText: ${data}`;
  return [systemContent, userContent];
}

// ─── Delete Relations Prompt (Stage 4) ──────────────────────

/**
 * System prompt for LLM-driven deletion of outdated/contradictory relations.
 *
 * Key safeguard: multi-value relation protection — do NOT delete if
 * there's a possibility of same relationship type but different destinations.
 */
export const DELETE_RELATIONS_SYSTEM_PROMPT = `You are a graph memory manager specializing in identifying, managing, and optimizing relationships within graph-based memories. Your primary task is to analyze a list of existing relationships and determine which ones should be deleted based on the new information provided.
Input:
1. Existing Graph Memories: A list of current graph memories, each containing source, relationship, and destination information.
2. New Text: The new information to be integrated into the existing graph structure.
3. Use "USER_ID" as node for any self-references (e.g., "I," "me," "my," etc.) in user messages.

Guidelines:
1. Identification: Use the new information to evaluate existing relationships in the memory graph.
2. Deletion Criteria: Delete a relationship only if it meets at least one of these conditions:
   - Outdated or Inaccurate: The new information is more recent or accurate.
   - Contradictory: The new information conflicts with or negates the existing information.
3. DO NOT DELETE if there is a possibility of same type of relationship but different destination nodes.
4. Comprehensive Analysis:
   - Thoroughly examine each existing relationship against the new information and delete as necessary.
   - Multiple deletions may be required based on the new information.
5. Semantic Integrity:
   - Ensure that deletions maintain or improve the overall semantic structure of the graph.
   - Avoid deleting relationships that are NOT contradictory/outdated to the new information.
6. Temporal Awareness: Prioritize recency when timestamps are available.
7. Necessity Principle: Only DELETE relationships that must be deleted and are contradictory/outdated to the new information to maintain an accurate and coherent memory graph.

Note: DO NOT DELETE if there is a possibility of same type of relationship but different destination nodes.

For example:
Existing Memory: alice -- loves_to_eat -- pizza
New Information: Alice also loves to eat burger.

Do not delete in the above example because there is a possibility that Alice loves to eat both pizza and burger.

Memory Format:
source -- relationship -- destination

Provide a list of deletion instructions, each specifying the relationship to be deleted.`;

/**
 * Generate delete relation messages for LLM call.
 *
 * @param existingMemoriesString - Formatted existing relations ("source -- rel -- dest")
 * @param data - New information text
 * @param userId - User identifier for self-reference resolution
 * @returns [systemMessage, userMessage] tuple
 */
export function getDeleteMessages(
  existingMemoriesString: string,
  data: string,
  userId: string,
): [string, string] {
  return [
    DELETE_RELATIONS_SYSTEM_PROMPT.replace(/USER_ID/g, () => userId),
    `Here are the existing memories: ${existingMemoriesString} \n\n New Information: ${data}`,
  ];
}

/**
 * Format relation triples as "source -- relationship -- destination" lines.
 *
 * @param entities - Array of {source, relationship, destination} triples
 * @returns Formatted string with one triple per line
 */
export function formatEntities(
  entities: Array<{
    source: string;
    relationship: string;
    destination: string;
  }>,
): string {
  return entities
    .map((e) => `${e.source} -- ${e.relationship} -- ${e.destination}`)
    .join('\n');
}

/**
 * Normalize an entity name: lowercase + replace spaces with underscores.
 * This ensures consistent entity matching across the graph.
 *
 * @param name - Raw entity name
 * @returns Normalized entity name
 */
export function normalizeEntityName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '_');
}

/**
 * Normalize all entities in a relation triple array.
 *
 * @param entities - Raw relation triples
 * @returns Normalized relation triples
 */
export function normalizeRelationEntities<
  T extends { source: string; relationship: string; destination: string },
>(entities: T[]): T[] {
  return entities.map((item) => ({
    ...item,
    source: normalizeEntityName(item.source),
    relationship: normalizeEntityName(item.relationship),
    destination: normalizeEntityName(item.destination),
  }));
}
