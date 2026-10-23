/**
 * OpenTelemetry GenAI semantic convention names.
 * Status: Development. This file is the only place these attribute names are written.
 * Memory operations and the command-execution refinement were checked against
 * the GenAI spans document (search_memory, create_memory, execute_tool).
 *
 * @see https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-spans.md
 * @see https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md
 */

export const GEN_AI_OPERATION_NAME = 'gen_ai.operation.name';
export const GEN_AI_AGENT_NAME = 'gen_ai.agent.name';
export const GEN_AI_PROVIDER_NAME = 'gen_ai.provider.name';
export const GEN_AI_USAGE_INPUT_TOKENS = 'gen_ai.usage.input_tokens';
export const GEN_AI_USAGE_OUTPUT_TOKENS = 'gen_ai.usage.output_tokens';
export const GEN_AI_TOOL_NAME = 'gen_ai.tool.name';
export const GEN_AI_ERROR_TYPE = 'error.type';
export const GEN_AI_REQUEST_MODEL = 'gen_ai.request.model';

export const GEN_AI_OPERATION_INVOKE_AGENT = 'invoke_agent';
export const GEN_AI_OPERATION_EXECUTE_TOOL = 'execute_tool';
export const GEN_AI_OPERATION_SEARCH_MEMORY = 'search_memory';
export const GEN_AI_OPERATION_CREATE_MEMORY = 'create_memory';

export const GEN_AI_MEMORY_RECORD_COUNT = 'gen_ai.memory.record.count';
export const GEN_AI_MEMORY_RECORD_ID = 'gen_ai.memory.record.id';
export const GEN_AI_MEMORY_STORE_ID = 'gen_ai.memory.store.id';

/** Command-execution refinement. The executable name is set only when the process image is known. */
export const PROCESS_EXECUTABLE_NAME = 'process.executable.name';
export const PROCESS_EXIT_CODE = 'process.exit.code';

export const MCP_METHOD_NAME = 'mcp.method.name';
export const MCP_PROTOCOL_VERSION = 'mcp.protocol.version';
export const MCP_SESSION_ID = 'mcp.session.id';

export const AGENT_SPAN_CORRELATION_ID = 'correlationId';
export const MCP_META_TRACEPARENT = 'mcp.meta.traceparent';
