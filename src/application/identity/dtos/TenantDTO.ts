import { Tenant } from '../../../domain/identity/Tenant';
import { TenantStatus, TenantTier } from '../../../domain/identity/Tenant';

export interface TenantDTO {
  id: string;
  name: string;
  status: TenantStatus;
  tier: TenantTier;
  createdAt: string;
  updatedAt: string;
}

export class TenantMapper {
  static toDTO(tenant: Tenant): TenantDTO {
    return {
      id: tenant.id.toValue(),
      name: tenant.name,
      status: tenant.status,
      tier: tenant.tier,
      createdAt: tenant.createdAt.toString(),
      updatedAt: tenant.updatedAt.toString(),
    };
  }
}
