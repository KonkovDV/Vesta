import { z } from 'zod';

export const IdentitySchema = z.object({
  name: z.string().min(1).default('MicroPhoenix'),
  role: z.string().default('Autonomous Engineer'),
  bio: z.string().max(500).optional(),
  avatar: z.string().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#FF4500'),
  voice: z.object({
    provider: z.enum(['elevenlabs', 'openai', 'system']).default('system'),
    voiceId: z.string().optional(),
    speed: z.number().min(0.5).max(2.0).default(1.0),
  }).prefault({}),
});

export type IdentityConfig = z.infer<typeof IdentitySchema>;
