import type { Aspect, AroundAdviceContext } from './Aspect';
import type { IAuthService, AuthContext } from '../auth/IAuthService';

export interface SecurityAspectOptions {
  requiredScope?: string;
  metadataScopeKey?: string;
  roleMapper?: (context: AroundAdviceContext, auth: AuthContext) => string | string[] | null | undefined;
  ensurePermissions?: (context: AroundAdviceContext, auth: AuthContext) => boolean | Promise<boolean>;
  bypass?: (context: AroundAdviceContext) => boolean | Promise<boolean>;
  cacheContextAttribute?: string;
}

export class SecurityAspect implements Aspect {
  private readonly authService: IAuthService;
  private readonly options: Required<SecurityAspectOptions>;

  constructor(authService: IAuthService, options: SecurityAspectOptions = {}) {
    this.authService = authService;
    this.options = {
      requiredScope: options.requiredScope ?? '',
      metadataScopeKey: options.metadataScopeKey ?? 'security:requiredScope',
      roleMapper: options.roleMapper ?? (() => null),
      ensurePermissions: options.ensurePermissions ?? (() => true),
      bypass: options.bypass ?? (() => false),
      cacheContextAttribute: options.cacheContextAttribute ?? 'security:authContext',
    };
  }

  async around(context: AroundAdviceContext): Promise<unknown> {
    if (await this.options.bypass(context)) {
      return context.proceed();
    }

    const authCtx = await this.authenticate(context);
    if (!authCtx) {
      throw this.authService.authError?.('Authorization failed', 403) ??
        new Error('Authorization failed');
    }

    const required = this.resolveRequiredScope(context, authCtx);
    if (required) {
      this.authService.ensureScope(authCtx, required);
    }

    const permitted = await this.options.ensurePermissions(context, authCtx);
    if (!permitted) {
      throw this.authService.authError?.('Insufficient permissions', 403) ??
        new Error('Insufficient permissions');
    }

    const roles = this.options.roleMapper(context, authCtx);
    if (roles) {
      context.setAttribute('security:roles', Array.isArray(roles) ? roles : [roles]);
    }

    context.setAttribute(this.options.cacheContextAttribute, authCtx);

    return context.proceed();
  }

  private async authenticate(context: AroundAdviceContext): Promise<AuthContext | null> {
    const args = context.args;
    if (!args.length) {
      return null;
    }
    const tokenCandidate = this.extractToken(args[0]);
    if (!tokenCandidate) {
      return null;
    }
    try {
      return await this.authService.authenticate(tokenCandidate);
    } catch (error) {
      context.setAttribute('security:error', error);
      return null;
    }
  }

  private extractToken(candidate: unknown): string | null {
    if (!candidate || typeof candidate !== 'object') {
      return null;
    }

    const candidateWithToken = candidate as { token?: unknown; authToken?: unknown };
    
    if (typeof candidateWithToken.token === 'string') {
      return candidateWithToken.token;
    }

    if (typeof candidateWithToken.authToken === 'string') {
      return candidateWithToken.authToken;
    }

    return null;
  }

  private resolveRequiredScope(context: AroundAdviceContext, auth: AuthContext): string | null {
    const metadataWithNested = context.metadata as { metadata?: Record<string, unknown> };
    const nestedMetadata = metadataWithNested?.metadata;
    if (nestedMetadata) {
      const metaScope = nestedMetadata[this.options.metadataScopeKey];
      if (typeof metaScope === 'string' && metaScope.length > 0) {
        return metaScope;
      }
    }
    if (this.options.requiredScope) {
      return this.options.requiredScope;
    }
    const joinPointWithMetadata = context.metadata.joinPoint as { metadata?: { requiredScope?: unknown } };
    const joinPointMetadata = joinPointWithMetadata?.metadata;
    if (joinPointMetadata?.requiredScope) {
      const scope = joinPointMetadata.requiredScope;
      if (typeof scope === 'string') return scope;
    }
    context.setAttribute('security:resolvedScopes', auth.scopes);
    return null;
  }
}