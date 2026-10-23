import { IUseCase } from '../../../core/application/UseCase';
import { Result } from '../../../core/result';
import { TenantDTO, TenantMapper } from '../dtos/TenantDTO';
import { ITenantRepository } from '../../../domain/identity/ITenantRepository';
import { IUserRepository } from '../../../domain/identity/IUserRepository';
import { Tenant, TenantTier } from '../../../domain/identity/Tenant';
import { User, UserRole } from '../../../domain/identity/User';
import { EntityId } from '../../../core/types';

export interface ProvisionTenantRequest {
  name: string;
  tier: TenantTier;
  adminEmail: string;
  adminName: string;
  settings?: Record<string, unknown>;
}

export class ProvisionTenantUseCase implements IUseCase<ProvisionTenantRequest, TenantDTO> {
  constructor(
    private readonly tenantRepository: ITenantRepository,
    private readonly userRepository: IUserRepository
  ) {}

  async execute(request: ProvisionTenantRequest): Promise<Result<TenantDTO>> {
    // 1. Validate inputs
    if (!request.name || !request.adminEmail || !request.adminName) {
      return Result.fail<TenantDTO>('Tenant Name, Admin Email, and Admin Name are required');
    }

    // 2. Check if tenant name is taken (optional, depending on requirements)
    const existingTenant = await this.tenantRepository.findByName(request.name);
    if (existingTenant.isSuccess) {
      return Result.fail<TenantDTO>('Tenant with this name already exists');
    }

    // 3. Create Tenant Aggregate
    const tenantOrError = Tenant.create({
      name: request.name,
      tier: request.tier,
      settings: request.settings || {}
    });

    if (tenantOrError.isFailure) {
      return Result.fail<TenantDTO>(tenantOrError.error?.toString() || 'Failed to create tenant');
    }

    const tenant = tenantOrError.getValue();

    // 4. Create Admin User for this Tenant
    // Note: We create the user *after* we know the tenant object is valid, 
    // but before saving the tenant to ensure we can create both or fail.
    // In a real DB, this would be a transaction.
    
    // Check if admin email exists globally (optional, users might belong to multiple tenants in future, 
    // but for now, email is unique system-wide)
    const existingUser = await this.userRepository.findByEmail(request.adminEmail);
    if (existingUser.isSuccess) {
         return Result.fail<TenantDTO>('Admin user with this email already exists');
    }

    const adminUserOrError = User.create({
        email: request.adminEmail,
        name: request.adminName,
        tenantId: tenant.id,
        role: UserRole.ADMIN
    });

    if (adminUserOrError.isFailure) {
        return Result.fail<TenantDTO>(adminUserOrError.error?.toString() || 'Failed to create admin user');
    }

    const adminUser = adminUserOrError.getValue();

    // 5. Save both (Transactional Logic needed in Infrastructure, meant here as logical steps)
    const saveTenantResult = await this.tenantRepository.save(tenant);
    if (saveTenantResult.isFailure) {
        return Result.fail<TenantDTO>(saveTenantResult.error?.toString() || 'Failed to save tenant');
    }

    const saveUserResult = await this.userRepository.save(adminUser);
    if (saveUserResult.isFailure) {
        const rollbackResult = await this.tenantRepository.delete(tenant.id);
        if (rollbackResult.isFailure) {
          return Result.fail<TenantDTO>(
            `${saveUserResult.error?.toString() || 'Failed to save admin user'}; rollback failed: ${rollbackResult.error?.toString() || 'Failed to delete tenant'}`,
          );
        }

        return Result.fail<TenantDTO>(saveUserResult.error?.toString() || 'Failed to save admin user');
    }

    // 6. Return Tenant DTO
    return Result.ok(TenantMapper.toDTO(tenant));
  }
}
