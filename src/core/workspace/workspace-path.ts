import path from 'node:path';

/** True when candidate is the workspace root or a path inside it. */
export function isInsideWorkspace(workspaceRoot: string, candidate: string): boolean {
  if (!workspaceRoot) {
    return false;
  }
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(candidate);
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
