/**
 * Compile-time checks for typed DI tokens (T2.3). `npm run typecheck` compiles this
 * file and the build skips it. Each @ts-expect-error below must stay an error: if
 * the typing loosens, the directive is unused and typecheck fails.
 */
import type { DIContainer } from './container';
import { createToken } from './injection-token';

interface Clock {
  now(): number;
}

interface Mailer {
  send(to: string): Promise<void>;
}

const CLOCK = createToken<Clock>('TypecheckClock');
declare const container: DIContainer;

// The token decides the type: no type argument and no cast.
export const clock: Clock = container.inject(CLOCK);
container.provide(CLOCK, () => ({ now: () => 0 }));

// @ts-expect-error a token for Clock does not resolve to a Mailer
export const mailer: Mailer = container.inject(CLOCK);

// @ts-expect-error the factory must return what the token names
container.provide(CLOCK, () => ({ send: async (_to: string) => undefined }));

// @ts-expect-error a bare string is not a typed token
container.inject('TypecheckClock');
