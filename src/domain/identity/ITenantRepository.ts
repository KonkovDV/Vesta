import { Tenant } from './Tenant';
import { EntityId } from '../../core/types';
import { Result } from '../../core/result';

export interface ITenantRepository {
  save(tenant: Tenant): Promise<Result<void>>;
  delete(id: EntityId | string): Promise<Result<void>>;
  findById(id: EntityId | string): Promise<Result<Tenant>>;
  findByName(name: string): Promise<Result<Tenant>>;
}
