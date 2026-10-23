/**
 * User Aggregate
 * Layer: Domain
 * 
 * Represents a user in the system.
 */

import { AggregateRoot } from '../../core/domain/AggregateRoot';
import { EntityId, Timestamp } from '../../core/types';
import { Result } from '../../core/result';
import { UserCreated, UserUpdated, UserRoleChanged } from './events';
import { z } from 'zod';

export enum UserRole {
  USER = 'user',
  ADMIN = 'admin',
  SYSTEM = 'system',
}

export enum UserStatus {
  ACTIVE = 'active',
  SUSPENDED = 'suspended',
  PENDING = 'pending',
}

interface UserProps {
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  tenantId: EntityId; // Reference to Tenant
  createdAt: Timestamp;
  updatedAt: Timestamp;
  lastLoginAt?: Timestamp;
  metadata?: Record<string, unknown>;
}

const UserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.nativeEnum(UserRole),
  status: z.nativeEnum(UserStatus),
  tenantId: z.instanceof(EntityId),
  createdAt: z.instanceof(Timestamp),
  updatedAt: z.instanceof(Timestamp),
  lastLoginAt: z.instanceof(Timestamp).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export class User extends AggregateRoot<UserProps> {
  private constructor(id: EntityId, props: UserProps) {
    super(id, props);
  }

  public static create(
    props: Omit<UserProps, 'createdAt' | 'updatedAt' | 'status'>,
    id?: EntityId
  ): Result<User> {
    const defaultProps = {
        ...props,
        status: UserStatus.ACTIVE,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
    };

    const validation = UserSchema.safeParse(defaultProps);
    if (!validation.success) {
        return Result.fail<User>(`Invalid User props: ${validation.error.message}`);
    }

    const user = new User(
      id ?? EntityId.random(),
      defaultProps
    );

    // DomainEvent: UserCreated
    const event: UserCreated = {
      ...user.createEvent('UserCreated', {
        userId: user.id.toValue(),
        email: user.props.email,
        role: user.props.role,
        tenantId: user.props.tenantId.toValue()
      }),
      type: 'UserCreated',
      payload: {
        userId: user.id.toValue(),
        email: user.props.email,
        role: user.props.role,
        tenantId: user.props.tenantId.toValue()
      }
    };
    user.addEvent(event);

    return Result.ok(user);
  }

  /**
   * Reconstitute User from persistence (Hydration).
   * Bypasses creation validation logic.
   */
  public static reconstitute(props: UserProps, id: EntityId): User {
    return new User(id, props);
  }

  // Getters
  get email(): string { return this.props.email; }
  get name(): string { return this.props.name; }
  get role(): UserRole { return this.props.role; }
  get status(): UserStatus { return this.props.status; }
  get tenantId(): EntityId { return this.props.tenantId; }
  get createdAt(): Timestamp { return this.props.createdAt; }
  get updatedAt(): Timestamp { return this.props.updatedAt; }
  get lastLoginAt(): Timestamp | undefined { return this.props.lastLoginAt; }
  get metadata(): Record<string, unknown> | undefined { return this.props.metadata; }

  public updateProfile(name: string): Result<void> {
    this.setProps({
      ...this.props,
      name,
      updatedAt: Timestamp.now()
    });
    
    const event: UserUpdated = {
        ...this.createEvent('UserUpdated', { userId: this.id.toValue(), changes: { name } }),
        type: 'UserUpdated',
        payload: { userId: this.id.toValue(), changes: { name } }
    };
    this.addEvent(event);
    
    return Result.ok();
  }
  
  public changeRole(newRole: UserRole): Result<void> {
      if (this.props.role === newRole) return Result.ok();
      
      this.setProps({
          ...this.props,
          role: newRole,
          updatedAt: Timestamp.now()
      });
      
      const event: UserRoleChanged = {
          ...this.createEvent('UserRoleChanged', { userId: this.id.toValue(), oldRole: this.props.role, newRole }),
          type: 'UserRoleChanged',
          payload: { userId: this.id.toValue(), oldRole: this.props.role, newRole }
      };
      this.addEvent(event);
      
      return Result.ok();
  }

  protected when(event: import('../../core/domain/AggregateRoot').DomainEvent): void {
      // Rehydrate logic for Event Sourcing if needed
      switch (event.type) {
          case 'UserCreated':
              // ...
              break;
          case 'UserUpdated':
              // ...
              break;
      }
  }
  
  public serialize(): Record<string, unknown> {
      return {
          id: this.id.toString(),
          ...this.props,
          tenantId: this.props.tenantId.toString()
      };
  }
}
