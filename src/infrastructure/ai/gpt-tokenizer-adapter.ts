/**
 * GptTokenizerAdapter
 * Adapter for gpt-tokenizer library.
 * Layer: Infrastructure
 */
import { injectable } from 'inversify';
import { encode, decode } from 'gpt-tokenizer';
import { ITokenizer } from '../../domain/ai/tokenizer.interface';

@injectable()
export class GptTokenizerAdapter implements ITokenizer {
  
  encode(text: string): number[] {
    return encode(text);
  }

  decode(tokens: number[]): string {
    return decode(tokens);
  }

  countTokens(text: string): number {
    // encode returns an array, length is the count
    // gpt-tokenizer might have optimized methods but encode is standard
    return encode(text).length;
  }
}
