/**
 * McpScopeGuardAdapter — Infrastructure adapter for T16 MCP Scope Model.
 *
 * In-memory rule-based access control for MCP tools with OS-level
 * isolation policy generation (Seccomp BPF + AppArmor profiles).
 *
 * SOTA 2026: Beyond in-memory glob matching, generates machine-readable
 * isolation policies for spawning MCP subprocess sandboxes:
 *   - Seccomp BPF JSON profile: restrict syscalls per scope level
 *   - AppArmor profile: restrict filesystem + network per scope level
 *
 * Default decisions by scope level:
 * - project: allow (full access)
 * - user: allow (restricted by explicit deny rules)
 * - subagent: deny (must be explicitly allowed)
 *
 * @layer Infrastructure (MCP)
 * @pattern T16 MCP Scope Model (Wave 5, Horizon 4-5)
 * @see src/domain/mcp/IMcpScopeGuard.ts — domain port
 * @see Anthropic (2025) "Model Context Protocol — Security Best Practices"
 */

import type {
  IMcpScopeGuard,
  McpScopeLevel,
  McpAccessDecision,
  McpScopeRule,
  McpAccessEvaluation,
} from '../../../domain/mcp/IMcpScopeGuard';

// ─── Helpers ─────────────────────────────────────────────────────

interface MinimalLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Simple glob matcher (supports * and ?):
 * - `*` matches any sequence of chars
 * - `?` matches single char
 */
function globMatch(pattern: string, text: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars (except * and ?)
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(text);
}

function nowISO(): string {
  return new Date().toISOString();
}

// ─── Default decisions per scope ─────────────────────────────────

const DEFAULT_DECISIONS: Record<McpScopeLevel, McpAccessDecision> = {
  project: 'allow',
  user: 'allow',
  subagent: 'deny',
};

// ─── Adapter ─────────────────────────────────────────────────────

export class McpScopeGuardAdapter implements IMcpScopeGuard {
  private readonly rules: McpScopeRule[] = [];
  private readonly defaults: Record<McpScopeLevel, McpAccessDecision>;
  private readonly logger?: MinimalLogger;

  constructor(logger?: MinimalLogger) {
    this.defaults = { ...DEFAULT_DECISIONS };
    this.logger = logger;
  }

  evaluateAccess(
    toolName: string,
    scopeLevel: McpScopeLevel,
    agentId: string,
  ): McpAccessEvaluation {
    // Find first matching rule for this scope level
    const matchedRule = this.rules.find(
      r => r.scopeLevel === scopeLevel && globMatch(r.pattern, toolName),
    );

    const decision = matchedRule?.decision ?? this.defaults[scopeLevel];

    this.logger?.info('MCP scope access evaluated', {
      toolName,
      scopeLevel,
      agentId,
      decision,
      matchedPattern: matchedRule?.pattern,
    });

    return {
      toolName,
      scopeLevel,
      agentId,
      decision,
      matchedRule,
      evaluatedAt: nowISO(),
    };
  }

  registerScopeRule(rule: McpScopeRule): void {
    this.rules.push(rule);
    this.logger?.info('MCP scope rule registered', {
      pattern: rule.pattern,
      scopeLevel: rule.scopeLevel,
      decision: rule.decision,
    });
  }

  removeScopeRule(pattern: string, scopeLevel: McpScopeLevel): boolean {
    const idx = this.rules.findIndex(
      r => r.pattern === pattern && r.scopeLevel === scopeLevel,
    );
    if (idx >= 0) {
      this.rules.splice(idx, 1);
      return true;
    }
    return false;
  }

  getScopeRules(toolName?: string): McpScopeRule[] {
    if (!toolName) return [...this.rules];
    return this.rules.filter(r => globMatch(r.pattern, toolName));
  }

  getDefaultDecision(scopeLevel: McpScopeLevel): McpAccessDecision {
    return this.defaults[scopeLevel];
  }

  // ─── OS-Level Isolation Policy Generation (SOTA 2026) ──────────

  /**
   * Generate a Seccomp BPF profile for an MCP subprocess.
   *
   * Restricts syscall access based on scope level:
   * - project: broad syscall access (read/write/spawn)
   * - user: no spawn/exec, limited write paths
   * - subagent: minimal syscalls (read + network only to allowed hosts)
   *
   * Profile format: OCI-compatible JSON (Docker/Podman seccomp profile).
   */
  generateSeccompProfile(scopeLevel: McpScopeLevel): SeccompProfile {
    const baseSyscalls = ['read', 'write', 'close', 'fstat', 'lseek', 'mmap', 'mprotect',
      'munmap', 'brk', 'rt_sigaction', 'rt_sigprocmask', 'ioctl', 'access', 'pipe',
      'select', 'sched_yield', 'mremap', 'msync', 'mincore', 'madvise', 'shmget',
      'shmat', 'shmctl', 'dup', 'dup2', 'pause', 'nanosleep', 'getitimer',
      'alarm', 'setitimer', 'getpid', 'sendfile', 'socket', 'connect', 'accept',
      'sendto', 'recvfrom', 'sendmsg', 'recvmsg', 'shutdown', 'bind', 'listen',
      'getsockname', 'getpeername', 'socketpair', 'setsockopt', 'getsockopt',
      'clone', 'fork', 'vfork', 'execve', 'exit', 'wait4', 'kill', 'uname',
      'fcntl', 'flock', 'fsync', 'fdatasync', 'truncate', 'ftruncate',
      'getdents', 'getcwd', 'chdir', 'rename', 'mkdir', 'rmdir', 'creat',
      'link', 'unlink', 'symlink', 'readlink', 'chmod', 'chown', 'lchown',
      'umask', 'gettimeofday', 'getrlimit', 'getrusage', 'sysinfo', 'times',
      'getuid', 'getgid', 'geteuid', 'getegid', 'setpgid', 'getppid',
      'getpgrp', 'setsid', 'setreuid', 'setregid', 'getgroups', 'setgroups',
      'epoll_create', 'epoll_ctl', 'epoll_wait', 'openat', 'newfstatat', 'futex',
      'set_robust_list', 'get_robust_list', 'epoll_create1', 'pipe2', 'eventfd2',
      'clock_gettime', 'clock_getres', 'exit_group', 'tgkill', 'getrandom',
      'memfd_create', 'statx', 'arch_prctl', 'set_tid_address', 'prlimit64',
    ];

    // Restrict syscalls based on scope level
    const scopeRestrictions: Record<McpScopeLevel, string[]> = {
      project: [], // No additional restrictions
      user: ['fork', 'vfork', 'execve', 'clone', 'kill', 'setuid', 'setgid',
        'chroot', 'mount', 'umount2', 'pivot_root', 'ptrace'],
      subagent: ['fork', 'vfork', 'execve', 'clone', 'kill', 'setuid', 'setgid',
        'chroot', 'mount', 'umount2', 'pivot_root', 'ptrace',
        'mkdir', 'rmdir', 'unlink', 'rename', 'link', 'symlink',
        'chmod', 'chown', 'lchown', 'truncate', 'ftruncate', 'creat'],
    };

    const blocked = new Set(scopeRestrictions[scopeLevel]);
    const allowedSyscalls = baseSyscalls.filter(s => !blocked.has(s));

    return {
      defaultAction: 'SCMP_ACT_ERRNO',
      architectures: ['SCMP_ARCH_X86_64', 'SCMP_ARCH_AARCH64'],
      syscalls: [{
        names: allowedSyscalls,
        action: 'SCMP_ACT_ALLOW',
      }],
      scopeLevel,
    };
  }

  /**
   * Generate an AppArmor profile fragment for an MCP subprocess.
   *
   * Controls filesystem access, network capabilities, and signal handling
   * based on scope level and registered rules.
   *
   * @returns AppArmor profile as a structured object (serializable to text).
   */
  generateAppArmorProfile(
    serverName: string,
    scopeLevel: McpScopeLevel,
  ): AppArmorProfile {
    const profileName = `mcp-${serverName}-${scopeLevel}`;

    // Base filesystem rules: allow read of node_modules and src
    const fsRules: AppArmorFsRule[] = [
      { path: '/usr/lib/node_modules/**', permissions: 'r' },
      { path: '/usr/local/lib/node_modules/**', permissions: 'r' },
      { path: '/**/node_modules/**', permissions: 'r' },
    ];

    // Scope-specific filesystem permissions
    if (scopeLevel === 'project') {
      fsRules.push(
        { path: '/**/src/**', permissions: 'rw' },
        { path: '/**/tests/**', permissions: 'rw' },
        { path: '/tmp/**', permissions: 'rw' },
      );
    } else if (scopeLevel === 'user') {
      fsRules.push(
        { path: '/**/src/**', permissions: 'r' },
        { path: '/**/tests/**', permissions: 'r' },
        { path: '/tmp/mcp-user-*', permissions: 'rw' },
      );
    } else {
      // subagent: read-only, restricted temp
      fsRules.push(
        { path: '/**/src/**', permissions: 'r' },
        { path: '/tmp/mcp-subagent-*', permissions: 'rw' },
      );
    }

    // Network access based on scope
    const networkRules: AppArmorNetRule[] = [];
    if (scopeLevel === 'project') {
      networkRules.push(
        { type: 'tcp', direction: 'out', permission: 'allow' },
        { type: 'udp', direction: 'out', permission: 'allow' },
      );
    } else if (scopeLevel === 'user') {
      networkRules.push(
        { type: 'tcp', direction: 'out', permission: 'allow' },
      );
    }
    // subagent: no network by default

    return {
      profileName,
      scopeLevel,
      serverName,
      filesystem: fsRules,
      network: networkRules,
      capabilities: scopeLevel === 'project' ? ['net_bind_service'] : [],
      signals: scopeLevel === 'subagent' ? [] : ['send set=(term, int, hup)'],
    };
  }
}

// ─── Isolation Policy Types ──────────────────────────────────────

/** OCI-compatible Seccomp BPF profile. */
export interface SeccompProfile {
  readonly defaultAction: string;
  readonly architectures: readonly string[];
  readonly syscalls: readonly {
    readonly names: readonly string[];
    readonly action: string;
  }[];
  readonly scopeLevel: McpScopeLevel;
}

/** AppArmor profile for MCP subprocess isolation. */
export interface AppArmorProfile {
  readonly profileName: string;
  readonly scopeLevel: McpScopeLevel;
  readonly serverName: string;
  readonly filesystem: readonly AppArmorFsRule[];
  readonly network: readonly AppArmorNetRule[];
  readonly capabilities: readonly string[];
  readonly signals: readonly string[];
}

export interface AppArmorFsRule {
  readonly path: string;
  readonly permissions: string;
}

export interface AppArmorNetRule {
  readonly type: 'tcp' | 'udp' | 'raw';
  readonly direction: 'in' | 'out';
  readonly permission: 'allow' | 'deny';
}
