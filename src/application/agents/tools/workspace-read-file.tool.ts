/**
 * Read a file inside the agent workspace, with line pagination.
 * Layer: Application
 */

import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { IAgentContext } from '../../../domain/agents/agent-context.interface';
import type { IAgentTool } from '../../../domain/agents/tools.interface';
import type { IPromptInjectionScanner } from '../../../domain/security/prompt-injection-scanner.port';
import { isInsideWorkspace } from './workspace-path';
import { flagInjection } from './untrusted-output';

/** The whole file is read before the line window is cut; keep that bounded. */
const MAX_READ_BYTES = 10 * 1024 * 1024;

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
    // lstat sees only the last component. A linked directory on the way
    // (workspace/link -> /etc) would still lead outside, so compare real paths.
    const [realRoot, realFile] = await Promise.all([realpath(context.workspaceRoot), realpath(resolved)]);
    if (!isInsideWorkspace(realRoot, realFile)) {
      return { error: 'path is outside workspaceRoot' };
    }
    if (stat.size > MAX_READ_BYTES) {
      return { error: `file is larger than ${MAX_READ_BYTES} bytes; read a smaller file or use search_text` };
    }
    const text = await readFile(realFile, 'utf8');
    const lines = text.split(/\r?\n/);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? 200;
    const content = lines.slice(offset, offset + limit).join('\n');
    return flagInjection(this.scanner, content, { path: resolved, offset, content });
  }
}
