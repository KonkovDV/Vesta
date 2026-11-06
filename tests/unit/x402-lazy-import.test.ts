import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function probe(mode: 'on' | 'off'): { loaded: boolean; registered: boolean } {
  const script = path.join(__dirname, '..', 'gates', 'x402-import-probe.ts');
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, mode], {
    encoding: 'utf8',
    cwd: path.join(__dirname, '..', '..'),
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split('\n').find((row) => row.startsWith('X402_PROBE '));
  assert.ok(line, result.stdout);
  return JSON.parse(line.slice('X402_PROBE '.length)) as { loaded: boolean; registered: boolean };
}

test('x402 payment modules stay unloaded while the domain is off', () => {
  const observed = probe('off');
  assert.equal(observed.loaded, false);
  assert.equal(observed.registered, false);
});

test('x402 payment modules load and register when the domain is on', () => {
  const observed = probe('on');
  assert.equal(observed.loaded, true);
  assert.equal(observed.registered, true);
});
