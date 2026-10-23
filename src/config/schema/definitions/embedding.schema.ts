import { z } from 'zod';

export const EmbeddingSchema = z.object({
  /** Enable semantic event search (feature flag). Default: false. */
  enabled: z.boolean().default(false),
  /** HuggingFace model name for local ONNX inference. */
  model: z.string().default('Xenova/all-MiniLM-L6-v2'),
  /** Embedding vector dimension. Must match model output. */
  dimension: z.number().int().min(1).default(384),
  /** Batch size for background vectorization worker. */
  batchSize: z.number().int().min(1).max(200).default(20),
  /** Worker poll interval in ms. */
  workerIntervalMs: z.number().int().min(500).default(5000),
});

export type EmbeddingConfig = z.infer<typeof EmbeddingSchema>;
