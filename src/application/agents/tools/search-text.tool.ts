/**
 * Search text files inside the agent workspace.
 * Layer: Application
 */

import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { IAgentContext } from '../../../domain/agents/agent-context.interface';
import type { IAgentTool } from '../../../domain/agents/tools.interface';
import type { IPromptInjectionScanner } from '../../../domain/security/prompt-injection-scanner.port';
import { isInsideWorkspace } from './workspace-path';
import { flagInjection } from './untrusted-output';

const TEXT_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.json', '.md', '.txt', '.yml', '.yaml']);
const MAX_FILES = 2_000;
const MAX_FILE_BYTES = 1_000_000;

/** Source and tests are scanned before docs, so a file cap still reaches the code. */
export function workspaceEntryRank(name: string): number {
  if (name === 'src') return 0;
  if (name === 'tests') return 1;
  if (name === 'docs' || name === 'parked') return 3;
  return 2;
}

export const SearchTextToolSchema = z.object({
  query: z.string().min(1).max(200),
  maxResults: z.number().int().positive().max(50).optional(),
}).strict();

export class SearchTextTool implements IAgentTool {
  constructor(private readonly scanner?: IPromptInjectionScanner) {}

  readonly name = 'search_text';
  readonly description = 'Find lines containing query under workspaceRoot. In each directory, files are scanned before subdirectories. Directories src and tests come before docs and parked. Stops after 2000 files; truncated is true when that cap is hit. Skips node_modules, .git, and symlinks.';
  readonly schema = SearchTextToolSchema;

  matches(name: string): boolean {
    return name.toLowerCase() === this.name;
  }

  async execute(args: unknown, context: IAgentContext): Promise<unknown> {
    const input = SearchTextToolSchema.parse(args);
    const root = path.resolve(context.workspaceRoot);
    if (!isInsideWorkspace(context.workspaceRoot, root)) {
      return { error: 'workspaceRoot is empty' };
    }
    const maxResults = input.maxResults ?? 20;
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let scanned = 0;

    async function walk(directory: string): Promise<void> {
      if (matches.length >= maxResults || scanned >= MAX_FILES) {
        return;
      }
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => workspaceEntryRank(left.name) - workspaceEntryRank(right.name) || left.name.localeCompare(right.name));
      const files: Array<{ fullPath: string }> = [];
      const directories: string[] = [];
      for (const entry of entries) {
        if (matches.length >= maxResults || scanned >= MAX_FILES) {
          return;
        }
        if (entry.name === 'node_modules' || entry.name === '.git') {
          continue;
        }
        const fullPath = path.join(directory, entry.name);
        if (!isInsideWorkspace(root, fullPath)) {
          continue;
        }
        const stat = await lstat(fullPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          directories.push(fullPath);
          continue;
        }
        if (!stat.isFile() || !TEXT_EXTENSIONS.has(path.extname(entry.name)) || stat.size > MAX_FILE_BYTES) {
          continue;
        }
        files.push({ fullPath });
      }
      for (const file of files) {
        if (matches.length >= maxResults || scanned >= MAX_FILES) {
          return;
        }
        scanned += 1;
        const text = await readFile(file.fullPath, 'utf8');
        const lines = text.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].includes(input.query)) {
            matches.push({ path: file.fullPath, line: index + 1, text: lines[index].slice(0, 400) });
            if (matches.length >= maxResults) {
              return;
            }
          }
        }
      }
      for (const fullPath of directories) {
        if (matches.length >= maxResults || scanned >= MAX_FILES) {
          return;
        }
        await walk(fullPath);
      }
    }

    await walk(root);
    const visible = matches.map((match) => match.text).join('\n');
    return flagInjection(this.scanner, visible, {
      matches,
      scannedFiles: scanned,
      truncated: scanned >= MAX_FILES,
    });
  }
}
