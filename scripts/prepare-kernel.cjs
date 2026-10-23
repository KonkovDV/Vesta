#!/usr/bin/env node
/**
 * npm runs `prepare` after installing a git dependency, and also on `npm ci` in
 * this repository. The build runs only when the sources are present, so a
 * Docker layer that installs before copying src/ does not fail.
 */
'use strict';

const { existsSync } = require('node:fs');
const { execSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
if (!existsSync(path.join(root, 'src', 'kernel.ts'))) {
  process.stdout.write('prepare: src/ not present, build skipped\n');
  process.exit(0);
}
execSync('npm run build', { cwd: root, stdio: 'inherit' });
