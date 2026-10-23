/**
 * AstGraphBuilder — Populates Knowledge Graph from TypeScript AST analysis.
 *
 * Uses the existing InterfaceIndexer (regex-based, fast) to extract
 * interfaces and their methods, then adds interface→method edges.
 *
 * For implementations, scans `src/infrastructure/` for `implements I*`
 * patterns and creates implementation→interface edges.
 *
 * Deliberately avoids full ts-morph Project for speed (InterfaceIndexer
 * indexes ~200 interfaces in <2s with regex-based parsing).
 *
 * @layer Infrastructure/Context
 * @phase 5 — V3 Context Engineering: Knowledge Graph
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { InterfaceIndexer } from '../../../mcp/context/parsers/InterfaceIndexer';
import type { KnowledgeGraphEngine } from '../KnowledgeGraphEngine';
import { detectLayer } from '../../../mcp/shared/mcp-utils';

// ── Builder ─────────────────────────────────────────────────────────

export class AstGraphBuilder {
  private readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /**
   * Build interface + method + implementation nodes from codebase AST analysis.
   */
  build(engine: KnowledgeGraphEngine): void {
    this.buildInterfaceGraph(engine);
    this.buildImplementationGraph(engine);
  }

  /**
   * Add interface nodes + method sub-nodes from InterfaceIndexer.
   */
  private buildInterfaceGraph(engine: KnowledgeGraphEngine): void {
    const interfaceIndex = InterfaceIndexer.index(this.projectRoot);

    for (const [name, info] of interfaceIndex) {
      const ifaceId = `interface:${name}`;
      const layer = detectLayer(info.file);

      engine.addNode({
        id: ifaceId,
        type: 'interface',
        label: name,
        metadata: {
          file: info.file,
          line: info.line,
          layer,
          methodCount: info.methods.length,
          dependencies: info.dependencies,
        },
      });

      // Link to layer
      if (layer) {
        const layerId = `layer:${layer}`;
        if (!engine.hasNode(layerId)) {
          engine.addNode({
            id: layerId,
            type: 'layer',
            label: layer,
            metadata: {},
          });
        }
        engine.addEdge({
          source: ifaceId,
          target: layerId,
          relation: 'belongs_to',
        });
      }

      // Add method sub-nodes
      for (const methodSig of info.methods) {
        const methodName = methodSig.replace(/\(.*$/, '').trim();
        const methodId = `method:${name}.${methodName}`;
        engine.addNode({
          id: methodId,
          type: 'method',
          label: methodName,
          metadata: { signature: methodSig, interface: name },
        });
        engine.addEdge({
          source: ifaceId,
          target: methodId,
          relation: 'has_method',
        });
      }

      // Add dependency edges (extends)
      for (const dep of info.dependencies) {
        const depId = `interface:${dep}`;
        engine.addEdge({
          source: ifaceId,
          target: depId,
          relation: 'implements',
        });
      }
    }
  }

  /**
   * Scan Infrastructure layer for `implements I*` and create edges.
   */
  private buildImplementationGraph(engine: KnowledgeGraphEngine): void {
    const infraDir = path.join(this.projectRoot, 'src', 'infrastructure');
    if (!fs.existsSync(infraDir)) return;

    const tsFiles = this.findTsFiles(infraDir);

    for (const filePath of tsFiles) {
      try {
        // FIX: PH-003 — regex with /g flag declared inside loop to prevent lastIndex state leak
        const implRegex = /export\s+class\s+(\w+)(?:\s+extends\s+\w+)?\s+implements\s+([^{]+)\{/g;
        const content = fs.readFileSync(filePath, 'utf-8');
        const relPath = path.relative(this.projectRoot, filePath).replace(/\\/g, '/');
        let match: RegExpExecArray | null;

        while ((match = implRegex.exec(content)) !== null) {
          const className = match[1];
          const interfaces = match[2]
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.startsWith('I') && s.length > 1);

          const implId = `impl:${className}`;
          engine.addNode({
            id: implId,
            type: 'implementation',
            label: className,
            metadata: { file: relPath },
          });

          for (const ifaceName of interfaces) {
            const ifaceId = `interface:${ifaceName}`;
            engine.addEdge({
              source: implId,
              target: ifaceId,
              relation: 'implements',
            });
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  private findTsFiles(dir: string): string[] {
    const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage', 'temp', '__mocks__']);
    const result: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !SKIP.has(entry.name)) {
        result.push(...this.findTsFiles(fullPath));
      } else if (
        entry.isFile()
        && entry.name.endsWith('.ts')
        && !entry.name.endsWith('.test.ts')
        && !entry.name.endsWith('.spec.ts')
        && !entry.name.endsWith('.d.ts')
      ) {
        result.push(fullPath);
      }
    }
    return result;
  }


}
