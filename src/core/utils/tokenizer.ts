/**
 * Tokenizer Utility
 * Layer: Core
 * 
 * Provides centralized token counting logic using gpt-tokenizer.
 * Used for context window management and cost estimation.
 */

import { encode } from 'gpt-tokenizer';

/**
 * Counts the number of tokens in a text string.
 * Uses gpt-tokenizer (compatible with standard GPT encodings).
 * 
 * @param text - The text to tokenize.
 * @returns The number of tokens.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch (error) {
    // HYG-09: intentional — Core layer utility, no DI logger available.
    // Fallback if encoding fails (should be rare)
    // 1 token ~= 4 chars (standard approximation)
    console.warn('Tokenizer failed, using fallback approximation', error);
    return Math.ceil(text.length / 4);
  }
}
