import { z } from 'zod';
import { IdentitySchema } from './definitions/identity.schema';
import { PhysicsSchema } from './definitions/physics.schema';
import { SandboxRuntimeSchema } from './definitions/sandbox.schema';

import { InfraSchema } from './definitions/infra.schema';
import { SafetySchema } from './definitions/safety.schema';
import { EmbeddingSchema } from './definitions/embedding.schema';
import { LegacyConfigSchema } from './legacy.schema';

export const AppConfigSchema = LegacyConfigSchema.extend({
  env: z.enum(['development', 'production', 'test']).default('development'),
  identity: IdentitySchema.prefault({}),
  physics: PhysicsSchema.prefault({
    time: {},
    memory: {},
    circuitBreaker: {},
  }),
  sandbox: SandboxRuntimeSchema.prefault({}),
  safety: SafetySchema.prefault({}),
  infra: InfraSchema,
  embedding: EmbeddingSchema.prefault({}),
}).superRefine((data, ctx) => {
  if (data.env === 'production') {
    if (!data.JWT_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET is required in production (min 32 chars). Generate: openssl rand -hex 32',
      });
    }
    if (!data.DATABASE_URL && !data.DB_HOST) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'DATABASE_URL or DB_HOST is required in production',
      });
    }
  }
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
