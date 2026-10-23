import { User } from '../../../domain/identity/User';
import { UserRole, UserStatus } from '../../../domain/identity/User';

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  status: UserStatus;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export class UserMapper {
  static toDTO(user: User): UserDTO {
    return {
      id: user.id.toValue(),
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      tenantId: user.tenantId.toValue(),
      createdAt: user.createdAt.toString(),
      updatedAt: user.updatedAt.toString(),
      lastLoginAt: user.lastLoginAt?.toString(),
    };
  }
}
