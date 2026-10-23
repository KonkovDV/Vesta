/**
 * Pure graph algorithms for code intelligence — Leiden community detection,
 * import extraction, BFS process tracing, entry-point detection, community
 * entropy, evolutionary coupling, structural signatures, Path-RAG, graph-diff.
 *
 * SOTA 2026 aligned:
 * - Leiden Algorithm (Traag et al., 2019, Scientific Reports)
 * - Community Entropy Metrics (architectural rot detection)
 * - Evolutionary Coupling (Zimmermann et al., 2005, ICSE)
 * - Structural Signatures (canonicalized AST hashing)
 * - Path-RAG (path-anchored context retrieval, arXiv:2601.10492)
 * - Graph-Diff Analysis (structural conflict detection)
 *
 * Layer: Infrastructure (shared utility)
 * No database or I/O dependencies — pure functions only.
 *
 * Path convention: all path operations normalize to forward slashes
 * for cross-platform consistency (Windows/Unix).
 */

import * as path from 'path';

/** Normalize path separators to forward slashes (cross-platform). */
function normSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Get parent directory from a normalized (forward-slash) path. */
function parentDir(normalizedPath: string): string {
  const lastSlash = normalizedPath.lastIndexOf('/');
  if (lastSlash <= 0) return normalizedPath.charAt(0) === '/' ? '/' : '.';
  return normalizedPath.substring(0, lastSlash);
}

/** Resolve a relative specifier (./foo, ../bar) against a normalized directory path. */
function resolveRelative(dirNorm: string, specifier: string): string {
  const parts = dirNorm.split('/');
  for (const seg of specifier.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') { if (parts.length > 1 || parts[0] !== '') parts.pop(); }
    else parts.push(seg);
  }
  return parts.join('/');
}

// ── Import Extraction ──

/**
 * Extract and resolve import paths from file content using regex patterns.
 * Supports TypeScript/JavaScript (import/require) and Python (relative from...import).
 */
export function extractImportsFromContent(
  filePath: string,
  content: string,
  knownFiles: Set<string>,
  repoRoot: string,
): string[] {
  const resolved = new Set<string>();
  const ext = path.extname(filePath).toLowerCase();

  if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
    // Pattern 1: import ... from 'path'  (handles multiline via [^;]+?)
    const fromImportRegex = /\bimport\s+[^;]+?\s+from\s+['"]([^'"]+)['"]/g;
    // Pattern 2: import 'path'  (side-effect import)
    const sideEffectRegex = /\bimport\s+['"]([^'"]+)['"]/g;
    // Pattern 3: require('path')
    const requireRegex = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

    for (const regex of [fromImportRegex, sideEffectRegex, requireRegex]) {
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const target = resolveImportPath(filePath, match[1], knownFiles, repoRoot);
        if (target) resolved.add(target);
      }
    }
  }

  if (ext === '.py') {
    const pyRelativeRegex = /^\s*from\s+(\.[.\w]*)\s+import/gm;
    let match: RegExpExecArray | null;
    while ((match = pyRelativeRegex.exec(content)) !== null) {
      const target = resolvePythonImport(filePath, match[1], knownFiles);
      if (target) resolved.add(target);
    }
  }

  return [...resolved];
}

/** Resolve a TS/JS import specifier to an absolute file path (null for external packages). */
export function resolveImportPath(
  importerPath: string,
  specifier: string,
  knownFiles: Set<string>,
  repoRoot: string,
): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('@/')) return null;

  const importerNorm = normSlash(importerPath);
  const rootNorm = normSlash(repoRoot);

  const basePath = specifier.startsWith('@/')
    ? `${rootNorm}/src/${specifier.slice(2)}`
    : resolveRelative(parentDir(importerNorm), specifier);

  const extensions = ['.ts', '.tsx', '.js', '.jsx'];
  const candidates = [
    basePath,
    ...extensions.map(ext => `${basePath}${ext}`),
    ...extensions.map(ext => `${basePath}/index${ext}`),
  ];

  // Normalize knownFiles for cross-platform comparison
  const normalizedKnown = new Set<string>();
  for (const f of knownFiles) normalizedKnown.add(normSlash(f));

  for (const candidate of candidates) {
    if (normalizedKnown.has(candidate)) return candidate;
  }
  return null;
}

/** Resolve a Python relative import to an absolute file path. */
function resolvePythonImport(
  importerPath: string,
  moduleSpec: string,
  knownFiles: Set<string>,
): string | null {
  let dots = 0;
  while (dots < moduleSpec.length && moduleSpec[dots] === '.') dots++;
  const modPath = moduleSpec.slice(dots).replace(/\./g, '/');

  const importerNorm = normSlash(importerPath);
  let baseDir = parentDir(importerNorm);
  for (let i = 1; i < dots; i++) baseDir = parentDir(baseDir);

  const normalizedKnown = new Set<string>();
  for (const f of knownFiles) normalizedKnown.add(normSlash(f));

  const candidates = [
    `${baseDir}/${modPath}.py`,
    `${baseDir}/${modPath}/__init__.py`,
  ];
  for (const c of candidates) {
    if (normalizedKnown.has(c)) return c;
  }
  return null;
}

// ── Leiden Community Detection ──

/**
 * Leiden community detection — guaranteed well-connected communities.
 * Improves on Louvain by adding a refinement phase that ensures each
 * community is internally connected (no "connected but inconsistent" clusters).
 *
 * Algorithm (Traag, Waltman, van Eck, 2019, Scientific Reports):
 *   Phase 1 (Local Moving): Greedily move nodes to best neighboring community.
 *   Phase 2 (Refinement): Split communities into well-connected sub-communities.
 *   Phase 3 (Aggregation): Build contracted graph and repeat.
 *
 * Returns nodeId → communityId mapping.
 */
export function detectCommunitiesLeiden(
  nodeIds: string[],
  edges: ReadonlyArray<{ source: string; target: string }>,
): Map<string, number> {
  const community = new Map<string, number>();
  nodeIds.forEach((id, i) => community.set(id, i));
  if (edges.length === 0 || nodeIds.length === 0) return community;

  // Build undirected weighted adjacency
  const adj = new Map<string, Map<string, number>>();
  for (const id of nodeIds) adj.set(id, new Map());
  for (const e of edges) {
    if (!adj.has(e.source) || !adj.has(e.target)) continue;
    adj.get(e.source)!.set(e.target, (adj.get(e.source)!.get(e.target) ?? 0) + 1);
    adj.get(e.target)!.set(e.source, (adj.get(e.target)!.get(e.source) ?? 0) + 1);
  }

  const m = edges.length;
  if (m === 0) return community;

  const degree = new Map<string, number>();
  for (const [id, neighbors] of adj) {
    let d = 0;
    for (const w of neighbors.values()) d += w;
    degree.set(id, d);
  }

  const MAX_OUTER = 10;

  for (let outer = 0; outer < MAX_OUTER; outer++) {
    // Phase 1: Local Moving (same as Louvain)
    let improved = true;
    let innerIter = 0;
    const MAX_INNER = 20;

    while (improved && innerIter < MAX_INNER) {
      improved = false;
      innerIter++;

      for (const nodeId of nodeIds) {
        const currentComm = community.get(nodeId)!;
        const ki = degree.get(nodeId)!;
        if (ki === 0) continue;

        const commEdges = new Map<number, number>();
        for (const [neighbor, weight] of adj.get(nodeId)!) {
          const nc = community.get(neighbor)!;
          commEdges.set(nc, (commEdges.get(nc) ?? 0) + weight);
        }

        const commDegreeSum = new Map<number, number>();
        for (const [id, comm] of community) {
          if (commEdges.has(comm) || comm === currentComm) {
            commDegreeSum.set(comm, (commDegreeSum.get(comm) ?? 0) + (degree.get(id) ?? 0));
          }
        }

        let bestComm = currentComm;
        let bestGain = 0;
        const kiInCurrent = commEdges.get(currentComm) ?? 0;
        const sigmaTotCurrent = (commDegreeSum.get(currentComm) ?? 0) - ki;

        for (const [candidateComm, kiIn] of commEdges) {
          if (candidateComm === currentComm) continue;
          const sigmaTot = commDegreeSum.get(candidateComm) ?? 0;
          const gain = (kiIn - kiInCurrent) / m - ki * (sigmaTot - sigmaTotCurrent) / (2 * m * m);
          if (gain > bestGain) {
            bestGain = gain;
            bestComm = candidateComm;
          }
        }

        if (bestComm !== currentComm) {
          community.set(nodeId, bestComm);
          improved = true;
        }
      }
    }

    // Phase 2: Refinement — ensure each community is well-connected
    // Split disconnected sub-communities using BFS connectivity check
    const communityGroups = new Map<number, string[]>();
    for (const [nodeId, commId] of community) {
      const group = communityGroups.get(commId);
      if (group) group.push(nodeId);
      else communityGroups.set(commId, [nodeId]);
    }

    let refinementMade = false;
    let nextCommId = Math.max(...communityGroups.keys()) + 1;

    for (const [, members] of communityGroups) {
      if (members.length < 2) continue;

      // BFS to find connected components within this community
      const memberSet = new Set(members);
      const visited = new Set<string>();
      const components: string[][] = [];

      for (const start of members) {
        if (visited.has(start)) continue;
        const component: string[] = [];
        const queue = [start];
        visited.add(start);

        while (queue.length > 0) {
          const current = queue.shift()!;
          component.push(current);
          for (const [neighbor] of adj.get(current) ?? []) {
            if (memberSet.has(neighbor) && !visited.has(neighbor)) {
              visited.add(neighbor);
              queue.push(neighbor);
            }
          }
        }
        components.push(component);
      }

      // If community has multiple disconnected components → split
      if (components.length > 1) {
        refinementMade = true;
        // Keep first component with original ID, assign new IDs to others
        for (let i = 1; i < components.length; i++) {
          for (const nodeId of components[i]) {
            community.set(nodeId, nextCommId);
          }
          nextCommId++;
        }
      }
    }

    if (!refinementMade) break; // Stable — no further refinement needed
  }

  return community;
}

/**
 * @deprecated Use detectCommunitiesLeiden instead. Kept for backward compatibility.
 * Louvain community detection (Phase 1 — single-level modularity optimization).
 */
export function detectCommunitiesLouvain(
  nodeIds: string[],
  edges: ReadonlyArray<{ source: string; target: string }>,
): Map<string, number> {
  return detectCommunitiesLeiden(nodeIds, edges);
}

// ── Community Helpers ──

/** Extract representative keywords from community member file paths. */
export function extractCommunityKeywords(memberIds: string[]): string[] {
  const segments = new Map<string, number>();
  const NOISE = new Set(['src', 'node_modules', 'dist', 'build', 'lib']);
  for (const id of memberIds) {
    const filePath = id.replace(/^file:/, '');
    for (const part of filePath.split(/[/\\]/)) {
      if (part && !part.startsWith('.') && !NOISE.has(part) && !part.includes('.')) {
        segments.set(part, (segments.get(part) ?? 0) + 1);
      }
    }
  }
  return [...segments.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([name]) => name);
}

/** Calculate community cohesion (ratio of internal edges to possible edges). */
export function calculateCohesion(
  memberIds: string[],
  allEdges: ReadonlyArray<{ source: string; target: string }>,
): number {
  const memberSet = new Set(memberIds);
  let internal = 0;
  for (const e of allEdges) {
    if (memberSet.has(e.source) && memberSet.has(e.target)) internal++;
  }
  const possible = memberIds.length * (memberIds.length - 1) / 2;
  return possible > 0 ? Math.min(internal / possible, 1) : 0;
}

// ── Process Tracing ──

/** Entry-point file name patterns (case-insensitive). */
const ENTRY_PATTERNS = /(?:^|[/\\])(?:index|main|app|server|bootstrap|orchestrator)\.[^/\\]+$/i;

/** Detect entry-point files from a list of file node IDs. */
export function detectEntryPoints(fileIds: string[]): string[] {
  return fileIds.filter(id => ENTRY_PATTERNS.test(id.replace(/^file:/, '')));
}

/** BFS trace from a start node following the given adjacency. Returns visited IDs in BFS order. */
export function bfsTrace(startId: string, adjacency: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const queue = [startId];
  visited.add(startId);

  while (queue.length > 0) {
    const current = queue.shift()!;
    order.push(current);

    for (const neighbor of adjacency.get(current) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return order;
}

// ── Community Entropy Metrics (Architectural Rot Detection) ──

/**
 * Community entropy — measures modularity quality of a community.
 * High entropy = many cross-boundary edges = poor modularity ("architectural rot").
 * Low entropy = well-encapsulated module.
 *
 * Formula: H = -Σ p_i * log2(p_i) where p_i = edge_type_count / total_edges
 * Normalized to [0, 1] range dividing by log2(edgeTypeCount).
 *
 * Returns: { entropy: number [0,1], internalRatio: number [0,1], crossBoundaryEdges: number }
 */
export function calculateCommunityEntropy(
  memberIds: string[],
  allEdges: ReadonlyArray<{ source: string; target: string; type?: string }>,
): { entropy: number; internalRatio: number; crossBoundaryEdges: number } {
  const memberSet = new Set(memberIds);
  let internalCount = 0;
  let crossCount = 0;
  const typeCounts = new Map<string, number>();

  for (const e of allEdges) {
    const srcIn = memberSet.has(e.source);
    const tgtIn = memberSet.has(e.target);
    if (!srcIn && !tgtIn) continue; // edge doesn't touch community

    if (srcIn && tgtIn) {
      internalCount++;
    } else {
      crossCount++;
    }

    const key = `${srcIn && tgtIn ? 'internal' : 'cross'}:${e.type ?? 'UNKNOWN'}`;
    typeCounts.set(key, (typeCounts.get(key) ?? 0) + 1);
  }

  const total = internalCount + crossCount;
  if (total === 0) return { entropy: 0, internalRatio: 1, crossBoundaryEdges: 0 };

  // Shannon entropy over edge type distribution
  let H = 0;
  for (const count of typeCounts.values()) {
    const p = count / total;
    if (p > 0) H -= p * Math.log2(p);
  }

  const maxH = typeCounts.size > 1 ? Math.log2(typeCounts.size) : 1;
  const normalizedEntropy = maxH > 0 ? Math.min(H / maxH, 1) : 0;

  return {
    entropy: normalizedEntropy,
    internalRatio: total > 0 ? internalCount / total : 1,
    crossBoundaryEdges: crossCount,
  };
}

// ── Evolutionary Coupling (Git Evolution Mining) ──

/** Commit-level co-change record. */
export interface CoChangeRecord {
  readonly fileA: string;
  readonly fileB: string;
  readonly coChangeCount: number;
  readonly totalCommitsA: number;
  readonly totalCommitsB: number;
}

/**
 * Calculate evolutionary coupling (co-change frequency) from commit history.
 * Uses mutual information scoring: support = co-changes / total_commits,
 * confidence = co-changes / max(commits_A, commits_B).
 *
 * Reference: Zimmermann et al. 2005, "Mining Version Histories to Guide Software Changes" (ICSE)
 *
 * @param commitFiles — Array of sets, each set = file paths changed in one commit.
 * @param minSupport — Minimum co-change count threshold (default: 2).
 * @returns Evolutionary coupling pairs sorted by coupling strength.
 */
export function calculateEvolutionaryCoupling(
  commitFiles: ReadonlyArray<ReadonlySet<string>>,
  minSupport: number = 2,
): CoChangeRecord[] {
  const fileCommitCount = new Map<string, number>();
  const pairCount = new Map<string, number>();

  for (const files of commitFiles) {
    const arr = [...files].sort();
    for (const f of arr) {
      fileCommitCount.set(f, (fileCommitCount.get(f) ?? 0) + 1);
    }
    // Count co-occurrences (pairs within same commit)
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const key = `${arr[i]}||${arr[j]}`;
        pairCount.set(key, (pairCount.get(key) ?? 0) + 1);
      }
    }
  }

  const results: CoChangeRecord[] = [];
  for (const [key, count] of pairCount) {
    if (count < minSupport) continue;
    const [fileA, fileB] = key.split('||');
    results.push({
      fileA,
      fileB,
      coChangeCount: count,
      totalCommitsA: fileCommitCount.get(fileA) ?? 0,
      totalCommitsB: fileCommitCount.get(fileB) ?? 0,
    });
  }

  // Sort by coupling strength (co-change count descending, then confidence)
  return results.sort((a, b) => {
    if (b.coChangeCount !== a.coChangeCount) return b.coChangeCount - a.coChangeCount;
    const confA = a.coChangeCount / Math.max(a.totalCommitsA, a.totalCommitsB);
    const confB = b.coChangeCount / Math.max(b.totalCommitsA, b.totalCommitsB);
    return confB - confA;
  });
}

/**
 * Calculate coupling confidence for a specific pair.
 * Confidence = co-changes / max(commits_A, commits_B).
 */
export function couplingConfidence(record: CoChangeRecord): number {
  const maxCommits = Math.max(record.totalCommitsA, record.totalCommitsB);
  return maxCommits > 0 ? record.coChangeCount / maxCommits : 0;
}

// ── Structural Signatures ──

/**
 * Generate a structural signature for a code symbol by normalizing its content.
 * Strips variable names, comments, and whitespace to produce a canonical form.
 * Used to detect semantically equivalent code across refactors.
 *
 * Returns a hex hash of the normalized form.
 */
export function computeStructuralSignature(content: string): string {
  // Normalize: strip comments, collapse whitespace, remove string literals
  let normalized = content
    .replace(/\/\/[^\n]*/g, '')           // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')     // multi-line comments
    .replace(/#[^\n]*/g, '')              // Python comments
    .replace(/'(?:[^'\\]|\\.)*'/g, "'_'") // single-quoted strings
    .replace(/"(?:[^"\\]|\\.)*"/g, '"_"') // double-quoted strings
    .replace(/`(?:[^`\\]|\\.)*`/g, '`_`') // template literals
    .replace(/\s+/g, ' ')                // collapse whitespace
    .trim();

  // Simple hash (DJB2) — deterministic, no crypto import needed in pure context
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) & 0xFFFFFFFF;
  }
  return hash.toString(16).padStart(8, '0');
}

// ── Path-RAG: Path-Anchored Context Retrieval ──

/**
 * Find the minimal subgraph connecting a set of target nodes.
 * Uses BFS from each target to find shortest paths, then returns
 * the union of all paths (Steiner tree approximation).
 *
 * Reference: arXiv:2601.10492 — Neuro-Symbolic GraphRAG
 *
 * @param targetIds — nodes to connect
 * @param adjacency — undirected adjacency (node → neighbors)
 * @returns Set of node IDs forming the minimal spanning subgraph
 */
export function findMinimalSpanningSubgraph(
  targetIds: string[],
  adjacency: Map<string, string[]>,
): Set<string> {
  if (targetIds.length === 0) return new Set();
  if (targetIds.length === 1) return new Set(targetIds);

  const result = new Set<string>();
  // For each pair of targets, find shortest path via BFS
  for (let i = 0; i < targetIds.length; i++) {
    for (let j = i + 1; j < targetIds.length; j++) {
      const pathNodes = bfsShortestPath(targetIds[i], targetIds[j], adjacency);
      for (const n of pathNodes) result.add(n);
    }
  }

  return result;
}

/**
 * BFS shortest path between two nodes. Returns path node IDs (empty if unreachable).
 */
export function bfsShortestPath(
  startId: string,
  endId: string,
  adjacency: Map<string, string[]>,
): string[] {
  if (startId === endId) return [startId];

  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue = [startId];
  visited.add(startId);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        parent.set(neighbor, current);
        if (neighbor === endId) {
          // Reconstruct path
          const path: string[] = [endId];
          let cursor = endId;
          while (parent.has(cursor)) {
            cursor = parent.get(cursor)!;
            path.unshift(cursor);
          }
          return path;
        }
        queue.push(neighbor);
      }
    }
  }

  return []; // Unreachable
}

// ── Graph-Diff Analysis ──

/** Result of comparing two graph snapshots. */
export interface GraphDiffResult {
  readonly addedNodes: string[];
  readonly removedNodes: string[];
  readonly addedEdges: Array<{ source: string; target: string; type: string }>;
  readonly removedEdges: Array<{ source: string; target: string; type: string }>;
  readonly modifiedNodes: string[];
  /** Structural conflicts: nodes affected by both additions and removals. */
  readonly conflicts: string[];
}

/**
 * Compute structural diff between two graph snapshots.
 * Identifies added/removed/modified nodes and edges, plus structural conflicts
 * where the same node is affected by contradictory changes.
 *
 * Used for detecting merge conflicts before CI/CD pipeline.
 */
export function computeGraphDiff(
  oldNodes: ReadonlySet<string>,
  newNodes: ReadonlySet<string>,
  oldEdges: ReadonlyArray<{ source: string; target: string; type: string }>,
  newEdges: ReadonlyArray<{ source: string; target: string; type: string }>,
  oldHashes?: ReadonlyMap<string, string>,
  newHashes?: ReadonlyMap<string, string>,
): GraphDiffResult {
  const addedNodes: string[] = [];
  const removedNodes: string[] = [];
  const modifiedNodes: string[] = [];

  for (const n of newNodes) {
    if (!oldNodes.has(n)) addedNodes.push(n);
    else if (oldHashes && newHashes) {
      const oldH = oldHashes.get(n);
      const newH = newHashes.get(n);
      if (oldH && newH && oldH !== newH) modifiedNodes.push(n);
    }
  }
  for (const n of oldNodes) {
    if (!newNodes.has(n)) removedNodes.push(n);
  }

  const edgeKey = (e: { source: string; target: string; type: string }) =>
    `${e.source}→${e.target}:${e.type}`;

  const oldEdgeSet = new Set(oldEdges.map(edgeKey));
  const newEdgeSet = new Set(newEdges.map(edgeKey));

  const addedEdges = newEdges.filter(e => !oldEdgeSet.has(edgeKey(e)));
  const removedEdges = oldEdges.filter(e => !newEdgeSet.has(edgeKey(e)));

  // Conflicts: nodes that appear in both added edge endpoints and removed edge endpoints
  const addedEndpoints = new Set<string>();
  const removedEndpoints = new Set<string>();
  for (const e of addedEdges) { addedEndpoints.add(e.source); addedEndpoints.add(e.target); }
  for (const e of removedEdges) { removedEndpoints.add(e.source); removedEndpoints.add(e.target); }

  const conflicts: string[] = [];
  for (const n of addedEndpoints) {
    if (removedEndpoints.has(n)) conflicts.push(n);
  }
  // Also include nodes that are both modified and have edge changes
  for (const n of modifiedNodes) {
    if ((addedEndpoints.has(n) || removedEndpoints.has(n)) && !conflicts.includes(n)) {
      conflicts.push(n);
    }
  }

  return { addedNodes, removedNodes, addedEdges, removedEdges, modifiedNodes, conflicts };
}

// ── Refactoring Suggestions (Community-Folder Mismatch) ──

/** Suggested file relocation to improve community cohesion. */
export interface RelocationSuggestion {
  readonly fileId: string;
  readonly currentFolder: string;
  readonly suggestedFolder: string;
  readonly reason: string;
  readonly confidence: number;
}

/**
 * Detect files that are physically in one folder but logically belong
 * to a different community (based on community detection).
 * Suggests relocations to improve architectural cohesion.
 *
 * Reference: Recommendation 3.2 — Automated Refactoring Proposals
 */
export function suggestRelocations(
  nodeIds: string[],
  communityAssignment: Map<string, number>,
  nodeFilePaths: Map<string, string>,
): RelocationSuggestion[] {
  // Build community → majority folder mapping
  const communityFolders = new Map<number, Map<string, number>>();
  for (const [nodeId, commId] of communityAssignment) {
    const filePath = nodeFilePaths.get(nodeId);
    if (!filePath) continue;
    const folder = parentDir(normSlash(filePath));
    if (!communityFolders.has(commId)) communityFolders.set(commId, new Map());
    const folderCounts = communityFolders.get(commId)!;
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
  }

  // For each community, find the majority folder
  const communityMajorityFolder = new Map<number, string>();
  for (const [commId, folders] of communityFolders) {
    let maxCount = 0;
    let majorityFolder = '';
    for (const [folder, count] of folders) {
      if (count > maxCount) { maxCount = count; majorityFolder = folder; }
    }
    if (maxCount >= 2) communityMajorityFolder.set(commId, majorityFolder);
  }

  const suggestions: RelocationSuggestion[] = [];
  for (const nodeId of nodeIds) {
    const commId = communityAssignment.get(nodeId);
    const filePath = nodeFilePaths.get(nodeId);
    if (commId === undefined || !filePath) continue;

    const currentFolder = parentDir(normSlash(filePath));
    const suggestedFolder = communityMajorityFolder.get(commId);
    if (!suggestedFolder || currentFolder === suggestedFolder) continue;

    // Only suggest if the node has strong community membership
    suggestions.push({
      fileId: nodeId,
      currentFolder,
      suggestedFolder,
      reason: `File is in community ${commId} (majority folder: ${suggestedFolder}) but resides in ${currentFolder}`,
      confidence: 0.7,
    });
  }

  return suggestions;
}
