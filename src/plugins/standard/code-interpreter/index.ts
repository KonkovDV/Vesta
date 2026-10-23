import { IMicroPhoenixPlugin, IPluginContext, PluginManifest } from '../../../domain/plugins/microphoenix-plugin.port';
import { manifest } from './manifest';
import { z } from 'zod';
import * as vm from 'vm';

export default class CodeInterpreterPlugin implements IMicroPhoenixPlugin {
  readonly manifest: PluginManifest = manifest;

  async onLoad(context: IPluginContext): Promise<void> {
    context.logger.info?.(`CodeInterpreterPlugin: Loaded safe execution environment.`);

    // Register code_execute tool
    context.tools.register({
      name: 'code_execute',
      description: 'Execute JavaScript code in a safe sandbox. Returns result and logs.',
      schema: z.object({
        code: z.string().describe('JavaScript code to execute. access to process/require is disabled.')
      }),
      matches: (name) => name === 'code_execute',
      execute: async (args) => {
        const logs: string[] = [];
        
        // Prepare Sandbox Context
        const sandbox = {
          console: {
            log: (...args: any[]) => logs.push(args.map(a => String(a)).join(' ')),
            warn: (...args: any[]) => logs.push('WARN: ' + args.map(a => String(a)).join(' ')),
            error: (...args: any[]) => logs.push('ERROR: ' + args.map(a => String(a)).join(' ')),
          },
          // Whitelist safe globals or nullify dangerous ones
          setTimeout: setTimeout,
          clearTimeout: clearTimeout,
          process: null,
          require: null,
        };

        const vmContext = vm.createContext(sandbox);

        try {
          // Execute code in VM with timeout
          const result = vm.runInContext((args as { code: string }).code, vmContext, {
            timeout: 1000,
            displayErrors: true,
            lineOffset: 0
          });

          return JSON.stringify({
            result: result,
            logs: logs
          }, null, 2);

        } catch (error) {
          return JSON.stringify({
            error: (error as Error).message,
            logs: logs
          }, null, 2);
        }
      }
    });
  }

  async onUnload(): Promise<void> {
    // cleanup
  }
}
