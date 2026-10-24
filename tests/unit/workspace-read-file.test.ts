import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceReadFileTool } from '../../src/application/agents/tools/workspace-read-file.tool';

const scanner = { detectSuspiciousPatterns: () => [] };

test('read_file refuses a file reached through a linked directory', async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'readfile-'));
  const workspace = path.join(base, 'ws');
  const outside = path.join(base, 'outside');
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), 'secret');
  await writeFile(path.join(workspace, 'ok.txt'), 'inside');
  try {
    await symlink(outside, path.join(workspace, 'linkdir'));
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'EPERM' || code === 'EACCES') {
      t.skip('this process cannot create a symlink');
      return;
    }
    throw error;
  }
  const tool = new WorkspaceReadFileTool(scanner as never);
  const context = { workspaceRoot: workspace } as never;

  const escaped = await tool.execute({ path: path.join(workspace, 'linkdir', 'secret.txt') }, context) as { error?: string; content?: string };
  assert.equal(escaped.error, 'path is outside workspaceRoot');
  const inside = await tool.execute({ path: path.join(workspace, 'ok.txt') }, context) as { content?: string };
  assert.equal(inside.content, 'inside');
});
