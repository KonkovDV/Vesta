/**
 * Persists an oversized tool result inside the agent workspace.
 * Layer: Application
 *
 * GigaAgent keeps the full payload in the REPL variable function_results
 * and only sends a schema to the model. The journal cannot hold that payload,
 * so the file under workspaceRoot/.agent-run-spills is the pointer read_file can page.
 */

import { lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { TOOL_OUTPUT_CHAR_LIMIT } from '../../core/events/agent-run.schemas';
import { isInsideWorkspace } from './tools/workspace-path';

export async function spillOversizedToolOutput(input: {
  workspaceRoot: string;
  runId: string;
  toolCallId: string;
  text: string;
}): Promise<string | null> {
  if (!input.workspaceRoot || input.text.length <= TOOL_OUTPUT_CHAR_LIMIT) {
    return null;
  }

  const root = path.resolve(input.workspaceRoot);
  const directory = path.resolve(root, '.agent-run-spills', safeSegment(input.runId));
  const file = path.resolve(directory, `${safeSegment(input.toolCallId)}.txt`);
  if (!isInsideWorkspace(root, directory) || !isInsideWorkspace(root, file)) {
    return null;
  }
  if (await pathContainsSymlink(root, directory)) {
    return null;
  }

  await mkdir(directory, { recursive: true });
  const created = await lstat(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) {
    return null;
  }

  try {
    const existing = await lstat(file);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      return null;
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      return null;
    }
  }

  await writeFile(file, input.text, { encoding: 'utf8', flag: 'w' });
  return file;
}

/** Shell-readable copy of the function_results lines for this run. */
export async function writeFunctionResultsIndex(input: {
  workspaceRoot: string;
  runId: string;
  lines: readonly string[];
}): Promise<string | null> {
  if (!input.workspaceRoot || input.lines.length === 0) return null;
  const root = path.resolve(input.workspaceRoot);
  const directory = path.resolve(root, '.agent-run-spills', safeSegment(input.runId));
  const file = path.resolve(directory, 'index.txt');
  if (!isInsideWorkspace(root, directory) || !isInsideWorkspace(root, file)) return null;
  if (await pathContainsSymlink(root, directory)) return null;
  await mkdir(directory, { recursive: true });
  const created = await lstat(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) return null;
  try {
    const existing = await lstat(file);
    if (existing.isSymbolicLink() || !existing.isFile()) return null;
  } catch (error) {
    if (!isMissingFile(error)) return null;
  }
  await writeFile(file, `${input.lines.join('\n')}\n`, { encoding: 'utf8', flag: 'w' });
  return file;
}

/** Relative path uses slashes so the same command line works in cmd and sh. */
export async function writeRunFile(input: {
  workspaceRoot: string;
  runId: string;
  fileName: string;
  text: string;
}): Promise<{ absolute: string; relative: string } | null> {
  if (!input.workspaceRoot) return null;
  const root = path.resolve(input.workspaceRoot);
  const segment = safeSegment(input.runId);
  const name = `${safeSegment(input.fileName)}.py`;
  const directory = path.resolve(root, '.agent-run-spills', segment);
  const absolute = path.resolve(directory, name);
  if (!isInsideWorkspace(root, directory) || !isInsideWorkspace(root, absolute)) return null;
  if (await pathContainsSymlink(root, directory)) return null;
  await mkdir(directory, { recursive: true });
  const created = await lstat(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) return null;
  try {
    const existing = await lstat(absolute);
    if (existing.isSymbolicLink() || !existing.isFile()) return null;
  } catch (error) {
    if (!isMissingFile(error)) return null;
  }
  await writeFile(absolute, input.text, { encoding: 'utf8', flag: 'w' });
  return { absolute, relative: `.agent-run-spills/${segment}/${name}` };
}

/** Full early transcript. The compacted prompt keeps only this relative path. */
export async function writeSpillTranscript(input: {
  workspaceRoot: string;
  runId: string;
  text: string;
}): Promise<string | null> {
  if (!input.workspaceRoot) return null;
  const root = path.resolve(input.workspaceRoot);
  const segment = safeSegment(input.runId);
  const directory = path.resolve(root, '.agent-run-spills', segment);
  const file = path.resolve(directory, 'transcript.txt');
  if (!isInsideWorkspace(root, directory) || !isInsideWorkspace(root, file)) return null;
  if (await pathContainsSymlink(root, directory)) return null;
  await mkdir(directory, { recursive: true });
  const created = await lstat(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) return null;
  await writeFile(file, input.text, { encoding: 'utf8', flag: 'w' });
  return `.agent-run-spills/${segment}/transcript.txt`;
}

/** Run status beside the spill. The prune command reads this file and keeps an open run. */
export async function writeSpillRunStatus(input: {
  workspaceRoot: string;
  runId: string;
  status: string;
}): Promise<void> {
  if (!input.workspaceRoot) return;
  const root = path.resolve(input.workspaceRoot);
  const directory = path.resolve(root, '.agent-run-spills', safeSegment(input.runId));
  const file = path.resolve(directory, 'status.json');
  if (!isInsideWorkspace(root, directory) || !isInsideWorkspace(root, file)) return;
  if (await pathContainsSymlink(root, directory)) return;
  await mkdir(directory, { recursive: true });
  const created = await lstat(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) return;
  await writeFile(file, `${JSON.stringify({ status: input.status })}\n`, { encoding: 'utf8', flag: 'w' });
}

export function spillSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
  return cleaned.length > 0 ? cleaned : 'spill';
}

function safeSegment(value: string): string {
  return spillSegment(value);
}

async function pathContainsSymlink(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return true;
  }
  let current = root;
  for (const part of relative.split(/[/\\]/).filter((item) => item.length > 0)) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        return true;
      }
    } catch (error) {
      if (isMissingFile(error)) {
        return false;
      }
      return true;
    }
  }
  return false;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT';
}
