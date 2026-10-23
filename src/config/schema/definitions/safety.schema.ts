import { z } from 'zod';

export const SafetySchema = z.object({
  shell: z.object({
    mode: z.enum(['sandbox', 'ask', 'allowlist']).default('sandbox'),
    allowedBinaries: z.array(z.string()).default(['git', 'node', 'npm', 'cat', 'ls', 'pwd']),
  }).prefault({}),
  
  container: z.object({
    enableSeccomp: z.boolean().default(true),
    enableAppArmor: z.boolean().default(true),
    enableSelinux: z.boolean().default(false),
    dropCapabilities: z.array(z.string()).default([
      'CAP_SYS_ADMIN', 'CAP_NET_ADMIN', 'CAP_SYS_PTRACE', 
      'CAP_SYS_MODULE', 'CAP_SYS_RAWIO'
    ]),
  }).prefault({}),
  
  audit: z.object({
    logAllCommands: z.boolean().default(true),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    retentionDays: z.number().int().default(30),
  }).prefault({}),
});

export type SafetyConfig = z.infer<typeof SafetySchema>;
