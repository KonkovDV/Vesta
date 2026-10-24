import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import CodeInterpreterPlugin from '../../src/plugins/standard/code-interpreter/index';
import FileSystemPlugin from '../../src/plugins/standard/file-system/index';
import { assertBrowsableUrl } from '../../src/plugins/standard/web-browser/index';
import { SsrfDnsGuard } from '../../src/infrastructure/security/SsrfDnsGuard';
import { PluginAutoLoader } from '../../src/infrastructure/plugins/PluginAutoLoader';

type Tool = { name: string; execute: (args: unknown, context?: unknown) => Promise<unknown> };

async function load(plugin: { onLoad(context: unknown): Promise<void> }): Promise<Record<string, Tool>> {
  const tools: Record<string, Tool> = {};
  await plugin.onLoad({ logger: { info() {}, debug() {} }, tools: { register(tool: Tool) { tools[tool.name] = tool; } } });
  return tools;
}

test('code_execute does not run code (node:vm escape stays closed)', async () => {
  const tools = await load(new CodeInterpreterPlugin());
  const output = String(await tools.code_execute.execute({ code: "console.log.constructor('return process')().pid" }));
  assert.match(output, /disabled/);
  assert.doesNotMatch(output, new RegExp(`"result":\\s*${process.pid}`));
});

test('file-system plugin refuses sibling prefixes and symlinks that leave the sandbox', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'fsplugin-'));
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const tools = await load(new FileSystemPlugin());
    const root = path.join(cwd, 'sandbox', 'fs');
    await mkdir(path.join(cwd, 'sandbox', 'fs-other'), { recursive: true });
    await writeFile(path.join(cwd, 'sandbox', 'fs-other', 'secret.txt'), 'sibling secret');
    await writeFile(path.join(cwd, 'outside.txt'), 'outside secret');
    assert.match(String(await tools.fs_read_file.execute({ path: '../fs-other/secret.txt' })), /Access Denied/);
    try {
      await symlink(cwd, path.join(root, 'link'));
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      if (code === 'EPERM' || code === 'EACCES') {
        t.skip('this process cannot create a symlink');
        return;
      }
      throw error;
    }

    assert.match(String(await tools.fs_read_file.execute({ path: 'link/outside.txt' })), /Access Denied/);
    assert.match(String(await tools.fs_write_file.execute({ path: 'link/planted.txt', content: 'x' })), /Access Denied/);

    assert.match(String(await tools.fs_write_file.execute({ path: 'notes/a.txt', content: 'inside' })), /Success/);
    assert.equal(await readFile(path.join(root, 'notes', 'a.txt'), 'utf8'), 'inside');
  } finally {
    process.chdir(previous);
  }
});

test('web-browser navigation accepts only public http(s) URLs', async () => {
  const guard = new SsrfDnsGuard();
  for (const url of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'http://169.254.169.254/', 'http://127.0.0.1:3000/']) {
    await assert.rejects(assertBrowsableUrl(guard, url), undefined, url);
  }
  await assertBrowsableUrl(guard, 'http://93.184.215.14/');
});

test('standard plugins load only when STANDARD_PLUGINS names them', () => {
  assert.deepEqual([...(PluginAutoLoader.enabledPlugins('') as Set<string>)], []);
  assert.deepEqual([...(PluginAutoLoader.enabledPlugins(' file-system , web-browser') as Set<string>)], ['file-system', 'web-browser']);
  assert.equal(PluginAutoLoader.enabledPlugins('*'), 'all');
});
