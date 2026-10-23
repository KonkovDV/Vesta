import path from 'node:path';
import type { IPlatformAdapter, PlatformShellConfig } from '../../domain/platform/IPlatformAdapter';
import type {
  IProcessContainer,
  ProcessContainerRequest,
  ProcessContainerResult,
} from '../../domain/sandbox/IProcessContainer';

/** OS directories a shell needs to load. Writes stay on workspaceRoot. */
export function readonlyRoots(platform: IPlatformAdapter, nodeExecutable: string, systemRoot: string | undefined): string[] {
  const roots = new Set<string>();
  if (nodeExecutable) {
    roots.add(path.dirname(nodeExecutable));
  }
  if (platform.isWindows()) {
    if (systemRoot) roots.add(systemRoot);
  } else {
    for (const dir of ['/bin', '/usr', '/lib', '/lib64']) roots.add(dir);
  }
  return [...roots];
}

/** One command line. `sh -c` needs the command as one quoted argument; `cmd /c` takes the rest of the line. */
export function shellCommandLine(shell: PlatformShellConfig, command: string): string {
  const prefix = [shell.command, ...shell.args].join(' ');
  if (shell.args.includes('-c')) {
    return `${prefix} ${JSON.stringify(command)}`;
  }
  return `${prefix} ${command}`;
}

/**
 * MXC process container. Network egress and ingress are deny.
 * The only read-write path is the agent workspace.
 */
export class MxcProcessContainer implements IProcessContainer {
  constructor(
    private readonly platform: IPlatformAdapter,
    private readonly nodeExecutable: string = process.execPath,
    private readonly systemRoot: string | undefined = process.env['SystemRoot'],
  ) {}

  async isAvailable(): Promise<boolean> {
    const { getPlatformSupport } = await import('@microsoft/mxc-sdk/v1');
    return getPlatformSupport().isSupported;
  }

  async run(request: ProcessContainerRequest): Promise<ProcessContainerResult> {
    const { run } = await import('@microsoft/mxc-sdk/v1');
    const result = await run({
      command: shellCommandLine(this.platform.getShell(), request.command),
      containment: { type: 'process' },
      filesystem: {
        readwritePaths: [request.workspaceRoot],
        readonlyPaths: readonlyRoots(this.platform, this.nodeExecutable, this.systemRoot),
      },
      network: {
        egress: { default: 'deny' },
        ingress: { default: 'deny', hostLoopback: 'deny' },
      },
      ui: { disable: true, clipboard: 'none', allowInputInjection: false },
      timeoutMs: request.timeoutMs,
      workingDirectory: request.workspaceRoot,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    };
  }
}
