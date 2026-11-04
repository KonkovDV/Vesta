/**
 * Two processes that start in the same directory in the same millisecond used the
 * same write-probe name: one unlinked the other's file, the second unlink failed,
 * and the critical filesystem check stopped that start. Seen in 1 of 20 parallel boots.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FileSystemCheck } from '../../src/core/bootstrap/checks/filesystem-check';

test('concurrent filesystem checks in one directory all pass and leave no probe file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mp-fs-check-'));
  const realNow = Date.now;
  const frozen = realNow();
  Date.now = () => frozen;
  try {
    const checks = Array.from({ length: 8 }, () => new FileSystemCheck([{ path: dir, writable: true }]));
    const results = await Promise.all(checks.map((check) => check.check()));
    assert.deepEqual(results.map((result) => result.passed), Array(8).fill(true), JSON.stringify(results.map((r) => r.message)));
    assert.deepEqual(await readdir(dir), []);
  } finally {
    Date.now = realNow;
    await rm(dir, { recursive: true, force: true });
  }
});
