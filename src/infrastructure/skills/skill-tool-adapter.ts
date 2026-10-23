/**
 * SkillToolAdapter
 * Bridges the gap between passive Skill definitions and executable Agent Tools.
 * Layer: Infrastructure
 */
import { z } from 'zod';
import { IAgentTool } from '../../domain/agents/tools.interface';
import { IAgentContext } from '../../domain/agents/agent-context.interface';
import { Skill } from '../../domain/skills';

export class SkillToolAdapter implements IAgentTool {
  public readonly name: string;
  public readonly description: string;
  public readonly schema: z.ZodType<unknown>;

  constructor(private readonly skill: Skill) {
    // Normalize skill ID to tool name format (e.g. "skill-python_expert")
    // Or just use skill.id if it's clean.
    this.name = `skill-${skill.id}`; 
    this.description = `Activate Skill: ${skill.name}. ${skill.description}`;
    
    // Schema: explicit 'activate' flag or empty object?
    // Using simple enablement schema.
    this.schema = z.object({
      intent: z.string().describe('Reason for activating this skill'),
    });
  }

  matches(name: string): boolean {
    return this.name === name;
  }

  async execute(args: unknown, context: IAgentContext): Promise<{ content: string }> {
    // Activation Logic:
    // 1. Return the instructions so the Agent can ingest them.
    // 2. Optionally, the System could handle this "Tool Result" specially (e.g. updating System Prompt).
    // For now, returning it as text is the most compatible way for an LLM to "learn" the skill.
    
    const content = `
=== SKILL ACTIVATED: ${this.skill.name} ===
${this.skill.instructions}
==========================================
    `.trim();

    return { content };
  }
}
