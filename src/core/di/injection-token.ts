/**
 * Typed DI tokens (T2.3, step 1).
 *
 * A string token says nothing about what it resolves to, so `resolve<Foo>('IBar')`
 * compiles and fails at run time (V-12, V-40). An InjectionToken carries that type.
 * At run time it is the same string the container already uses, so a typed token
 * and an older string registration of one service are the same entry, and the
 * remaining string calls can move one module at a time.
 */
declare const resolvesTo: unique symbol;

/** A string or symbol token that names its type. A bare string is not one: use createToken. */
export type InjectionToken<T> = (string | symbol) & { readonly [resolvesTo]: T };

/** The type an InjectionToken resolves to. */
export type TokenType<Token> = Token extends InjectionToken<infer T> ? T : never;

export function createToken<T>(name: string): InjectionToken<T> {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new Error('An injection token needs a non-empty name');
  }
  return name as InjectionToken<T>;
}
