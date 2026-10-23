import { z } from 'zod';
import * as path from 'path';

// Custom validator for safe paths
const SafePath = z.string().refine((val) => {
    if (!val) return true;
    const normalized = path.normalize(val);
    if (normalized.includes('..')) return false;
    if (normalized.startsWith('/etc') || normalized.startsWith('/var') || normalized.startsWith('/boot')) return false;
    return true;
}, { message: "Path is unsafe or restricted (System protection active)" });

export const SandboxRuntimeSchema = z.object({
  provider: z.enum(['gvisor', 'firecracker', 'raw']).default('gvisor'),
  
  // gVisor specific
  gvisor: z.object({
    platform: z.enum(['ptrace', 'kvm']).default('kvm'),
    debug: z.boolean().default(false),
    strace: z.boolean().default(false),
  }).prefault({}),
  
  // Firecracker specific
  firecracker: z.object({
    vcpuCount: z.number().int().min(1).max(8).default(2),
    memSizeMib: z.number().int().min(128).max(8192).default(512),
    kernelImagePath: z.string().default('/var/lib/firecracker/vmlinux'),
    rootfsPath: z.string().default('/var/lib/firecracker/rootfs.ext4'),
  }).prefault({}),
  
  // Resource limits
  limits: z.object({
    cpuQuota: z.number().int().default(100000),
    cpuPeriod: z.number().int().default(100000),
    memoryLimitMb: z.number().int().default(512),
    pidsLimit: z.number().int().default(64),
    maxFileSizeMb: z.number().int().default(100),
  }).prefault({}),
  
  // Network isolation
  network: z.object({
    mode: z.enum(['none', 'host', 'bridge']).default('none'),
    allowExternalCalls: z.boolean().default(false),
    blockedDomains: z.array(z.string()).default(['malware.com', 'phishing.example']),
  }).prefault({}),
  
  // Filesystem isolation
  filesystem: z.object({
    sandboxRoot: SafePath.default('./workspace'),
    readonlyPaths: z.array(z.string()).default(['/etc', '/usr', '/bin', '/sbin']),
    writablePaths: z.array(z.string()).default(['/tmp', '/workspace']),
  }).prefault({}),
});

export type SandboxRuntimeConfig = z.infer<typeof SandboxRuntimeSchema>;
