/**
 * Python inside the same process container as bash.
 * Layer: Application
 *
 * GigaAgent's REPL keeps function_results in the kernel. Here each call is a
 * new process: the script loads index.txt from the workspace and binds that
 * list to function_results. The host Jupyter interpreter is not used.
 */
import { z } from 'zod';
import type { IAgentContext } from '../../../domain/agents/agent-context.interface';
import type { IAgentTool } from '../../../domain/agents/tools.interface';
import type { IProcessContainer } from '../../../domain/sandbox/IProcessContainer';
import { spillSegment, writeRunFile } from '../tool-output-spill';
import { recordCommandOutcome, withCommandExecutionSpan } from '../../../monitoring';
import { clampBashTimeout } from './BashTool';

export const PythonToolSchema = z.object({
  code: z.string().min(1),
  timeout_ms: z.number().int().positive().optional(),
}).strict();

export function pythonProgram(runId: string, userCode: string): string {
  const folder = JSON.stringify(spillSegment(runId));
  return [
    'import os',
    'def _mp_load_function_results():',
    `    path = os.path.join(os.getcwd(), ".agent-run-spills", ${folder}, "index.txt")`,
    '    rows = []',
    '    try:',
    '        with open(path, encoding="utf-8") as handle:',
    '            rows.extend(line.strip() for line in handle if line.strip())',
    '    except OSError:',
    '        pass',
    '    return rows',
    'function_results = _mp_load_function_results()',
    userCode,
    '',
  ].join('\n');
}

export class PythonTool implements IAgentTool {
  readonly name = 'python';
  readonly description = 'Run Python inside the workspace process container. Network is closed. function_results is the list of index lines for this run. Each call is a new process.';
  readonly schema = PythonToolSchema;

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
      const input = PythonToolSchema.parse(args);
      if (!context.workspaceRoot) {
        recordCommandOutcome(span, { exitCode: 1, timedOut: false, failed: true, errorType: 'workspace_missing' });
        return { error: 'workspaceRoot is empty', content: 'workspaceRoot is empty', isError: true, exitCode: 1, timedOut: false, output: '' };
      }
      const runId = typeof context.config['runId'] === 'string' && context.config['runId'].length > 0
        ? context.config['runId']
        : context.sessionId;
      const written = await writeRunFile({
        workspaceRoot: context.workspaceRoot,
        runId,
        fileName: typeof context.config['toolCallId'] === 'string' ? context.config['toolCallId'] : 'python',
        text: pythonProgram(runId, input.code),
      });
      if (!written) {
        recordCommandOutcome(span, { exitCode: 1, timedOut: false, failed: true, errorType: 'script_not_written' });
        return { error: 'python script was not written', content: 'python script was not written', isError: true, exitCode: 1, timedOut: false, output: '' };
      }
      const result = await this.container.run({
        command: `python ${written.relative}`,
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

export async function registerPythonToolIfAvailable(
  registry: { register(tool: IAgentTool): void },
  container: IProcessContainer,
): Promise<boolean> {
  if (!(await container.isAvailable())) return false;
  registry.register(new PythonTool(container));
  return true;
}
