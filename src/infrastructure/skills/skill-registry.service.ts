/**
 * Skill Registry Service
 * Orchestrates loading of skills and registering them as Agent Tools.
 * Layer: Infrastructure
 */
import { injectable, inject } from 'inversify';
import { ILogger } from '../../core/decorators/ILogger';
import { ISkillLoader, Skill } from '../../domain/skills';
import { IToolRegistry, IAgentTool } from '../../domain/agents/tools.interface';
import { SkillToolAdapter } from './skill-tool-adapter';

export interface ISkillRegistry {
  initialize(): Promise<void>;
  listSkills(): Skill[];
  getSkill(id: string): Skill | undefined;
  reload(): Promise<void>;
}

@injectable()
export class SkillRegistryService implements ISkillRegistry {
  private skills: Map<string, Skill> = new Map();

  constructor(
    @inject('ISkillLoader') private skillLoader: ISkillLoader,
    @inject('IToolRegistry') private toolRegistry: IToolRegistry,
    @inject('ILogger') private logger: ILogger
  ) {}

  async initialize(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    try {
      this.logger.info('[SkillRegistry] Loading skills...');
      const skills = await this.skillLoader.loadSkills();
      
      this.skills.clear();
      let count = 0;

      for (const skill of skills) {
        this.skills.set(skill.id, skill);
        
        // Adapt to Tool
        const toolAdapter = new SkillToolAdapter(skill);
        
        // Register Tool
        this.toolRegistry.register(toolAdapter);
        count++;
      }
      
      this.logger.info(`[SkillRegistry] Loaded and registered ${count} skills as tools.`);
    } catch (error) {
      this.logger.error('[SkillRegistry] Failed to load skills', { error });
      throw error;
    }
  }

  listSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  getSkill(id: string): Skill | undefined {
    return this.skills.get(id);
  }
}
