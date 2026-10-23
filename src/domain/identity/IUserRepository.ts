import { User } from './User';
import { EntityId } from '../../core/types';
import { Result } from '../../core/result';

export interface IUserRepository {
  save(user: User): Promise<Result<void>>;
  findById(id: EntityId | string): Promise<Result<User>>;
  findByEmail(email: string): Promise<Result<User>>;
  exists(email: string): Promise<Result<boolean>>;
}
