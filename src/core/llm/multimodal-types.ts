/**
 * Core multimodal types for LLM runtime.
 * Layer: Core
 *
 * Provider-agnostic representation of multimodal chat content.
 */

export type MultimodalContentType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document';

/**
 * Single content part inside a multimodal message.
 * Compatible with ApiChatMessageContentPart in protocol/chat.ts.
 */
export interface MultimodalContentPart {
  type: 'text' | 'image' | 'input_audio' | 'video';

  /**
   * Plain text content.
   */
  text?: string;

  /**
   * Image payload encoded as base64 (raw or data URI).
   */
  imageBase64?: string;

  /**
   * Audio payload encoded as base64.
   */
  audioBase64?: string;

  /**
   * Audio format hint for decoding.
   */
  audioFormat?: 'wav' | 'mp3' | 'ogg';

  /**
   * URL for video content (kept for future phases).
   */
  videoUrl?: string;
}

/**
 * Role of a participant in multimodal chat.
 */
export type MultimodalChatRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * Generic multimodal chat message passed to LLM adapters.
 */
export interface MultimodalChatMessage {
  role: MultimodalChatRole;
  parts: MultimodalContentPart[];

  /**
   * Optional identifier to correlate with conversations or memory.
   */
  id?: string;

  /**
   * Arbitrary metadata propagated through runtime layers.
   */
  metadata?: Record<string, unknown>;

  /** Tool call ID for messages with role 'tool' (tool result correlation). */
  tool_call_id?: string;

  /** Tool calls requested by the assistant (function-calling). */
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}