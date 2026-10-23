/**
 * Directive Parser
 * Handles slash commands in user input to execute specific system actions bypassing the LLM.
 * Layer: Application
 */
import { injectable, inject } from 'inversify';
import { ILogger } from '../../core/decorators/ILogger';
import { HybridSearchService } from '../../domain/memory/services/hybrid-search.service';

export interface DirectiveResult {
  handled: boolean;
  content?: string;
}

@injectable()
export class DirectiveParser {
  constructor(
    @inject('HybridSearchService') private hybridSearch: HybridSearchService,
    @inject('ILogger') private logger: ILogger
  ) {}

  isDirective(text: string): boolean {
    return text.trim().startsWith('/');
  }

  async parseAndExecute(text: string, userId: string, tenantId: string = 'default'): Promise<DirectiveResult> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/')) {
      return { handled: false };
    }

    const parts = trimmed.slice(1).split(' ');
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    this.logger.info(`[DirectiveParser] Processing command: ${command}`, { args, userId });

    try {
      switch (command) {
        case 'mem':
        case 'memory':
          return await this.handleMemoryCommand(args, userId, tenantId);
        case 'help':
          return this.handleHelp();
        case 'ping':
          return { handled: true, content: 'Pong! System is online.' };
        default:
          return { handled: true, content: `Unknown command: /${command}. Type /help for available commands.` };
      }
    } catch (error) {
      this.logger.error(`[DirectiveParser] Command execution failed: ${command}`, { error });
      return { handled: true, content: `Error executing command /${command}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async handleMemoryCommand(args: string[], userId: string, tenantId: string): Promise<DirectiveResult> {
    const subCommand = args[0]?.toLowerCase();
    const query = args.slice(1).join(' ');

    if (subCommand === 'search' && query) {
      const results = await this.hybridSearch.search(tenantId, userId, query);
      if (results.length === 0) {
        return { handled: true, content: 'No memory results found.' };
      }
      
      const formatted = results.map((r, i) => 
        `[${i + 1}] (${r.sources.join('+')}) ${r.score.toFixed(3)}\n${r.content.substring(0, 200)}...`
      ).join('\n\n');
      
      return { handled: true, content: `**Memory Search Results for:** "${query}"\n\n${formatted}` };
    }

    return { handled: true, content: 'Usage: /mem search <query>' };
  }

  private handleHelp(): DirectiveResult {
    return {
      handled: true,
      content: `
**Available Commands:**
- \`/mem search <query>\`: Search long-term memory (Hybrid Vector + Keyword).
- \`/help\`: Show this help message.
- \`/ping\`: Check system responsiveness.
      `.trim()
    };
  }
}
