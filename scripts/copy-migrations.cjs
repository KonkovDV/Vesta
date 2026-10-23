#!/usr/bin/env node
// The compiler emits JavaScript only. The migration runner reads SQL next to its dist/ file.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const from = path.join(root, 'src', 'infrastructure', 'database', 'migrations');
const to = path.join(root, 'dist', 'infrastructure', 'database', 'migrations');

if (!fs.existsSync(from)) {
  process.stderr.write(`missing ${from}\n`);
  process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
fs.mkdirSync(to, { recursive: true });
for (const name of fs.readdirSync(from)) {
  if (name.endsWith('.sql')) {
    fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
}

function copyJsonFiles(fromDir, toDir) {
  if (!fs.existsSync(fromDir)) return;
  for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
    const source = path.join(fromDir, entry.name);
    const target = path.join(toDir, entry.name);
    if (entry.isDirectory()) {
      copyJsonFiles(source, target);
    } else if (entry.name.endsWith('.json')) {
      fs.mkdirSync(toDir, { recursive: true });
      fs.copyFileSync(source, target);
    }
  }
}

copyJsonFiles(path.join(root, 'src', 'plugins'), path.join(root, 'dist', 'plugins'));
