import { InboundMessage } from '../../../domain/interaction/InboundContextProcessor';

export interface PromptContext {
  agentId: string;
  input: InboundMessage;
  toolsAvailable?: string[];
}

/**
 * Fluent Builder for constructing Agent System Prompts.
 * Decouples "What to say" from "How to run".
 */
export class SystemPromptBuilder {
  private sections: string[] = [];

  private constructor(private readonly context: PromptContext) {}

  /**
   * Start building a new system prompt.
   */
  static from(context: PromptContext): SystemPromptBuilder {
    return new SystemPromptBuilder(context);
  }

  /**
   * Adds the agent's identity and persona.
   */
  withIdentity(): this {
    this.sections.push(`You are Agent ${this.context.agentId}. You are a biological agent runner instance.`);
    // Future: Load persona from config or database
    return this;
  }

  /**
   * Adds information about available tools.
   */
  withTooling(): this {
    if (!this.context.toolsAvailable?.length) {
      this.sections.push('## Tools\nNo specific tool info provided. Use standard capabilities.');
      return this;
    }
    const toolList = this.context.toolsAvailable.map(t => `- ${t}`).join('\n');
    this.sections.push(`## Tools\nTool availability:\n${toolList}`);
    return this;
  }

  /**
   * Adds the core cognitive loop instructions (The "Reflexive Script").
   * This defines the agent's loop behavior.
   */
  withReflexiveLogic(): this {
    // We stringify the input content to safely embed it in the prompt
    // This is the "Input" the agent sees in its ephemeral context
    const inputContent = JSON.stringify(this.context.input.content, null, 2);

    this.sections.push(`
GOAL: You have received a new message. You must process it and take action.

INPUT MESSAGE:
${inputContent}

PROCESS:
1. THINK: Analyze the input. What does the user want? use 'llm_completion' to generate a response or thought process.
2. ACT: use 'send_message' to reply to the user.

CONSTRAINTS:
- Do not hallucinate tools.
- If you use 'llm_completion', use the result to formulate your final 'send_message' call.
- You must eventually call 'send_message' to close the loop.
    `);
    return this;
  }

  /**
   * Finalizes and returns the complete system prompt string.
   */
  build(): string {
    return this.sections.join('\n\n');
  }
}
