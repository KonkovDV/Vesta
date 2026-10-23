/**
 * BashTool runs one shell command inside the process container.
 * Layer: Application. It is not registered when the container is unavailable.
 */
import { z } from 'zod';
import type { IAgentContext } from '../../../domain/agents/agent-context.interface';
import type { IAgentTool } from '../../../domain/agents/tools.interface';
import type { IProcessContainer } from '../../../domain/sandbox/IProcessContainer';
import { recordCommandOutcome, withCommandExecutionSpan } from '../../../monitoring';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

export const BashToolSchema = z.object({
  command: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
}).strict();

export function clampBashTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.floor(timeoutMs)));
}

export class BashTool implements IAgentTool {
  readonly name = 'bash';
  readonly description = 'Run one non-interactive shell command inside the workspace process container. Network is closed. Writes outside workspaceRoot are denied. Each call is a new process: keep state in a workspace file. Large earlier results are listed as function_results.';
  readonly schema = BashToolSchema;

  constructor(private readonly container: IProcessContainer) {}

  matches(name: string): boolean {
    return name.toLowerCase() === this.name;
  }

  async execute(args: unknown, context: IAgentContext): Promise<unknown> {
    const correlation = context.config['correlationId'];
    return withCommandExecutionSpan({
      toolName: this.name,
      agentName: context.agentId,
      correlationId: typeof correlation === 'string' ? correlation : context.sessionId,
    }, async (span) => {
      const input = BashToolSchema.parse(args);
      if (!context.workspaceRoot) {
        recordCommandOutcome(span, { exitCode: 1, timedOut: false, failed: true, errorType: 'workspace_missing' });
        return { error: 'workspaceRoot is empty', content: 'workspaceRoot is empty', isError: true, exitCode: 1, timedOut: false, output: '' };
      }
      const result = await this.container.run({
        command: input.command,
        workspaceRoot: context.workspaceRoot,
        timeoutMs: clampBashTimeout(input.timeout_ms),
      });
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
      if (result.timedOut) {
        recordCommandOutcome(span, { exitCode: result.exitCode, timedOut: true, failed: true });
        return { error: 'timed out', content: 'timed out', isError: true, exitCode: result.exitCode, timedOut: true, output };
      }
      if (result.exitCode !== 0) {
        const error = output || `exit ${result.exitCode}`;
        recordCommandOutcome(span, { exitCode: result.exitCode, timedOut: false, failed: true });
        return { error, content: error, isError: true, exitCode: result.exitCode, timedOut: false, output };
      }
      recordCommandOutcome(span, { exitCode: 0, timedOut: false, failed: false });
      const text = output || '(no output)';
      return { output: text, content: text, isError: false, exitCode: 0, timedOut: false };
    });
  }
}

/** Registers bash only when this host can start a process container. */
export async function registerBashToolIfAvailable(
  registry: { register(tool: IAgentTool): void },
  container: IProcessContainer,
): Promise<boolean> {
  if (!(await container.isAvailable())) return false;
  registry.register(new BashTool(container));
  return true;
}
