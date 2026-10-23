/**
 * End an agent run with a final message.
 * Layer: Application
 */

import { z } from 'zod';
import type { IAgentContext } from '../../../domain/agents/agent-context.interface';
import type { IAgentTool } from '../../../domain/agents/tools.interface';

export const FinishToolSchema = z.object({
  message: z.string().min(1).max(8_000),
}).strict();

export class FinishTool implements IAgentTool {
  readonly name = 'finish';
  readonly description = 'Finish the run and return the final message to the caller.';
  readonly schema = FinishToolSchema;

  matches(name: string): boolean {
    return name.toLowerCase() === this.name;
  }

  async execute(args: unknown, _context: IAgentContext): Promise<unknown> {
    const input = FinishToolSchema.parse(args);
    return { finished: true, message: input.message };
  }
}
