/**
 * Read a file inside the agent workspace, with line pagination.
 * Layer: Application
 */

import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { IAgentContext } from '../../../domain/agents/agent-context.interface';
import type { IAgentTool } from '../../../domain/agents/tools.interface';
import type { IPromptInjectionScanner } from '../../../domain/security/prompt-injection-scanner.port';
import { isInsideWorkspace } from './workspace-path';
import { flagInjection } from './untrusted-output';

export const ReadFileToolSchema = z.object({
  path: z.string().min(1),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(400).optional(),
}).strict();

export class WorkspaceReadFileTool implements IAgentTool {
  constructor(private readonly scanner?: IPromptInjectionScanner) {}

  readonly name = 'read_file';
  readonly description = 'Read a UTF-8 file inside the workspace. path must be absolute. offset and limit select lines.';
  readonly schema = ReadFileToolSchema;

  matches(name: string): boolean {
    return name.toLowerCase() === this.name;
  }

  async execute(args: unknown, context: IAgentContext): Promise<unknown> {
    const input = ReadFileToolSchema.parse(args);
    if (!path.isAbsolute(input.path)) {
      return { error: 'path must be absolute' };
    }
    if (!isInsideWorkspace(context.workspaceRoot, input.path)) {
      return { error: 'path is outside workspaceRoot' };
    }
    const resolved = path.resolve(input.path);
    const stat = await lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      return { error: 'path must be a regular file' };
    }
    const text = await readFile(resolved, 'utf8');
    const lines = text.split(/\r?\n/);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 200;
    const content = lines.slice(offset, offset + limit).join('\n');
    return flagInjection(this.scanner, content, { path: resolved, offset, content });
  }
}
