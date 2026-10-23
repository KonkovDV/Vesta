import { container } from '../../../core/di/container';
import { DI_TOKENS } from '../../../core/di/DI_TOKENS';
import { getBootstrapLogger } from '../../../core/logging/bootstrap-logger';
import { UserApprovalInterceptorAdapter } from '../../security/UserApprovalInterceptorAdapter';

const log = getBootstrapLogger('user-approval');

export function registerUserApprovalModule(): void {
  if (container.isRegistered(DI_TOKENS.IUserApprovalInterceptor)) {
    return;
  }

  try {
    container.register(
      DI_TOKENS.IUserApprovalInterceptor,
      (c) => new UserApprovalInterceptorAdapter(c.resolve(DI_TOKENS.ILogger)),
      {
        lifecycle: 'singleton',
        tags: ['security', 'approval', 'mcp'],
        description: 'In-memory user approval interceptor for MCP escalation flow',
      },
    );
  } catch (err) {
    log.error(`[user-approval] DI registration failed: ${String(err)}`);
    throw err;
  }
}