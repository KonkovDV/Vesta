#!/usr/bin/env node
/**
 * Rewrites the `@/...`, `@core/...` path aliases in dist/ into relative paths.
 *
 * TypeScript keeps alias specifiers as written. module-alias resolves them from
 * the application's package.json, which breaks when the kernel is a dependency
 * inside another project's node_modules. After this step dist/ needs no loader.
 *
 * Usage: node scripts/rewrite-dist-aliases.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SPECIFIER = /(\brequire\(\s*|\bimport\(\s*|\bfrom\s+)(["'])(@[\w-]*)\/([^"']+)\2/g;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (/\.(js|d\.ts)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function targetExists(absolute, isDeclaration) {
  const candidates = isDeclaration
    ? [`${absolute}.d.ts`, path.join(absolute, 'index.d.ts'), `${absolute}.js`, `${absolute}.json`]
    : [`${absolute}.js`, path.join(absolute, 'index.js'), `${absolute}.json`, absolute];
  return candidates.some((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function rewriteDistAliases({ root, aliases }) {
  const distRoot = path.join(root, 'dist');
  const resolved = new Map(Object.entries(aliases).map(([alias, target]) => [alias, path.resolve(root, target)]));
  let files = 0;
  let specifiers = 0;
  const missing = [];

  for (const file of walk(distRoot, [])) {
    const text = fs.readFileSync(file, 'utf8');
    const isDeclaration = file.endsWith('.d.ts');
    let changed = 0;
    const next = text.replace(SPECIFIER, (match, prefix, quote, scope, rest, offset) => {
      const base = resolved.get(scope);
      if (!base) return match;
      // Doc examples in JSDoc and line comments are not module references.
      const lineStart = text.lastIndexOf('\n', offset) + 1;
      const lead = text.slice(lineStart, offset).trimStart();
      if (lead.startsWith('*') || lead.startsWith('//') || lead.startsWith('/*')) return match;
      const absolute = path.resolve(base, rest);
      if (!targetExists(absolute, isDeclaration)) {
        missing.push(`${path.relative(root, file)}: ${scope}/${rest}`);
        return match;
      }
      let relative = path.relative(path.dirname(file), absolute).split(path.sep).join('/');
      if (!relative.startsWith('.')) relative = `./${relative}`;
      changed += 1;
      return `${prefix}${quote}${relative}${quote}`;
    });
    if (changed > 0) {
      fs.writeFileSync(file, next);
      files += 1;
      specifiers += changed;
    }
  }

  if (missing.length > 0) {
    throw new Error(`Alias targets not found:\n${missing.slice(0, 20).join('\n')}`);
  }
  return { files, specifiers };
}

module.exports = { rewriteDistAliases };

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const result = rewriteDistAliases({ root, aliases: pkg._moduleAliases || {} });
  process.stdout.write(`aliases: ${result.specifiers} specifiers in ${result.files} files\n`);
}
