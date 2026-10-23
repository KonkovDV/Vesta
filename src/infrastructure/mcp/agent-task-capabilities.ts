import type { IMcpServer } from '../../domain/mcp/IMcpServer';

/**
 * Capabilities we can honestly advertise.
 * tasks/get and tasks/cancel read an existing agent-run journal.
 * Task-augmented tools/call is a different contract: the server would have to
 * return a task id instead of the tool result. We do not do that.
 */
export function advertisedTaskCapabilities(
  server: Pick<IMcpServer, 'getTask' | 'cancelTask' | 'taskResult'>,
): { tasks: { cancel: Record<string, never> } } | undefined {
  if (!server.getTask || !server.cancelTask || !server.taskResult) return undefined;
  return { tasks: { cancel: {} } };
}
