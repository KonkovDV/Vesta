/**
 * IGenericRepository - Generic Repository Interface
 * Layer: Domain
 *
 * Provides a standardized contract for CRUD operations on entities.
 * This abstraction allows the Domain Layer to be agnostic of the underlying
 * database implementation (Postgres, MongoDB, InMemory, etc.).
 *
 * @template T - The entity type.
 */
export interface IGenericRepository<T> {
  /**
   * Find an entity by its ID.
   * @param id - The unique identifier of the entity.
   * @returns The entity if found, otherwise null.
   */
  findById(id: string): Promise<T | null>;

  /**
   * Find all entities matching a filter.
   * @param filter - Partial entity to match fields against (AND logic).
   * @returns Array of matching entities.
   */
  findAll(filter?: Partial<T>): Promise<T[]>;

  /**
   * Create a new entity.
   * @param entity - The entity to create.
   * @returns The created entity.
   */
  create(entity: T): Promise<T>;

  /**
   * Update an existing entity by ID.
   * @param id - The identifier of the entity to update.
   * @param entity - Partial data to update (only provided fields are changed).
   * @returns The updated entity.
   */
  update(id: string, entity: Partial<T>): Promise<T>;

  /**
   * Delete an entity by ID.
   * @param id - The identifier of the entity to delete.
   * @returns True if the entity was deleted, false if not found.
   */
  delete(id: string): Promise<boolean>;
}
