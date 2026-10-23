/**
 * EventVectorizerAdapter — Infrastructure adapter for IEventVectorizer.
 * Layer: Infrastructure (Memory / Embedding)
 *
 * Uses @huggingface/transformers (ONNX Runtime) for local embedding generation.
 * No external API calls — all inference runs locally.
 *
 * @since v2.9.0 — Этап 6 (Semantic Event Sourcing)
 * @see src/domain/memory/IEventVectorizer.ts
 */

import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { IEventVectorizer } from '../../../domain/memory/IEventVectorizer';

/** Minimal config for vectorizer adapter. */
export interface EventVectorizerConfig {
  readonly model: string;
  readonly dimension: number;
  readonly cacheDir?: string;
}

/** Minimal logger interface (subset of IStructuredLogger). */
interface VectorizerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Adapter implementing IEventVectorizer via Hugging Face Transformers.js.
 *
 * Pipeline is loaded lazily on initialize() to avoid blocking startup.
 * Model cache is redirected to a writable location to work in read-only containers.
 */
export class EventVectorizerAdapter implements IEventVectorizer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Transformers.js pipeline type not exported cleanly
  private embedder: any = null;
  private _dimensions: number;
  private _isReady = false;
  private readonly modelName: string;

  constructor(
    private readonly config: EventVectorizerConfig,
    private readonly logger?: VectorizerLogger,
  ) {
    this._dimensions = config.dimension;
    this.modelName = config.model;
  }

  get dimensions(): number {
    return this._dimensions;
  }

  get isReady(): boolean {
    return this._isReady;
  }

  async initialize(): Promise<void> {
    if (this._isReady) return;

    const startMs = Date.now();
    const cacheDir = this.resolveCacheDir();

    try {
      // Dynamic import to avoid loading ONNX Runtime at module parse time
      const { env, pipeline } = await import('@huggingface/transformers');
      await mkdir(cacheDir, { recursive: true });
      env.cacheDir = cacheDir;
      this.embedder = await pipeline('feature-extraction', this.modelName, {
        dtype: 'q8',
      });
      this._isReady = true;
      this.logger?.info('[VECTORIZER] Model loaded', {
        cacheDir,
        model: this.modelName,
        dimension: this._dimensions,
        durationMs: Date.now() - startMs,
      });
    } catch (error) {
      this.logger?.error('[VECTORIZER] Failed to load model', {
        model: this.modelName,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async vectorize(text: string): Promise<number[]> {
    this.ensureReady();
    const output = await this.embedder(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array);
  }

  async vectorizeBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    this.ensureReady();

    const output = await this.embedder(texts, { pooling: 'mean', normalize: true });
    const dim = this._dimensions;
    const data = output.data as Float32Array;
    return texts.map((_, i) => Array.from(data.slice(i * dim, (i + 1) * dim)));
  }

  private ensureReady(): void {
    if (!this._isReady || !this.embedder) {
      throw new Error('EventVectorizerAdapter not initialized. Call initialize() first.');
    }
  }

  private resolveCacheDir(): string {
    return this.config.cacheDir ?? path.join(os.tmpdir(), 'microphoenix', 'transformers-cache');
  }

}
