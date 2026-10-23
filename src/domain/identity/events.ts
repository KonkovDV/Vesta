import { DomainEvent } from '../../core/domain/AggregateRoot';
import { EntityId } from '../../core/types';
import type { UserRole } from './User';
import type { TenantTier } from './Tenant';

export interface UserCreated extends DomainEvent {
  type: 'UserCreated';
  payload: {
    userId: string;
    email: string;
    role: UserRole;
    tenantId: string;
  };
}

export interface UserUpdated extends DomainEvent {
  type: 'UserUpdated';
  payload: {
    userId: string;
    changes: Record<string, unknown>;
  };
}

export interface UserRoleChanged extends DomainEvent {
  type: 'UserRoleChanged';
  payload: {
    userId: string;
    oldRole: UserRole;
    newRole: UserRole;
  };
}

export interface TenantProvisioned extends DomainEvent {
  type: 'TenantProvisioned';
  payload: {
    tenantId: string;
    name: string;
    tier: TenantTier;
  };
}

export interface TenantActivated extends DomainEvent {
  type: 'TenantActivated';
  payload: {
    tenantId: string;
  };
}

export interface TenantSettingsUpdated extends DomainEvent {
  type: 'TenantSettingsUpdated';
  payload: {
    tenantId: string;
    settings: Record<string, unknown>;
  };
}
