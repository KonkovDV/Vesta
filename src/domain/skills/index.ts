/**
 * Skill Entity
 * Represents a capability loaded from the filesystem.
 * @layer Domain
 */
export interface Skill {
  /** Unique identifier (usually filename without extension) */
  id: string;
  /** Human readable name of the skill */
  name: string;
  /** Description of what the skill does */
  description: string;
  /** Version of the skill definition */
  version: string;
  /** Detailed instructions/prompt for the LLM */
  instructions: string;
  /** Path to the source file */
  sourcePath: string;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Skill Loader Port
 * Contract for loading skills from external sources.
 * @layer Domain
 */
export interface ISkillLoader {
  /**
   * Load all available skills.
   * @returns Promise resolving to an array of Skills.
   */
  loadSkills(): Promise<Skill[]>;

  /**
   * Get a specific skill by ID.
   * @param skillId The skill identifier.
   */
  getSkill(skillId: string): Promise<Skill | null>;
}
