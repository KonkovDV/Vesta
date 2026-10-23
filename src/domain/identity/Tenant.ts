/**
 * Tenant Aggregate
 * Layer: Domain
 * 
 * Represents a tenant (organization/workspace) in the system.
 */

import { AggregateRoot } from '../../core/domain/AggregateRoot';
import { EntityId, Timestamp } from '../../core/types';
import { Result } from '../../core/result';
import { TenantProvisioned, TenantActivated, TenantSettingsUpdated } from './events';
import { z } from 'zod';

export enum TenantStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  PROVISIONING = 'provisioning',
}

export enum TenantTier {
  FREE = 'free',
  PRO = 'pro',
  ENTERPRISE = 'enterprise',
}

interface TenantProps {
  name: string;
  status: TenantStatus;
  tier: TenantTier;
  settings: Record<string, unknown>;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

const TenantSchema = z.object({
  name: z.string().min(1),
  status: z.nativeEnum(TenantStatus),
  tier: z.nativeEnum(TenantTier),
  settings: z.record(z.string(), z.unknown()),
  createdAt: z.instanceof(Timestamp),
  updatedAt: z.instanceof(Timestamp),
});

export class Tenant extends AggregateRoot<TenantProps> {
  private constructor(id: EntityId, props: TenantProps) {
    super(id, props);
  }

  public static create(
    props: Omit<TenantProps, 'createdAt' | 'updatedAt' | 'status'>,
    id?: EntityId
  ): Result<Tenant> {
    const defaultProps = {
        ...props,
        status: TenantStatus.PROVISIONING,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
    };

    const validation = TenantSchema.safeParse(defaultProps);
    if (!validation.success) {
        return Result.fail<Tenant>(`Invalid Tenant props: ${validation.error.message}`);
    }

    const tenant = new Tenant(
      id ?? EntityId.random(),
      defaultProps
    );

    // Domain Event: TenantProvisioned
    const event: TenantProvisioned = {
      ...tenant.createEvent('TenantProvisioned', {
        tenantId: tenant.id.toValue(),
        name: tenant.props.name,
        tier: tenant.props.tier
      }),
      type: 'TenantProvisioned',
      payload: {
        tenantId: tenant.id.toValue(),
        name: tenant.props.name,
        tier: tenant.props.tier
      }
    };
    tenant.addEvent(event);

    return Result.ok(tenant);
  }

  /**
   * Reconstitute Tenant from persistence (Hydration).
   * Bypasses creation validation logic.
   */
  public static reconstitute(props: TenantProps, id: EntityId): Tenant {
    return new Tenant(id, props);
  }

  // Getters
  get name(): string { return this.props.name; }
  get status(): TenantStatus { return this.props.status; }
  get tier(): TenantTier { return this.props.tier; }
  get settings(): Record<string, unknown> { return this.props.settings; }
  get createdAt(): Timestamp { return this.props.createdAt; }
  get updatedAt(): Timestamp { return this.props.updatedAt; }

  public activate(): void {
    if (this.props.status === TenantStatus.ACTIVE) return;
    
    this.setProps({
      ...this.props,
      status: TenantStatus.ACTIVE,
      updatedAt: Timestamp.now()
    });

    const event: TenantActivated = {
      ...this.createEvent('TenantActivated', { tenantId: this.id.toValue() }),
      type: 'TenantActivated',
      payload: { tenantId: this.id.toValue() }
    };
    this.addEvent(event);
  }

  public updateSettings(settings: Record<string, unknown>): Result<void> {
    this.setProps({
      ...this.props,
      settings: { ...this.props.settings, ...settings },
      updatedAt: Timestamp.now()
    });
    
    const event: TenantSettingsUpdated = {
      ...this.createEvent('TenantSettingsUpdated', { tenantId: this.id.toValue(), settings }),
      type: 'TenantSettingsUpdated',
      payload: { tenantId: this.id.toValue(), settings }
    };
    this.addEvent(event);
    
    return Result.ok();
  }

  protected when(event: import('../../core/domain/AggregateRoot').DomainEvent): void {
      // Rehydrate logic
  }

  public serialize(): Record<string, unknown> {
    return {
      id: this.id.toString(),
      ...this.props
    };
  }
}
