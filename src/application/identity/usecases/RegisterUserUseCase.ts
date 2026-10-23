import { IUseCase } from '../../../core/application/UseCase';
import { Result } from '../../../core/result';
import { UserDTO, UserMapper } from '../dtos/UserDTO';
import { IUserRepository } from '../../../domain/identity/IUserRepository';
import { ITenantRepository } from '../../../domain/identity/ITenantRepository';
import { User, UserRole } from '../../../domain/identity/User';
import { EntityId } from '../../../core/types';

export interface RegisterUserRequest {
  email: string;
  name: string;
  tenantId: string;
  role?: UserRole;
}

export class RegisterUserUseCase implements IUseCase<RegisterUserRequest, UserDTO> {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly tenantRepository: ITenantRepository
  ) {}

  async execute(request: RegisterUserRequest): Promise<Result<UserDTO>> {
    // 1. Validate inputs (basic check)
    if (!request.email || !request.name || !request.tenantId) {
      return Result.fail<UserDTO>('Email, Name, and TenantId are required');
    }

    // 2. Check if tenant exists
    const tenantResult = await this.tenantRepository.findById(request.tenantId);
    if (tenantResult.isFailure) {
       return Result.fail<UserDTO>('Tenant not found: ' + String(tenantResult.error));
    }

    // 3. Check if user already exists
    const existingUser = await this.userRepository.findByEmail(request.email);
    if (existingUser.isSuccess) {
      return Result.fail<UserDTO>('User with this email already exists');
    }

    // 4. Create User Aggregate
    const userOrError = User.create({
      email: request.email,
      name: request.name,
      tenantId: EntityId.fromString(request.tenantId),
      role: request.role || UserRole.USER,
      // Metadata could be passed here if needed
    });

    if (userOrError.isFailure) {
      return Result.fail<UserDTO>(userOrError.error?.toString() || 'Failed to create user');
    }

    const user = userOrError.getValue();

    // 5. Save to Repository
    const saveResult = await this.userRepository.save(user);
    if (saveResult.isFailure) {
      return Result.fail<UserDTO>(saveResult.error?.toString() || 'Failed to save user');
    }

    // 6. Return DTO
    return Result.ok(UserMapper.toDTO(user));
  }
}
