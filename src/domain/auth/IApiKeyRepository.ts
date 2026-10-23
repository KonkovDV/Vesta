export interface StoredApiKey {
  id: string;
  prefix: string;
  hash: string;
  ownerId: string;
  tenantId?: string | null;
  scopes: readonly string[];
  expiresAt?: Date | null;
  createdAt: Date;
  revokedAt?: Date | null;
}

export interface CreateApiKeyParams {
  id: string;
  prefix: string;
  hash: string;
  ownerId: string;
  tenantId?: string | null;
  scopes?: readonly string[];
  expiresAt?: Date | null;
}

export interface IApiKeyRepository {
  create(params: CreateApiKeyParams): Promise<StoredApiKey>;
  findByPrefix(prefix: string): Promise<StoredApiKey | null>;
  findByOwnerId(ownerId: string): Promise<readonly StoredApiKey[]>;
  revokeById(id: string, revokedAt: Date): Promise<void>;
  revokeExpired(): Promise<number>;
}