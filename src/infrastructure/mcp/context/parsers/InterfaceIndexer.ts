/**
 * InterfaceIndexer — Indexes all exported interfaces in src/ using ts-morph.
 *
 * Layer: Infrastructure (dev-time)
 *
 * At startup, scans all *.ts files under src/ for `export interface I*` declarations,
 * extracting method signatures, file paths, and dependencies.
 *
 * Uses skipFileDependencyResolution for fast loading (~200 interfaces in <2s).
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

export interface InterfaceInfo {
  name: string;
  file: string;
  line: number;
  methods: string[];
  dependencies: string[];
}

/**
 * Indexes interfaces via regex-based parsing (fast alternative to ts-morph AST).
 * Extracts method signatures from `export interface I*` blocks.
 */
export class InterfaceIndexer {
  private static cache: Map<string, InterfaceInfo> | null = null;
  private static readonly SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', 'temp', '__mocks__']);

  static index(projectRoot: string): Map<string, InterfaceInfo> {
    if (this.cache) return this.cache;

    const srcDir = path.join(projectRoot, 'src');
    const result = new Map<string, InterfaceInfo>();

    if (!fs.existsSync(srcDir)) return result;

    const tsFiles = this.findTsFiles(srcDir);

    for (const filePath of tsFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const relPath = path.relative(projectRoot, filePath).replace(/\\/g, '/');
        this.parseInterfaces(content, relPath, result);
      } catch {
        // Skip files that can't be read
      }
    }

    this.cache = result;
    return result;
  }

  private static findTsFiles(dir: string): string[] {
    const result: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !this.SKIP_DIRS.has(entry.name)) {
        result.push(...this.findTsFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.spec.ts') && !entry.name.endsWith('.d.ts')) {
        result.push(fullPath);
      }
    }
    return result;
  }

  private static parseInterfaces(
    content: string,
    filePath: string,
    result: Map<string, InterfaceInfo>,
  ): void {
    // Match exported interfaces
    const interfaceRegex = /^export\s+interface\s+(I\w+)(?:\s+extends\s+([^{]+))?\s*\{/gm;
    let match: RegExpExecArray | null;

    while ((match = interfaceRegex.exec(content)) !== null) {
      const name = match[1];
      const extendsClause = match[2]?.trim();
      const startIndex = match.index;
      const line = content.slice(0, startIndex).split('\n').length;

      // Find the closing brace of the interface
      let braceCount = 0;
      let endIndex = content.indexOf('{', startIndex);
      for (let i = endIndex; i < content.length; i++) {
        if (content[i] === '{') braceCount++;
        if (content[i] === '}') braceCount--;
        if (braceCount === 0) {
          endIndex = i;
          break;
        }
      }

      const body = content.slice(content.indexOf('{', startIndex) + 1, endIndex);

      // Extract method signatures — strip block comments first so JSDoc doesn't confuse regex
      const methods: string[] = [];
      const strippedBody = body.replace(/\/\*[\s\S]*?\*\//g, '');
      const methodRegex = /^[ \t]*(?:readonly\s+)?(\w+)\??\s*[(<]/gm;
      let methodMatch: RegExpExecArray | null;
      while ((methodMatch = methodRegex.exec(strippedBody)) !== null) {
        // Get the full line for this method
        const lineStart = strippedBody.lastIndexOf('\n', methodMatch.index) + 1;
        const lineEnd = strippedBody.indexOf('\n', methodMatch.index);
        const fullLine = strippedBody
          .slice(lineStart, lineEnd === -1 ? strippedBody.length : lineEnd)
          .trim()
          .replace(/;$/, '')
          .replace(/\/\/.*$/g, '')
          .trim();
        if (fullLine && !fullLine.startsWith('//')) {
          methods.push(fullLine);
        }
      }

      // Extract dependencies from type references
      const deps: Set<string> = new Set();
      if (extendsClause) {
        extendsClause.split(',').forEach((e) => deps.add(e.trim().split('<')[0]));
      }
      // Find type references in method signatures
      const typeRefRegex = /(?<!['"A-Za-z])([A-Z][A-Za-z]+(?:Id|Event|Result|State|Context|Config|Options))\b/g;
      let typeMatch: RegExpExecArray | null;
      while ((typeMatch = typeRefRegex.exec(body)) !== null) {
        if (typeMatch[1] !== name && !['Promise', 'Array', 'Map', 'Set', 'Record', 'Partial', 'Required'].includes(typeMatch[1])) {
          deps.add(typeMatch[1]);
        }
      }

      result.set(name, {
        name,
        file: filePath,
        line,
        methods: methods.slice(0, 20), // Cap at 20 to avoid huge outputs
        dependencies: Array.from(deps).slice(0, 15),
      });
    }
  }

  static invalidate(): void {
    this.cache = null;
  }
}
