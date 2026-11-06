'use strict';

/**
 * T2.3 ceiling: resolve() calls with a string literal in src. A typed token
 * (container.inject) replaces one; the count may only go down.
 */
const fs = require('node:fs');
const path = require('node:path');
const { countStringResolves } = require('./ci-gates-lib.cjs');

const root = path.join(__dirname, '..');
const budget = JSON.parse(fs.readFileSync(path.join(root, 'tests', 'gates', 'di-literal-budget.json'), 'utf8'));

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.typecheck.ts')) files.push(full);
  }
  return files;
}

let count = 0;
for (const file of walk(path.join(root, 'src'))) count += countStringResolves(fs.readFileSync(file, 'utf8'));
console.log(`DI-LITERALS count=${count} max=${budget.max}`);
if (count > budget.max) {
  console.error(`GATE-FAIL ${count - budget.max} new resolve() calls with a string token; use container.inject(createToken<T>(...))`);
  process.exit(1);
}
if (count < budget.max) console.log(`GATE-BUDGET-CAN-SHRINK set max to ${count}`);
console.log('GATE-OK di-literals');
