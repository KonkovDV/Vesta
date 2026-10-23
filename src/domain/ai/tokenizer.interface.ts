
/**
 * Tokenizer Interface
 * Abstraction for token counting and encoding.
 * @layer Domain
 */

export interface ITokenizer {
  /**
   * Encodes text into tokens.
   */
  encode(text: string): number[];

  /**
   * Decodes tokens back to text.
   */
  decode(tokens: number[]): string;

  /**
   * Counts tokens in text (optimized).
   */
  countTokens(text: string): number;
}
